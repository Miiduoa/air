const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();

// 靜態文件服務
app.use(express.static('public'));

// LINE Bot設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 空氣品質API設定 - 使用環境變數
const WAQI_TOKEN = process.env.WAQI_TOKEN || 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// 創建LINE Bot客戶端
const client = new line.Client(config);

// 數據存儲（生產環境建議使用資料庫）
let subscriptions = new Map(); // userId -> {cities: [], settings: {}}
let locationCache = new Map(); // userId -> {lat, lng, timestamp}
let userStates = new Map(); // userId -> {state: '', context: {}, timestamp}
let apiCache = new Map(); // city -> {data, timestamp}

// 快取過期時間（15分鐘）
const CACHE_DURATION = 15 * 60 * 1000;

// 城市對應表（修正和完善）
const cityMap = {
  // 台灣城市
  '台北': 'taipei',
  '台中': 'taichung', 
  '台南': 'tainan',
  '高雄': 'kaohsiung',
  '新北': 'new-taipei',
  '桃園': 'taoyuan',
  '基隆': 'keelung',
  '新竹': 'hsinchu',
  '苗栗': 'miaoli',
  '彰化': 'changhua',
  '南投': 'nantou',
  '雲林': 'yunlin',
  '嘉義': 'chiayi',
  '屏東': 'pingtung',
  '宜蘭': 'yilan',
  '花蓮': 'hualien',
  '台東': 'taitung',
  '澎湖': 'penghu',
  '金門': 'kinmen',
  '馬祖': 'matsu',
  // 國際城市
  '北京': 'beijing',
  '上海': 'shanghai',
  '東京': 'tokyo',
  '首爾': 'seoul',
  '曼谷': 'bangkok',
  '新加坡': 'singapore',
  '香港': 'hong-kong',
  '澳門': 'macau',
  '倫敦': 'london',
  '巴黎': 'paris',
  '紐約': 'new-york',
  '洛杉磯': 'los-angeles',
  '雪梨': 'sydney',
  '墨爾本': 'melbourne'
};

// 工具函數：安全的數字轉換
function safeNumber(value, defaultValue = 0) {
  const num = parseInt(value);
  return isNaN(num) ? defaultValue : num;
}

// 工具函數：安全的字串處理
function safeString(value, defaultValue = '') {
  return (value && typeof value === 'string') ? value : defaultValue;
}

// 工具函數：計算兩點間距離
function calculateDistance(lat1, lon1, lat2, lon2) {
  try {
    const R = 6371; // 地球半徑（公里）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  } catch (error) {
    console.error('計算距離錯誤:', error);
    return 0;
  }
}

// 用戶狀態管理（完善版）
function setUserState(userId, state, context = {}) {
  if (!userId || !state) return false;
  
  userStates.set(userId, { 
    state, 
    context: context || {}, 
    timestamp: Date.now() 
  });
  return true;
}

function getUserState(userId) {
  if (!userId) return null;
  
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < 300000) { // 5分鐘有效
    return userState;
  }
  
  // 自動清理過期狀態
  userStates.delete(userId);
  return null;
}

function clearUserState(userId) {
  if (!userId) return false;
  return userStates.delete(userId);
}

// 訂閱管理（完善版）
function addSubscription(userId, city) {
  if (!userId || !city) return false;
  
  if (!subscriptions.has(userId)) {
    subscriptions.set(userId, {
      cities: [],
      settings: {
        dailyReport: true,
        emergencyAlert: true,
        threshold: 100
      }
    });
  }
  
  const userSub = subscriptions.get(userId);
  if (!userSub.cities.includes(city)) {
    userSub.cities.push(city);
    console.log(`用戶 ${userId} 訂閱了 ${city}`);
    return true;
  }
  return false;
}

function removeSubscription(userId, city) {
  if (!userId || !city || !subscriptions.has(userId)) return false;
  
  const userSub = subscriptions.get(userId);
  const index = userSub.cities.indexOf(city);
  if (index > -1) {
    userSub.cities.splice(index, 1);
    console.log(`用戶 ${userId} 取消訂閱了 ${city}`);
    return true;
  }
  return false;
}

function removeAllSubscriptions(userId) {
  if (!userId) return false;
  
  if (subscriptions.has(userId)) {
    subscriptions.delete(userId);
    console.log(`清除用戶 ${userId} 的所有訂閱`);
    return true;
  }
  return false;
}

function getUserSubscriptions(userId) {
  if (!userId) return { cities: [], settings: {} };
  
  return subscriptions.get(userId) || { 
    cities: [], 
    settings: {
      dailyReport: true,
      emergencyAlert: true,
      threshold: 100
    }
  };
}

function updateUserSettings(userId, settings) {
  if (!userId || !settings) return null;
  
  if (!subscriptions.has(userId)) {
    subscriptions.set(userId, {
      cities: [],
      settings: {
        dailyReport: true,
        emergencyAlert: true,
        threshold: 100
      }
    });
  }
  
  const userSub = subscriptions.get(userId);
  userSub.settings = { ...userSub.settings, ...settings };
  console.log(`更新用戶 ${userId} 設定:`, settings);
  return userSub.settings;
}

// AQI等級判斷（完善版）
function getAQILevel(aqi) {
  const numAqi = safeNumber(aqi);
  
  if (numAqi <= 50) return { level: '良好', color: '#00e400', emoji: '😊', bgColor: '#e8f5e8' };
  if (numAqi <= 100) return { level: '普通', color: '#ffff00', emoji: '😐', bgColor: '#fffbe8' };
  if (numAqi <= 150) return { level: '對敏感族群不健康', color: '#ff7e00', emoji: '😷', bgColor: '#fff4e8' };
  if (numAqi <= 200) return { level: '不健康', color: '#ff0000', emoji: '😰', bgColor: '#ffe8e8' };
  if (numAqi <= 300) return { level: '非常不健康', color: '#8f3f97', emoji: '🤢', bgColor: '#f4e8f4' };
  return { level: '危險', color: '#7e0023', emoji: '☠️', bgColor: '#f0e8e8' };
}

// 健康建議系統（完善版）
function getHealthAdvice(aqi) {
  const numAqi = safeNumber(aqi);
  
  if (numAqi <= 50) {
    return {
      general: '空氣品質極佳！適合所有戶外活動',
      sensitive: '敏感族群也可正常戶外活動',
      exercise: '🏃‍♂️ 極適合：跑步、騎車、登山等高強度運動',
      mask: '😊 無需配戴口罩',
      indoor: '🪟 可開窗通風，享受新鮮空氣',
      children: '👶 兒童可安全進行戶外活動',
      elderly: '👴 年長者可正常戶外活動',
      color: '#00e400'
    };
  } else if (numAqi <= 100) {
    return {
      general: '空氣品質可接受，一般人群可正常活動',
      sensitive: '⚠️ 敏感族群請減少長時間戶外劇烈運動',
      exercise: '🚶‍♂️ 適合：散步、瑜伽、輕度慢跑',
      mask: '😷 建議配戴一般口罩',
      indoor: '🪟 可適度開窗，保持空氣流通',
      children: '👶 兒童可戶外活動，但避免劇烈運動',
      elderly: '👴 年長者建議減少戶外時間',
      color: '#ffff00'
    };
  } else if (numAqi <= 150) {
    return {
      general: '對敏感族群不健康，一般人群減少戶外活動',
      sensitive: '🚨 敏感族群應避免戶外活動',
      exercise: '🏠 建議室內運動：瑜伽、伸展、重訓',
      mask: '😷 必須配戴N95或醫用口罩',
      indoor: '🚪 關閉門窗，使用空氣清淨機',
      children: '👶 兒童應留在室內',
      elderly: '👴 年長者避免外出',
      color: '#ff7e00'
    };
  } else if (numAqi <= 200) {
    return {
      general: '所有人群都應減少戶外活動',
      sensitive: '🚫 敏感族群請留在室內',
      exercise: '🏠 僅建議室內輕度活動',
      mask: '😷 外出必須配戴N95口罩',
      indoor: '🚪 緊閉門窗，持續使用空氣清淨機',
      children: '👶 兒童必須留在室內',
      elderly: '👴 年長者請避免外出',
      color: '#ff0000'
    };
  } else if (numAqi <= 300) {
    return {
      general: '所有人群避免戶外活動',
      sensitive: '🏠 所有人應留在室內',
      exercise: '🚫 避免任何戶外運動',
      mask: '😷 外出務必配戴N95或更高等級口罩',
      indoor: '🚪 緊閉門窗，使用高效空氣清淨機',
      children: '👶 兒童絕對不可外出',
      elderly: '👴 年長者需特別防護',
      color: '#8f3f97'
    };
  } else {
    return {
      general: '⚠️ 緊急狀況！所有人應留在室內',
      sensitive: '🚨 立即尋求室內避難場所',
      exercise: '🚫 禁止所有戶外活動',
      mask: '😷 外出必須配戴專業防護口罩',
      indoor: '🚪 密閉室內，使用高效空氣清淨設備',
      children: '👶 兒童需緊急防護',
      elderly: '👴 年長者需立即醫療關注',
      color: '#7e0023'
    };
  }
}

// 空氣品質數據獲取（完善版，加入快取）
async function getAirQuality(city) {
  try {
    // 檢查快取
    const cachedData = apiCache.get(city);
    if (cachedData && Date.now() - cachedData.timestamp < CACHE_DURATION) {
      console.log(`使用快取數據: ${city}`);
      return cachedData.data;
    }

    console.log(`從API獲取數據: ${city}`);
    const url = `${WAQI_BASE_URL}/feed/${city}/?token=${WAQI_TOKEN}`;
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data.status === 'ok' && response.data.data) {
      const data = response.data.data;
      
      // 數據驗證和清理
      const cleanData = {
        ...data,
        aqi: safeNumber(data.aqi),
        city: {
          name: safeString(data.city?.name, city),
          geo: data.city?.geo || [0, 0],
          url: safeString(data.city?.url)
        },
        dominentpol: safeString(data.dominentpol),
        iaqi: data.iaqi || {},
        time: data.time || { s: new Date().toISOString() }
      };
      
      // 存入快取
      apiCache.set(city, {
        data: cleanData,
        timestamp: Date.now()
      });
      
      return cleanData;
    } else {
      throw new Error(`API返回錯誤狀態: ${response.data.status}`);
    }
  } catch (error) {
    console.error(`獲取 ${city} 空氣品質數據錯誤:`, error.message);
    
    // 嘗試返回快取數據（即使過期）
    const oldCache = apiCache.get(city);
    if (oldCache) {
      console.log(`使用過期快取數據: ${city}`);
      return oldCache.data;
    }
    
    throw new Error(`無法獲取 ${city} 的空氣品質數據: ${error.message}`);
  }
}

// 多城市數據獲取（完善版）
async function getMultipleCitiesAirQuality(cities) {
  const promises = cities.map(async (cityInfo) => {
    try {
      const data = await getAirQuality(cityInfo.english);
      return {
        ...data,
        chineseName: cityInfo.chinese,
        englishName: cityInfo.english
      };
    } catch (error) {
      console.error(`獲取${cityInfo.chinese}空氣品質失敗:`, error.message);
      return null;
    }
  });
  
  const results = await Promise.all(promises);
  return results.filter(result => result !== null);
}

// 附近監測站查找（完善版）
async function findNearbyStations(lat, lng) {
  try {
    const numLat = parseFloat(lat);
    const numLng = parseFloat(lng);
    
    if (isNaN(numLat) || isNaN(numLng)) {
      throw new Error('無效的座標');
    }

    const url = `${WAQI_BASE_URL}/search/?token=${WAQI_TOKEN}&keyword=geo:${numLat};${numLng}`;
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data.status === 'ok' && response.data.data.length > 0) {
      const stationsWithDistance = response.data.data
        .filter(station => station.geo && station.geo.length === 2 && station.aqi)
        .map(station => {
          const distance = calculateDistance(numLat, numLng, station.geo[0], station.geo[1]);
          return {
            ...station,
            distance: distance,
            aqi: safeNumber(station.aqi)
          };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5); // 取前5個最近的站點
      
      return stationsWithDistance;
    }
    return [];
  } catch (error) {
    console.error('查找附近監測站錯誤:', error.message);
    return [];
  }
}

// 自然語言解析（完善版）
function parseQuery(text) {
  if (!text || typeof text !== 'string') return null;
  
  const cleanText = text.toLowerCase().trim();
  
  // 移除常見的查詢詞彙
  const queryTerms = /空氣品質|空氣|空品|pm2\.5|aqi|查詢|怎麼樣|如何|的/g;
  const processedText = cleanText.replace(queryTerms, ' ').trim();
  
  // 處理問候語和主選單
  if (cleanText.match(/^(你好|哈囉|hello|hi|主選單|menu|開始|start)$/i)) {
    return { type: 'greeting' };
  }
  
  // 處理幫助指令
  if (cleanText.match(/^(幫助|help|使用說明|教學|說明)$/i)) {
    return { type: 'help' };
  }
  
  // 處理設定相關
  if (cleanText.includes('設定') || cleanText.includes('settings')) {
    return { type: 'settings' };
  }
  
  // 處理訂閱相關指令
  if (cleanText.includes('訂閱') && !cleanText.includes('取消') && !cleanText.includes('清除')) {
    return parseSubscribeQuery(text);
  }
  
  if (cleanText.includes('取消訂閱') || cleanText.includes('unsubscribe')) {
    return parseUnsubscribeQuery(text);
  }
  
  if (cleanText.includes('我的訂閱') || cleanText.includes('訂閱清單') || cleanText.includes('訂閱管理')) {
    return { type: 'list_subscriptions' };
  }
  
  if (cleanText.includes('清除') && cleanText.includes('訂閱')) {
    return { type: 'clear_subscriptions' };
  }
  
  // 處理比較查詢
  if (cleanText.includes('比較') || cleanText.includes('vs') || cleanText.includes('對比')) {
    return parseCompareQuery(text);
  }
  
  // 處理單一城市查詢
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (cleanText.includes(chinese.toLowerCase()) || processedText.includes(english.toLowerCase())) {
      return { type: 'single', city: english, cityName: chinese };
    }
  }
  
  return null;
}

function parseSubscribeQuery(text) {
  const cities = [];
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      cities.push({ chinese, english });
    }
  }
  
  if (cities.length === 1) {
    return { type: 'subscribe', city: cities[0].english, cityName: cities[0].chinese };
  } else if (cities.length > 1) {
    return { type: 'subscribe_multiple', cities };
  }
  
  return { type: 'subscribe', city: null };
}

function parseUnsubscribeQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { type: 'unsubscribe', city: english, cityName: chinese };
    }
  }
  return { type: 'unsubscribe', city: null };
}

function parseCompareQuery(text) {
  const cities = [];
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      cities.push({ chinese, english });
    }
  }
  
  if (cities.length >= 2) {
    return { type: 'compare', cities: cities.slice(0, 5) }; // 最多比較5個城市
  }
  
  return null;
}

// Flex Message 創建函數們（保持原有但修正格式問題）

// 創建主選單Flex Message（完善版）
function createMainMenuFlexMessage() {
  return {
    type: 'flex',
    altText: '主選單 - 智慧空氣品質機器人',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🌬️ 智慧空氣品質機器人',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          },
          {
            type: 'text',
            text: '請選擇您需要的功能',
            color: '#ffffff',
            size: 'sm',
            align: 'center',
            margin: 'sm'
          }
        ],
        backgroundColor: '#4CAF50',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#42a5f5',
                action: {
                  type: 'message',
                  label: '🔍 查詢空氣品質',
                  text: '查詢空氣品質'
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'primary',
                color: '#ff7e00',
                action: {
                  type: 'message',
                  label: '📊 比較城市',
                  text: '比較城市'
                },
                flex: 1
              }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#8f3f97',
                action: {
                  type: 'message',
                  label: '🔔 訂閱提醒',
                  text: '訂閱提醒'
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'primary',
                color: '#00e400',
                action: {
                  type: 'message',
                  label: '📍 附近查詢',
                  text: '附近查詢'
                },
                flex: 1
              }
            ]
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '⚙️ 我的設定',
              text: '我的設定'
            }
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'separator'
          },
          {
            type: 'text',
            text: '💡 直接輸入城市名稱也可快速查詢',
            color: '#aaaaaa',
            size: 'xs',
            align: 'center',
            margin: 'sm'
          }
        ]
      }
    }
  };
}

// 創建空氣品質Flex Message（完善版）
function createAirQualityFlexMessage(data) {
  const aqiInfo = getAQILevel(data.aqi);
  const healthAdvice = getHealthAdvice(data.aqi);
  
  let updateTime = '未知';
  try {
    if (data.time && data.time.iso) {
      updateTime = new Date(data.time.iso).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } else if (data.time && data.time.s) {
      updateTime = new Date(data.time.s).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  } catch (error) {
    console.error('時間格式轉換錯誤:', error);
  }

  const flexMessage = {
    type: 'flex',
    altText: `${data.city.name} 空氣品質 AQI: ${data.aqi} (${aqiInfo.level})`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${aqiInfo.emoji} ${data.city.name}`,
            weight: 'bold',
            color: '#ffffff',
            size: 'xl',
            align: 'center'
          },
          {
            type: 'text',
            text: '空氣品質報告',
            color: '#ffffff',
            size: 'sm',
            align: 'center'
          }
        ],
        backgroundColor: aqiInfo.color,
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '💨 AQI指數',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 3
                  },
                  {
                    type: 'text',
                    text: data.aqi.toString(),
                    color: aqiInfo.color,
                    size: 'xl',
                    weight: 'bold',
                    flex: 2,
                    align: 'end'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '📊 等級',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 3
                  },
                  {
                    type: 'text',
                    text: aqiInfo.level,
                    color: '#666666',
                    size: 'sm',
                    flex: 2,
                    align: 'end',
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: '🌍 主要污染物',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 3
                  },
                  {
                    type: 'text',
                    text: data.dominentpol || '未知',
                    color: '#666666',
                    size: 'sm',
                    flex: 2,
                    align: 'end'
                  }
                ]
              }
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '🏥 健康建議',
            weight: 'bold',
            size: 'md',
            margin: 'lg',
            color: '#333333'
          },
          {
            type: 'text',
            text: healthAdvice.general,
            wrap: true,
            color: '#666666',
            size: 'sm',
            margin: 'sm'
          },
          {
            type: 'text',
            text: healthAdvice.mask,
            wrap: true,
            color: '#666666',
            size: 'sm',
            margin: 'xs'
          },
          {
            type: 'text',
            text: healthAdvice.exercise,
            wrap: true,
            color: '#666666',
            size: 'sm',
            margin: 'xs'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'separator'
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            margin: 'sm',
            contents: [
              {
                type: 'button',
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '🔔 訂閱',
                  text: `訂閱${data.chineseName || data.city.name}`
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '🆚 比較',
                  text: '比較城市'
                },
                flex: 1
              }
            ]
          },
          {
            type: 'text',
            text: `更新時間: ${updateTime}`,
            color: '#aaaaaa',
            size: 'xs',
            align: 'center',
            margin: 'sm'
          }
        ]
      }
    }
  };

  // 添加詳細污染物數據
  if (data.iaqi && Object.keys(data.iaqi).length > 0) {
    const pollutants = [
      { key: 'pm25', name: 'PM2.5', unit: 'μg/m³' },
      { key: 'pm10', name: 'PM10', unit: 'μg/m³' },
      { key: 'o3', name: '臭氧', unit: 'ppb' },
      { key: 'no2', name: '二氧化氮', unit: 'ppb' },
      { key: 'so2', name: '二氧化硫', unit: 'ppb' },
      { key: 'co', name: '一氧化碳', unit: 'mg/m³' }
    ];

    const detailContents = [];
    pollutants.forEach(pollutant => {
      if (data.iaqi[pollutant.key] && data.iaqi[pollutant.key].v) {
        detailContents.push({
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: pollutant.name,
              color: '#aaaaaa',
              size: 'sm',
              flex: 3
            },
            {
              type: 'text',
              text: `${data.iaqi[pollutant.key].v} ${pollutant.unit}`,
              color: '#666666',
              size: 'sm',
              flex: 2,
              align: 'end'
            }
          ]
        });
      }
    });

    if (detailContents.length > 0) {
      flexMessage.contents.body.contents.push(
        {
          type: 'separator',
          margin: 'lg'
        },
        {
          type: 'text',
          text: '📊 詳細數據',
          weight: 'bold',
          size: 'md',
          margin: 'lg',
          color: '#333333'
        },
        ...detailContents
      );
    }
  }

  return flexMessage;
}

// 創建多城市比較Flex Message（完善版）
function createCityComparisonFlexMessage(citiesData) {
  if (!citiesData || citiesData.length === 0) {
    return createErrorFlexMessage('api_error', '無法獲取城市比較數據');
  }

  // 按AQI排序
  const sortedCities = citiesData.sort((a, b) => a.aqi - b.aqi);
  const bestCity = sortedCities[0];
  const worstCity = sortedCities[sortedCities.length - 1];
  const bestAqiInfo = getAQILevel(bestCity.aqi);
  
  const flexMessage = {
    type: 'flex',
    altText: `多城市比較 - 最佳: ${bestCity.chineseName} AQI: ${bestCity.aqi}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🏆 多城市空氣品質比較',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          },
          {
            type: 'text',
            text: `共比較 ${sortedCities.length} 個城市`,
            color: '#ffffff',
            size: 'sm',
            align: 'center',
            margin: 'sm'
          }
        ],
        backgroundColor: '#4CAF50',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📊 排名結果（由佳至差）',
            weight: 'bold',
            size: 'md',
            margin: 'lg',
            color: '#333333'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'separator'
          },
          {
            type: 'button',
            style: 'primary',
            color: '#4CAF50',
            action: {
              type: 'message',
              label: `查看 ${bestCity.chineseName} 詳細資訊`,
              text: `${bestCity.chineseName}空氣品質`
            },
            margin: 'sm'
          }
        ]
      }
    }
  };

  // 排名圖標
  const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  // 為每個城市添加排名資訊
  sortedCities.forEach((city, index) => {
    const aqiInfo = getAQILevel(city.aqi);
    const rankEmoji = rankEmojis[index] || `${index + 1}️⃣`;
    
    flexMessage.contents.body.contents.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      margin: 'md',
      contents: [
        {
          type: 'text',
          text: rankEmoji,
          size: 'lg',
          flex: 1,
          align: 'center'
        },
        {
          type: 'box',
          layout: 'vertical',
          flex: 4,
          contents: [
            {
              type: 'text',
              text: city.chineseName || city.city.name,
              weight: 'bold',
              size: 'md',
              color: '#333333'
            },
            {
              type: 'text',
              text: city.city.name,
              size: 'xs',
              color: '#999999'
            }
          ]
        },
        {
          type: 'box',
          layout: 'vertical',
          flex: 3,
          contents: [
            {
              type: 'text',
              text: `AQI ${city.aqi}`,
              weight: 'bold',
              size: 'md',
              color: aqiInfo.color,
              align: 'end'
            },
            {
              type: 'text',
              text: aqiInfo.level,
              size: 'xs',
              color: '#666666',
              align: 'end',
              wrap: true
            }
          ]
        }
      ]
    });
    
    // 添加分隔線（除了最後一個）
    if (index < sortedCities.length - 1) {
      flexMessage.contents.body.contents.push({
        type: 'separator',
        margin: 'md'
      });
    }
  });

  // 添加建議
  const avgAqi = Math.round(sortedCities.reduce((sum, city) => sum + city.aqi, 0) / sortedCities.length);
  const recommendation = bestCity.aqi <= 100 ? 
    `✈️ 推薦前往 ${bestCity.chineseName}！空氣品質${bestAqiInfo.level}` :
    `⚠️ 所有城市都需注意防護，${bestCity.chineseName} 相對最佳`;

  flexMessage.contents.body.contents.push(
    {
      type: 'separator',
      margin: 'lg'
    },
    {
      type: 'text',
      text: '🎯 旅行建議',
      weight: 'bold',
      size: 'md',
      margin: 'lg',
      color: '#333333'
    },
    {
      type: 'text',
      text: recommendation,
      wrap: true,
      color: '#666666',
      size: 'sm',
      margin: 'sm'
    },
    {
      type: 'text',
      text: `平均AQI: ${avgAqi}`,
      size: 'xs',
      color: '#999999',
      margin: 'sm'
    }
  );

  return flexMessage;
}

// 其他必要的 Flex Message 創建函數（保持簡潔但功能完整）
function createErrorFlexMessage(errorType, message) {
  const errorConfig = {
    'not_found': { emoji: '🤔', title: '無法識別', color: '#ff7e00' },
    'api_error': { emoji: '😵', title: '查詢錯誤', color: '#ff0000' },
    'network_error': { emoji: '🌐', title: '網路錯誤', color: '#ff0000' }
  };

  const config = errorConfig[errorType] || errorConfig['api_error'];

  return {
    type: 'flex',
    altText: `錯誤 - ${config.title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${config.emoji} ${config.title}`,
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: config.color,
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: message,
            color: '#666666',
            align: 'center',
            wrap: true,
            margin: 'lg'
          },
          {
            type: 'text',
            text: '💡 建議嘗試：',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '• 重新輸入查詢\n• 使用主選單功能\n• 嘗試其他城市名稱',
            size: 'sm',
            color: '#666666',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'separator'
          },
          {
            type: 'button',
            style: 'primary',
            color: '#4CAF50',
            action: {
              type: 'message',
              label: '↩️ 回到主選單',
              text: '主選單'
            },
            margin: 'sm'
          }
        ]
      }
    }
  };
}

// 其他 Flex Message 函數（完善版但簡化）
function createWelcomeFlexMessage() {
  return {
    type: 'flex',
    altText: '歡迎使用智慧空氣品質機器人',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '🌟 歡迎使用智慧空氣品質機器人！',
            weight: 'bold',
            size: 'lg',
            color: '#333333',
            align: 'center'
          },
          {
            type: 'text',
            text: '您的專屬空氣品質監測助手',
            size: 'md',
            color: '#666666',
            align: 'center',
            margin: 'sm'
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '✨ 主要功能',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '🔍 即時空氣品質查詢\n📊 多城市比較分析\n💊 專業健康建議\n🔔 智慧訂閱提醒\n📍 GPS定位查詢',
            size: 'sm',
            color: '#666666',
            margin: 'sm',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#4CAF50',
            action: {
              type: 'message',
              label: '🚀 開始使用',
              text: '主選單'
            }
          }
        ]
      }
    }
  };
}

// 處理LINE訊息（完善版）
async function handleEvent(event) {
  // 只處理訊息事件
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  if (!userId) {
    console.error('缺少用戶ID');
    return Promise.resolve(null);
  }

  try {
    // 處理位置訊息
    if (event.message.type === 'location') {
      return await handleLocationMessage(event);
    }

    // 只處理文字訊息
    if (event.message.type !== 'text') {
      const helpMessage = createMainMenuFlexMessage();
      return client.replyMessage(event.replyToken, helpMessage);
    }

    const userMessage = event.message.text?.trim();
    if (!userMessage) {
      const helpMessage = createMainMenuFlexMessage();
      return client.replyMessage(event.replyToken, helpMessage);
    }

    console.log(`用戶 ${userId} 訊息: ${userMessage}`);

    // 檢查用戶狀態
    const userState = getUserState(userId);
    if (userState) {
      return await handleStatefulMessage(event, userState);
    }

    // 處理一般訊息
    return await handleGeneralMessage(event);

  } catch (error) {
    console.error('處理訊息錯誤:', error);
    const errorMessage = createErrorFlexMessage('api_error', '系統發生錯誤，請稍後再試。');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理位置訊息
async function handleLocationMessage(event) {
  const userId = event.source.userId;
  const { latitude, longitude } = event.message;

  try {
    locationCache.set(userId, { 
      lat: latitude, 
      lng: longitude, 
      timestamp: Date.now() 
    });
    
    const nearbyStations = await findNearbyStations(latitude, longitude);
    const flexMessage = createNearbyStationsFlexMessage(nearbyStations, latitude, longitude);
    
    return client.replyMessage(event.replyToken, flexMessage);
  } catch (error) {
    console.error('處理位置訊息錯誤:', error);
    const errorMessage = createErrorFlexMessage('api_error', '查詢附近空氣品質時發生錯誤，請稍後再試。');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理一般訊息
async function handleGeneralMessage(event) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  const queryResult = parseQuery(userMessage);

  // 處理問候語
  if (!queryResult || queryResult.type === 'greeting') {
    const welcomeMessage = createWelcomeFlexMessage();
    const menuMessage = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, [welcomeMessage, menuMessage]);
  }

  // 處理各種指令
  switch (queryResult.type) {
    case 'help':
      return await handleHelpCommand(event);
    
    case 'settings':
      return await handleSettingsCommand(event, userId);
    
    case 'single':
      return await handleSingleCityQuery(event, queryResult);
    
    case 'compare':
      return await handleCompareQuery(event, queryResult);
    
    case 'subscribe':
      return await handleSubscribeCommand(event, userId, queryResult);
    
    case 'unsubscribe':
      return await handleUnsubscribeCommand(event, userId, queryResult);
    
    case 'list_subscriptions':
      return await handleListSubscriptionsCommand(event, userId);
    
    default:
      // 未識別的指令
      const notFoundMessage = createErrorFlexMessage('not_found', '我無法識別您的指令。請使用下方選單或嘗試直接輸入城市名稱。');
      const menuMessage = createMainMenuFlexMessage();
      return client.replyMessage(event.replyToken, [notFoundMessage, menuMessage]);
  }
}

// 各種指令處理函數
async function handleSingleCityQuery(event, queryResult) {
  try {
    const airQualityData = await getAirQuality(queryResult.city);
    
    // 添加中文城市名稱
    if (queryResult.cityName) {
      airQualityData.chineseName = queryResult.cityName;
    }
    
    const flexMessage = createAirQualityFlexMessage(airQualityData);
    return client.replyMessage(event.replyToken, flexMessage);
  } catch (error) {
    console.error('查詢單一城市錯誤:', error);
    const errorMessage = createErrorFlexMessage('api_error', `無法獲取 ${queryResult.cityName || queryResult.city} 的空氣品質數據，請稍後再試。`);
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

async function handleCompareQuery(event, queryResult) {
  try {
    const citiesData = await getMultipleCitiesAirQuality(queryResult.cities);
    
    if (citiesData.length === 0) {
      const errorMessage = createErrorFlexMessage('api_error', '抱歉，無法獲取這些城市的空氣品質數據。請稍後再試。');
      return client.replyMessage(event.replyToken, errorMessage);
    }
    
    if (citiesData.length === 1) {
      // 只有一個城市有數據，返回單城市查詢結果
      const flexMessage = createAirQualityFlexMessage(citiesData[0]);
      return client.replyMessage(event.replyToken, flexMessage);
    }
    
    const comparisonMessage = createCityComparisonFlexMessage(citiesData);
    return client.replyMessage(event.replyToken, comparisonMessage);
  } catch (error) {
    console.error('處理城市比較錯誤:', error);
    const errorMessage = createErrorFlexMessage('api_error', '比較城市時發生錯誤，請稍後再試。');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理狀態對話（簡化版）
async function handleStatefulMessage(event, userState) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  
  clearUserState(userId); // 清除狀態
  
  // 根據狀態處理
  if (userState.state === 'awaiting_compare_cities') {
    return await handleCompareInput(event, userMessage);
  }
  
  // 預設返回主選單
  const menuMessage = createMainMenuFlexMessage();
  return client.replyMessage(event.replyToken, menuMessage);
}

async function handleCompareInput(event, userMessage) {
  const cities = [];
  const words = userMessage.split(/[\s,，]+/);
  
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed) {
      for (const [chinese, english] of Object.entries(cityMap)) {
        if (trimmed.includes(chinese) || trimmed.toLowerCase().includes(english)) {
          cities.push({ chinese, english });
          break;
        }
      }
    }
  }
  
  if (cities.length < 2) {
    const errorMessage = createErrorFlexMessage('not_found', '請至少輸入2個城市名稱。');
    return client.replyMessage(event.replyToken, errorMessage);
  }
  
  return await handleCompareQuery(event, { type: 'compare', cities: cities.slice(0, 5) });
}

// 創建附近監測站Flex Message（簡化版）
function createNearbyStationsFlexMessage(stations, userLat, userLng) {
  if (stations.length === 0) {
    return createErrorFlexMessage('not_found', '抱歉，找不到您附近的空氣品質監測站，請嘗試查詢特定城市。');
  }

  const flexMessage = {
    type: 'flex',
    altText: `附近監測站 - 找到 ${stations.length} 個站點`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📍 附近空氣品質監測站',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          },
          {
            type: 'text',
            text: `找到 ${stations.length} 個監測站`,
            color: '#ffffff',
            size: 'sm',
            align: 'center',
            margin: 'sm'
          }
        ],
        backgroundColor: '#4CAF50',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: []
      }
    }
  };

  stations.forEach((station, index) => {
    const aqiInfo = getAQILevel(station.aqi || 0);
    const distanceText = station.distance < 1 ? 
      `${Math.round(station.distance * 1000)}公尺` : 
      `${station.distance.toFixed(1)}公里`;

    flexMessage.contents.body.contents.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      margin: index > 0 ? 'md' : 'lg',
      contents: [
        {
          type: 'text',
          text: `${index + 1}`,
          size: 'lg',
          weight: 'bold',
          flex: 1,
          color: '#666666',
          align: 'center'
        },
        {
          type: 'box',
          layout: 'vertical',
          flex: 4,
          contents: [
            {
              type: 'text',
              text: station.station?.name || '監測站',
              weight: 'bold',
              size: 'md',
              color: '#333333',
              wrap: true
            },
            {
              type: 'text',
              text: `📏 ${distanceText}`,
              size: 'xs',
              color: '#999999'
            }
          ]
        },
        {
          type: 'box',
          layout: 'vertical',
          flex: 3,
          contents: [
            {
              type: 'text',
              text: `AQI ${station.aqi || 'N/A'}`,
              weight: 'bold',
              size: 'md',
              color: aqiInfo.color,
              align: 'end'
            },
            {
              type: 'text',
              text: aqiInfo.level,
              size: 'xs',
              color: '#666666',
              align: 'end',
              wrap: true
            }
          ]
        }
      ]
    });

    if (index < stations.length - 1) {
      flexMessage.contents.body.contents.push({
        type: 'separator',
        margin: 'md'
      });
    }
  });

  return flexMessage;
}

// 排程任務（完善版）
cron.schedule('0 8 * * *', async () => {
  console.log('開始發送每日空氣品質報告...');
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const [userId, subscription] of subscriptions.entries()) {
    if (subscription.settings.dailyReport && subscription.cities.length > 0) {
      try {
        const cityData = await getMultipleCitiesAirQuality(
          subscription.cities.map(city => ({ 
            chinese: Object.keys(cityMap).find(key => cityMap[key] === city) || city, 
            english: city 
          }))
        );
        
        if (cityData.length > 0) {
          const dailyReportMessage = createDailyReportFlexMessage(cityData);
          await client.pushMessage(userId, dailyReportMessage);
          successCount++;
        }
      } catch (error) {
        console.error(`發送每日報告給用戶 ${userId} 失敗:`, error.message);
        errorCount++;
      }
    }
  }
  
  console.log(`每日報告發送完成 - 成功: ${successCount}, 失敗: ${errorCount}`);
}, {
  timezone: "Asia/Taipei"
});

// 創建每日報告Flex Message（簡化版）
function createDailyReportFlexMessage(citiesData) {
  const bestCity = citiesData.reduce((best, current) => 
    current.aqi < best.aqi ? current : best
  );
  
  return {
    type: 'flex',
    altText: `每日空氣品質報告 - 最佳: ${bestCity.chineseName}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🌅 每日空氣品質報告',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          },
          {
            type: 'text',
            text: new Date().toLocaleDateString('zh-TW'),
            color: '#ffffff',
            size: 'sm',
            align: 'center',
            margin: 'sm'
          }
        ],
        paddingAll: '20px',
        backgroundColor: '#4CAF50'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `🏆 今日推薦：${bestCity.chineseName}`,
            weight: 'bold',
            color: '#4CAF50',
            align: 'center',
            size: 'lg'
          },
          {
            type: 'text',
            text: `AQI: ${bestCity.aqi}`,
            color: '#666666',
            align: 'center',
            margin: 'sm'
          }
        ]
      }
    }
  };
}

// Webhook端點
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook處理錯誤:', err);
      res.status(500).end();
    });
});

// 首頁端點（修正版）
app.get('/', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      // 返回簡化的HTML內容
      res.send(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智慧空氣品質機器人</title>
    <style>
        body { 
            font-family: 'Segoe UI', sans-serif; 
            background: linear-gradient(-45deg, #667eea, #764ba2); 
            min-height: 100vh; 
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
        }
        .container { 
            background: white; 
            padding: 3rem; 
            border-radius: 20px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.1); 
            text-align: center; 
            max-width: 600px;
        }
        h1 { color: #333; margin-bottom: 1rem; }
        .status { color: #00e400; margin: 1rem 0; }
        .cta-button { 
            display: inline-block; 
            background: #00b900; 
            color: white; 
            padding: 15px 30px; 
            border-radius: 25px; 
            text-decoration: none; 
            margin: 0.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌬️ 智慧空氣品質機器人</h1>
        <div class="status">🟢 服務正常運行中</div>
        <p>即時監測空氣品質，守護您和家人的健康</p>
        <a href="https://line.me/R/ti/p/@470kdmxx" class="cta-button" target="_blank">立即加入好友</a>
        <a href="/health" class="cta-button">服務狀態</a>
        <p style="margin-top: 2rem; font-size: 0.9rem; color: #666;">
            © 2025 智慧空氣品質機器人 | 用科技守護每一次呼吸
        </p>
    </div>
</body>
</html>
      `);
    }
  } catch (error) {
    console.error('首頁載入錯誤:', error);
    res.status(500).send('服務臨時不可用，請稍後再試');
  }
});

// 健康檢查端點（完善版）
app.get('/health', (req, res) => {
  try {
    res.json({ 
      status: 'OK', 
      message: 'LINE智慧空氣品質機器人正常運行',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: '2.0.0',
      environment: {
        node_version: process.version,
        platform: process.platform,
        memory_usage: {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
        },
        line_configured: !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET),
        waqi_configured: !!WAQI_TOKEN
      },
      statistics: {
        total_subscriptions: subscriptions.size,
        location_cache_entries: locationCache.size,
        active_user_states: userStates.size,
        supported_cities: Object.keys(cityMap).length,
        api_cache_entries: apiCache.size
      },
      features: [
        'real_time_air_quality_query',
        'multi_city_comparison',
        'health_recommendations',
        'subscription_management',
        'gps_location_query',
        'daily_reports',
        'emergency_alerts',
        'flex_message_interface'
      ]
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// API端點（完善版）
app.get('/api/air-quality/:city', async (req, res) => {
  try {
    const city = req.params.city;
    if (!city) {
      return res.status(400).json({ error: '缺少城市參數' });
    }
    
    const airQualityData = await getAirQuality(city);
    res.json({
      ...airQualityData,
      query_time: new Date().toISOString(),
      cache_status: apiCache.has(city) ? 'hit' : 'miss'
    });
  } catch (error) {
    console.error(`API查詢錯誤 - ${req.params.city}:`, error.message);
    res.status(500).json({ 
      error: '無法獲取空氣品質數據',
      details: error.message,
      city: req.params.city,
      timestamp: new Date().toISOString()
    });
  }
});

// 統計API
app.get('/api/stats', (req, res) => {
  res.json({
    service: {
      name: '智慧空氣品質機器人',
      version: '2.0.0',
      status: 'running',
      uptime: Math.floor(process.uptime())
    },
    statistics: {
      supportedCities: Object.keys(cityMap).length,
      totalSubscriptions: subscriptions.size,
      activeCacheEntries: apiCache.size,
      activeUserStates: userStates.size
    },
    features: [
      'real_time_air_quality',
      'multi_city_comparison',
      'health_recommendations',
      'subscription_alerts',
      'gps_location_query',
      'flex_message_interface'
    ],
    cache_stats: {
      api_cache_size: apiCache.size,
      location_cache_size: locationCache.size,
      cache_hit_rate: 'N/A'
    }
  });
});

// 清理過期數據（每小時執行）
cron.schedule('0 * * * *', () => {
  const now = Date.now();
  let cleaned = 0;
  
  // 清理過期的用戶狀態（超過5分鐘）
  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > 300000) {
      userStates.delete(userId);
      cleaned++;
    }
  }
  
  // 清理過期的位置快取（超過1小時）
  for (const [userId, location] of locationCache.entries()) {
    if (now - location.timestamp > 3600000) {
      locationCache.delete(userId);
      cleaned++;
    }
  }
  
  // 清理過期的API快取（超過15分鐘）
  for (const [city, cache] of apiCache.entries()) {
    if (now - cache.timestamp > CACHE_DURATION) {
      apiCache.delete(city);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`清理完成 - 共清理 ${cleaned} 個過期項目`);
  }
}, {
  timezone: "Asia/Taipei"
});

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error('未處理的錯誤:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: '系統發生錯誤',
    timestamp: new Date().toISOString()
  });
});

// 404處理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: '請求的路由不存在',
    available_routes: ['/', '/health', '/api/air-quality/:city', '/api/stats'],
    timestamp: new Date().toISOString()
  });
});

// 優雅關機
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，正在優雅關機...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('收到 SIGINT，正在優雅關機...');
  process.exit(0);
});

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 LINE智慧空氣品質機器人啟動 - 端口: ${port}`);
  console.log('✅ 服務已就緒，等待處理請求...');
  console.log(`🌐 健康檢查: http://localhost:${port}/health`);
  console.log(`📊 統計資訊: http://localhost:${port}/api/stats`);
  
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
    console.warn('⚠️ LINE Bot 環境變數未設定');
  } else {
    console.log('✅ LINE Bot 設定完成');
  }
  
  console.log(`📍 支援 ${Object.keys(cityMap).length} 個城市查詢`);
});