const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();

// 靜態文件服務
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LINE Bot設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 空氣品質API設定
const WAQI_TOKEN = process.env.WAQI_TOKEN || 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// 創建LINE Bot客戶端
const client = new line.Client(config);

// === 數據管理 ===
// 在實際部署中建議使用資料庫
let subscriptions = new Map(); // userId -> {cities: [], settings: {}}
let locationCache = new Map(); // userId -> {lat, lng, timestamp}
let userStates = new Map(); // userId -> {state: 'waiting_input', context: {}, timestamp}
let apiCache = new Map(); // cityKey -> {data, timestamp}

// === 配置常量 ===
const CACHE_DURATION = 5 * 60 * 1000; // 5分鐘緩存
const USER_STATE_TIMEOUT = 10 * 60 * 1000; // 10分鐘狀態超時
const LOCATION_CACHE_TIMEOUT = 60 * 60 * 1000; // 1小時位置緩存

// 完整的城市對應表
const cityMap = {
  // 台灣主要城市
  '台北': 'taipei',
  '新北': 'new-taipei', 
  '桃園': 'taoyuan',
  '台中': 'taichung',
  '台南': 'tainan',
  '高雄': 'kaohsiung',
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
  
  // 國際主要城市
  '北京': 'beijing',
  '上海': 'shanghai',
  '廣州': 'guangzhou',
  '深圳': 'shenzhen',
  '香港': 'hong-kong',
  '澳門': 'macau',
  '東京': 'tokyo',
  '大阪': 'osaka',
  '首爾': 'seoul',
  '釜山': 'busan',
  '曼谷': 'bangkok',
  '新加坡': 'singapore',
  '吉隆坡': 'kuala-lumpur',
  '雅加達': 'jakarta',
  '馬尼拉': 'manila',
  '河內': 'hanoi',
  '胡志明市': 'ho-chi-minh-city',
  '金邊': 'phnom-penh',
  '仰光': 'yangon',
  '孟買': 'mumbai',
  '德里': 'delhi',
  '倫敦': 'london',
  '巴黎': 'paris',
  '柏林': 'berlin',
  '羅馬': 'rome',
  '馬德里': 'madrid',
  '紐約': 'new-york',
  '洛杉磯': 'los-angeles',
  '芝加哥': 'chicago',
  '多倫多': 'toronto',
  '溫哥華': 'vancouver',
  '雪梨': 'sydney',
  '墨爾本': 'melbourne'
};

// === 工具函數 ===

// 清理過期緩存
function cleanExpiredCache() {
  const now = Date.now();
  
  // 清理API緩存
  for (const [key, value] of apiCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      apiCache.delete(key);
    }
  }
  
  // 清理用戶狀態
  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > USER_STATE_TIMEOUT) {
      userStates.delete(userId);
    }
  }
  
  // 清理位置緩存
  for (const [userId, location] of locationCache.entries()) {
    if (now - location.timestamp > LOCATION_CACHE_TIMEOUT) {
      locationCache.delete(userId);
    }
  }
}

// 用戶狀態管理
function setUserState(userId, state, context = {}) {
  userStates.set(userId, { 
    state, 
    context, 
    timestamp: Date.now() 
  });
}

function getUserState(userId) {
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < USER_STATE_TIMEOUT) {
    return userState;
  }
  userStates.delete(userId);
  return null;
}

function clearUserState(userId) {
  userStates.delete(userId);
}

// 計算兩點間距離（公里）
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// AQI等級判斷
function getAQILevel(aqi) {
  if (aqi <= 50) return { level: '良好', color: '#00e400', emoji: '😊' };
  if (aqi <= 100) return { level: '普通', color: '#ffff00', emoji: '😐' };
  if (aqi <= 150) return { level: '對敏感族群不健康', color: '#ff7e00', emoji: '😷' };
  if (aqi <= 200) return { level: '不健康', color: '#ff0000', emoji: '😰' };
  if (aqi <= 300) return { level: '非常不健康', color: '#8f3f97', emoji: '🤢' };
  return { level: '危險', color: '#7e0023', emoji: '☠️' };
}

// 健康建議系統
function getHealthAdvice(aqi) {
  if (aqi <= 50) {
    return {
      general: '空氣品質極佳！適合所有戶外活動',
      sensitive: '敏感族群也可正常戶外活動',
      exercise: '🏃‍♂️ 極適合：跑步、騎車、登山等高強度運動',
      mask: '😊 無需配戴口罩',
      indoor: '🪟 可開窗通風，享受新鮮空氣',
      color: '#00e400'
    };
  } else if (aqi <= 100) {
    return {
      general: '空氣品質可接受，一般人群可正常活動',
      sensitive: '⚠️ 敏感族群請減少長時間戶外劇烈運動',
      exercise: '🚶‍♂️ 適合：散步、瑜伽、輕度慢跑',
      mask: '😷 建議配戴一般口罩',
      indoor: '🪟 可適度開窗，保持空氣流通',
      color: '#ffff00'
    };
  } else if (aqi <= 150) {
    return {
      general: '對敏感族群不健康，一般人群減少戶外活動',
      sensitive: '🚨 敏感族群應避免戶外活動',
      exercise: '🏠 建議室內運動：瑜伽、伸展、重訓',
      mask: '😷 必須配戴N95或醫用口罩',
      indoor: '🚪 關閉門窗，使用空氣清淨機',
      color: '#ff7e00'
    };
  } else if (aqi <= 200) {
    return {
      general: '所有人群都應減少戶外活動',
      sensitive: '🚫 敏感族群請留在室內',
      exercise: '🏠 僅建議室內輕度活動',
      mask: '😷 外出必須配戴N95口罩',
      indoor: '🚪 緊閉門窗，持續使用空氣清淨機',
      color: '#ff0000'
    };
  } else if (aqi <= 300) {
    return {
      general: '所有人群避免戶外活動',
      sensitive: '🏠 所有人應留在室內',
      exercise: '🚫 避免任何戶外運動',
      mask: '😷 外出務必配戴N95或更高等級口罩',
      indoor: '🚪 緊閉門窗，使用高效空氣清淨機',
      color: '#8f3f97'
    };
  } else {
    return {
      general: '⚠️ 緊急狀況！所有人應留在室內',
      sensitive: '🚨 立即尋求室內避難場所',
      exercise: '🚫 禁止所有戶外活動',
      mask: '😷 外出必須配戴專業防護口罩',
      indoor: '🚪 密閉室內，使用高效空氣清淨設備',
      color: '#7e0023'
    };
  }
}

// === 自然語言處理 ===

// 解析自然語言查詢
function parseQuery(text) {
  text = text.toLowerCase().trim();
  
  // 移除常見的查詢詞
  const cleanText = text.replace(/[空氣品質|空氣|空品|pm2\.5|aqi|查詢|怎麼樣|如何|的]/g, '');
  
  // 檢查特殊指令
  if (text.includes('訂閱') || text.includes('subscribe')) {
    return parseSubscribeQuery(text);
  }
  
  if (text.includes('取消訂閱') || text.includes('unsubscribe')) {
    return parseUnsubscribeQuery(text);
  }
  
  if (text.includes('我的訂閱') || text.includes('訂閱清單') || text.includes('訂閱列表')) {
    return { type: 'list_subscriptions' };
  }
  
  if (text.includes('設定') || text.includes('settings') || text.includes('配置')) {
    return { type: 'settings' };
  }
  
  if (text.includes('比較') || text.includes('vs') || text.includes('對比') || text.includes('比較')) {
    return parseCompareQuery(text);
  }
  
  if (text.includes('幫助') || text.includes('help') || text.includes('說明') || text.includes('使用方法')) {
    return { type: 'help' };
  }
  
  if (text.includes('今天適合') || text.includes('可以出門') || text.includes('適合運動')) {
    // 智慧建議查詢
    const cities = extractCitiesFromText(text);
    if (cities.length > 0) {
      return { type: 'smart_advice', cities: cities.slice(0, 1) };
    }
    return { type: 'smart_advice', needLocation: true };
  }
  
  // 檢查城市名稱
  const cities = extractCitiesFromText(text);
  if (cities.length > 1) {
    return { type: 'compare', cities: cities.slice(0, 5) };
  } else if (cities.length === 1) {
    return { type: 'single', city: cities[0].english, cityName: cities[0].chinese };
  }
  
  return null;
}

// 從文本中提取城市
function extractCitiesFromText(text) {
  const cities = [];
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese) || text.toLowerCase().includes(english)) {
      cities.push({ chinese, english });
    }
  }
  return cities;
}

// 解析訂閱查詢
function parseSubscribeQuery(text) {
  const cities = extractCitiesFromText(text);
  if (cities.length > 0) {
    return { type: 'subscribe', city: cities[0].english, cityName: cities[0].chinese };
  }
  return { type: 'subscribe', city: null };
}

// 解析取消訂閱查詢
function parseUnsubscribeQuery(text) {
  const cities = extractCitiesFromText(text);
  if (cities.length > 0) {
    return { type: 'unsubscribe', city: cities[0].english, cityName: cities[0].chinese };
  }
  return { type: 'unsubscribe', city: null };
}

// 解析比較查詢
function parseCompareQuery(text) {
  const cities = extractCitiesFromText(text);
  if (cities.length >= 2) {
    return { type: 'compare', cities: cities.slice(0, 5) };
  }
  return { type: 'compare', cities: [] };
}

// === API 服務 ===

// 獲取空氣品質數據（帶緩存）
async function getAirQuality(city) {
  const cacheKey = `aqi_${city}`;
  const cached = apiCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  
  try {
    const url = `${WAQI_BASE_URL}/feed/${city}/?token=${WAQI_TOKEN}`;
    console.log(`正在查詢: ${url}`);
    
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data.status === 'ok') {
      const data = response.data.data;
      apiCache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } else {
      throw new Error(`API 返回錯誤狀態: ${response.data.status}`);
    }
  } catch (error) {
    console.error(`獲取 ${city} 空氣品質數據錯誤:`, error.message);
    
    // 如果有舊的緩存數據，返回舊數據
    if (cached) {
      console.log(`使用過期緩存數據: ${city}`);
      return cached.data;
    }
    
    throw new Error(`無法獲取 ${city} 的空氣品質數據: ${error.message}`);
  }
}

// 獲取多個城市的空氣品質數據
async function getMultipleCitiesAirQuality(cities) {
  const promises = cities.map(async (cityInfo) => {
    try {
      const data = await getAirQuality(cityInfo.english);
      return { ...data, chineseName: cityInfo.chinese };
    } catch (error) {
      console.error(`獲取${cityInfo.chinese}空氣品質失敗:`, error.message);
      return null;
    }
  });
  
  const results = await Promise.all(promises);
  return results.filter(result => result !== null);
}

// 根據位置查找附近的監測站
async function findNearbyStations(lat, lng) {
  try {
    const url = `${WAQI_BASE_URL}/search/?token=${WAQI_TOKEN}&keyword=geo:${lat};${lng}`;
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data.status === 'ok' && response.data.data.length > 0) {
      const stationsWithDistance = response.data.data
        .filter(station => station.geo && station.geo.length === 2)
        .map(station => ({
          ...station,
          distance: calculateDistance(lat, lng, station.geo[0], station.geo[1])
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
      
      return stationsWithDistance;
    }
    return [];
  } catch (error) {
    console.error('查找附近監測站錯誤:', error.message);
    return [];
  }
}

// === 訂閱管理 ===

function addSubscription(userId, city) {
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
    return true;
  }
  return false;
}

function removeSubscription(userId, city) {
  if (subscriptions.has(userId)) {
    const userSub = subscriptions.get(userId);
    const index = userSub.cities.indexOf(city);
    if (index > -1) {
      userSub.cities.splice(index, 1);
      return true;
    }
  }
  return false;
}

function removeAllSubscriptions(userId) {
  if (subscriptions.has(userId)) {
    subscriptions.delete(userId);
    return true;
  }
  return false;
}

function getUserSubscriptions(userId) {
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
  if (!subscriptions.has(userId)) {
    subscriptions.set(userId, {
      cities: [],
      settings: { dailyReport: true, emergencyAlert: true, threshold: 100 }
    });
  }
  
  const userSub = subscriptions.get(userId);
  userSub.settings = { ...userSub.settings, ...settings };
  return userSub.settings;
}

// === Flex Message 創建函數 ===

// 創建主選單Flex Message
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
            text: '守護您的每一次呼吸',
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
                  text: '我的訂閱'
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'primary',
                color: '#00e400',
                action: {
                  type: 'location',
                  label: '📍 附近查詢'
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
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '⚙️ 個人設定',
                  text: '個人設定'
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '💡 使用說明',
                  text: '使用說明'
                },
                flex: 1
              }
            ]
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
            text: '💬 直接輸入城市名稱也可快速查詢',
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

// 創建空氣品質Flex Message
function createAirQualityFlexMessage(data) {
  const aqiInfo = getAQILevel(data.aqi);
  const healthAdvice = getHealthAdvice(data.aqi);
  const updateTime = new Date(data.time.iso).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

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
            size: 'lg',
            align: 'center'
          },
          {
            type: 'text',
            text: `AQI ${data.aqi} - ${aqiInfo.level}`,
            color: '#ffffff',
            size: 'md',
            align: 'center',
            margin: 'sm'
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
                type: 'text',
                text: '🏥 健康建議',
                weight: 'bold',
                size: 'md',
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
            text: `📅 更新時間: ${updateTime}`,
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
  if (data.iaqi) {
    const pollutants = [];
    const pollutantMap = [
      { key: 'pm25', name: 'PM2.5', unit: 'μg/m³' },
      { key: 'pm10', name: 'PM10', unit: 'μg/m³' },
      { key: 'o3', name: '臭氧', unit: 'ppb' },
      { key: 'no2', name: '二氧化氮', unit: 'ppb' },
      { key: 'so2', name: '二氧化硫', unit: 'ppb' },
      { key: 'co', name: '一氧化碳', unit: 'mg/m³' }
    ];

    pollutantMap.forEach(pollutant => {
      if (data.iaqi[pollutant.key]) {
        pollutants.push({
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: pollutant.name,
              color: '#aaaaaa',
              size: 'sm',
              flex: 2
            },
            {
              type: 'text',
              text: `${data.iaqi[pollutant.key].v} ${pollutant.unit}`,
              wrap: true,
              color: '#666666',
              size: 'sm',
              flex: 3
            }
          ]
        });
      }
    });

    if (pollutants.length > 0) {
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
        ...pollutants
      );
    }
  }

  return flexMessage;
}

// 創建多城市比較Flex Message
function createCityComparisonFlexMessage(citiesData) {
  const sortedCities = citiesData.sort((a, b) => a.aqi - b.aqi);
  const bestCity = sortedCities[0];
  const worstCity = sortedCities[sortedCities.length - 1];

  const flexMessage = {
    type: 'flex',
    altText: `多城市比較 - 最佳: ${bestCity.chineseName || bestCity.city.name} AQI: ${bestCity.aqi}`,
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
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            margin: 'sm',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#4CAF50',
                action: {
                  type: 'message',
                  label: `查看 ${bestCity.chineseName || bestCity.city.name}`,
                  text: `${bestCity.chineseName || bestCity.city.name}空氣品質`
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '🔍 重新比較',
                  text: '比較城市'
                },
                flex: 1
              }
            ]
          }
        ]
      }
    }
  };

  const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

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
              align: 'end'
            }
          ]
        }
      ]
    });
    
    if (index < sortedCities.length - 1) {
      flexMessage.contents.body.contents.push({
        type: 'separator',
        margin: 'md'
      });
    }
  });

  // 添加旅行建議
  const bestAqiInfo = getAQILevel(bestCity.aqi);
  const recommendation = bestCity.aqi <= 100 ? 
    `✈️ 推薦前往 ${bestCity.chineseName || bestCity.city.name}！空氣品質${bestAqiInfo.level}` :
    `⚠️ 所有城市空氣品質都需注意，${bestCity.chineseName || bestCity.city.name} 相對最佳`;

  flexMessage.contents.body.contents.push(
    {
      type: 'separator',
      margin: 'lg'
    },
    {
      type: 'text',
      text: '🎯 智慧建議',
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
    }
  );

  return flexMessage;
}

// 創建錯誤訊息
function createErrorMessage(errorType, customMessage = '') {
  const errors = {
    not_found: '🤔 抱歉，我無法理解您的指令',
    api_error: '😵 查詢服務暫時無法使用',
    network_error: '🌐 網路連接發生問題',
    no_data: '📭 查無空氣品質數據'
  };

  const message = customMessage || errors[errorType] || errors.api_error;
  
  return {
    type: 'text',
    text: `${message}\n\n💡 您可以：\n• 重新輸入查詢\n• 點擊下方選單\n• 輸入「主選單」獲得幫助`
  };
}

// === 主要事件處理 ===

async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;

  try {
    // 處理位置訊息
    if (event.message.type === 'location') {
      return await handleLocationMessage(event);
    }

    // 處理文字訊息
    if (event.message.type === 'text') {
      return await handleTextMessage(event);
    }

    return Promise.resolve(null);
  } catch (error) {
    console.error('處理事件錯誤:', error);
    const errorMessage = createErrorMessage('api_error', '處理您的請求時發生錯誤，請稍後再試');
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
    
    if (nearbyStations.length === 0) {
      const noStationsMessage = {
        type: 'text',
        text: '😔 抱歉，找不到您附近的空氣品質監測站\n\n💡 您可以直接輸入城市名稱查詢，例如：「台北空氣品質」'
      };
      return client.replyMessage(event.replyToken, noStationsMessage);
    }

    // 創建附近監測站訊息
    let messageText = '📍 找到您附近的空氣品質監測站：\n\n';
    
    for (let i = 0; i < Math.min(3, nearbyStations.length); i++) {
      const station = nearbyStations[i];
      const aqiInfo = getAQILevel(station.aqi || 0);
      const distance = station.distance < 1 ? 
        `${Math.round(station.distance * 1000)}公尺` : 
        `${station.distance.toFixed(1)}公里`;
      
      messageText += `${i + 1}. ${station.station?.name || '監測站'}\n`;
      messageText += `   📏 距離: ${distance}\n`;
      messageText += `   💨 AQI: ${station.aqi || 'N/A'} (${aqiInfo.level})\n\n`;
    }

    messageText += '💡 點擊站點名稱可查看詳細資訊';

    const locationMessage = {
      type: 'text',
      text: messageText
    };

    return client.replyMessage(event.replyToken, [locationMessage, createMainMenuFlexMessage()]);
  } catch (error) {
    console.error('處理位置訊息錯誤:', error);
    const errorMessage = createErrorMessage('api_error', '查詢附近監測站時發生錯誤');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理文字訊息
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const userMessage = event.message.text.trim();

  // 檢查用戶狀態
  const userState = getUserState(userId);
  if (userState) {
    return await handleStatefulMessage(event, userState);
  }

  // 處理問候語和主選單
  if (userMessage.match(/^(你好|哈囉|hello|hi|主選單|menu|開始)/i)) {
    const welcomeText = {
      type: 'text',
      text: '🌟 歡迎使用智慧空氣品質機器人！\n\n我可以幫您：\n🔍 查詢即時空氣品質\n📊 比較多個城市\n🔔 設定訂閱提醒\n📍 查找附近監測站\n💊 提供健康建議'
    };
    return client.replyMessage(event.replyToken, [welcomeText, createMainMenuFlexMessage()]);
  }

  // 解析自然語言查詢
  const queryResult = parseQuery(userMessage);
  
  if (!queryResult) {
    const errorMessage = createErrorMessage('not_found');
    return client.replyMessage(event.replyToken, [errorMessage, createMainMenuFlexMessage()]);
  }

  // 路由到對應處理函數
  switch (queryResult.type) {
    case 'single':
      return await handleSingleCityQuery(event, queryResult);
    case 'compare':
      return await handleCityComparison(event, queryResult);
    case 'smart_advice':
      return await handleSmartAdvice(event, queryResult);
    case 'subscribe':
      return await handleSubscription(event, queryResult);
    case 'unsubscribe':
      return await handleUnsubscription(event, queryResult);
    case 'list_subscriptions':
      return await handleListSubscriptions(event);
    case 'settings':
      return await handleSettings(event);
    case 'help':
      return await handleHelp(event);
    default:
      return await handleUnknownCommand(event);
  }
}

// 處理單城市查詢
async function handleSingleCityQuery(event, queryResult) {
  try {
    const airQualityData = await getAirQuality(queryResult.city);
    airQualityData.chineseName = queryResult.cityName;
    const flexMessage = createAirQualityFlexMessage(airQualityData);
    return client.replyMessage(event.replyToken, flexMessage);
  } catch (error) {
    console.error('單城市查詢錯誤:', error);
    const errorMessage = createErrorMessage('api_error', `無法獲取${queryResult.cityName}的空氣品質數據`);
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理城市比較
async function handleCityComparison(event, queryResult) {
  if (queryResult.cities.length === 0) {
    setUserState(event.source.userId, 'awaiting_compare_cities');
    const instructionMessage = {
      type: 'text',
      text: '🆚 多城市比較\n\n請輸入要比較的城市名稱，用空格分隔：\n\n範例：\n• 台北 高雄\n• 台北 台中 台南\n• 東京 首爾 新加坡'
    };
    return client.replyMessage(event.replyToken, instructionMessage);
  }

  try {
    const citiesData = await getMultipleCitiesAirQuality(queryResult.cities);
    
    if (citiesData.length === 0) {
      const errorMessage = createErrorMessage('no_data', '無法獲取這些城市的空氣品質數據');
      return client.replyMessage(event.replyToken, errorMessage);
    }
    
    if (citiesData.length === 1) {
      const flexMessage = createAirQualityFlexMessage(citiesData[0]);
      return client.replyMessage(event.replyToken, flexMessage);
    }
    
    const comparisonMessage = createCityComparisonFlexMessage(citiesData);
    return client.replyMessage(event.replyToken, comparisonMessage);
  } catch (error) {
    console.error('城市比較錯誤:', error);
    const errorMessage = createErrorMessage('api_error', '比較城市時發生錯誤');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理智慧建議
async function handleSmartAdvice(event, queryResult) {
  const userId = event.source.userId;
  
  try {
    let city = null;
    let cityName = '';
    
    if (queryResult.cities && queryResult.cities.length > 0) {
      city = queryResult.cities[0].english;
      cityName = queryResult.cities[0].chinese;
    } else if (queryResult.needLocation) {
      // 檢查是否有緩存的位置
      const userLocation = locationCache.get(userId);
      if (userLocation) {
        const nearbyStations = await findNearbyStations(userLocation.lat, userLocation.lng);
        if (nearbyStations.length > 0) {
          const station = nearbyStations[0];
          const stationData = await getAirQuality(station.station.name.toLowerCase().replace(/\s+/g, '-'));
          return await generateSmartAdviceResponse(event, stationData, '您的位置');
        }
      }
      
      // 沒有位置信息，請求位置分享
      const locationRequestMessage = {
        type: 'text',
        text: '📍 為了提供個人化建議，請分享您的位置\n\n或者直接輸入城市名稱，例如：「台北今天適合出門嗎？」'
      };
      return client.replyMessage(event.replyToken, locationRequestMessage);
    }
    
    if (city) {
      const airQualityData = await getAirQuality(city);
      return await generateSmartAdviceResponse(event, airQualityData, cityName);
    }
    
  } catch (error) {
    console.error('智慧建議錯誤:', error);
    const errorMessage = createErrorMessage('api_error', '無法獲取智慧建議');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 生成智慧建議回應
async function generateSmartAdviceResponse(event, airQualityData, locationName) {
  const aqiInfo = getAQILevel(airQualityData.aqi);
  const healthAdvice = getHealthAdvice(airQualityData.aqi);
  
  let adviceText = `🤖 針對${locationName}的智慧建議：\n\n`;
  adviceText += `💨 空氣品質：AQI ${airQualityData.aqi} (${aqiInfo.level})\n\n`;
  
  if (airQualityData.aqi <= 50) {
    adviceText += '😊 今天非常適合出門！\n\n';
    adviceText += '✅ 建議活動：\n• 戶外運動、慢跑\n• 公園散步\n• 戶外用餐\n• 開窗通風';
  } else if (airQualityData.aqi <= 100) {
    adviceText += '😐 今天可以正常出門\n\n';
    adviceText += '⚠️ 建議注意：\n• 可進行一般戶外活動\n• 敏感族群稍加注意\n• 建議配戴口罩\n• 避免劇烈運動';
  } else if (airQualityData.aqi <= 150) {
    adviceText += '😷 建議減少戶外活動\n\n';
    adviceText += '🚨 特別注意：\n• 敏感族群避免外出\n• 必須配戴N95口罩\n• 選擇室內活動\n• 關閉門窗';
  } else {
    adviceText += '😰 不建議外出\n\n';
    adviceText += '🛑 緊急建議：\n• 所有人避免戶外活動\n• 外出務必配戴防護口罩\n• 關閉門窗開空氣清淨機\n• 注意身體狀況';
  }
  
  const smartAdviceMessage = {
    type: 'text',
    text: adviceText
  };
  
  return client.replyMessage(event.replyToken, smartAdviceMessage);
}

// 處理有狀態的對話
async function handleStatefulMessage(event, userState) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  
  if (userState.state === 'awaiting_compare_cities') {
    clearUserState(userId);
    
    const cities = extractCitiesFromText(userMessage);
    if (cities.length < 2) {
      const errorMessage = createErrorMessage('not_found', '請至少輸入2個城市名稱');
      return client.replyMessage(event.replyToken, errorMessage);
    }
    
    return await handleCityComparison(event, { type: 'compare', cities });
  }
  
  // 清除無效狀態
  clearUserState(userId);
  return await handleTextMessage(event);
}

// 處理其他功能（訂閱、設定等）- 簡化版本
async function handleSubscription(event, queryResult) {
  const simpleMessage = {
    type: 'text',
    text: '🔔 訂閱功能\n\n此功能正在開發中，敬請期待！\n\n💡 您可以先使用其他功能：\n• 查詢空氣品質\n• 比較多個城市\n• 查看附近監測站'
  };
  return client.replyMessage(event.replyToken, simpleMessage);
}

async function handleUnsubscription(event, queryResult) {
  return await handleSubscription(event, queryResult);
}

async function handleListSubscriptions(event) {
  return await handleSubscription(event, {});
}

async function handleSettings(event) {
  const settingsMessage = {
    type: 'text',
    text: '⚙️ 個人設定\n\n設定功能正在開發中！\n\n目前可用功能：\n🔍 即時空氣品質查詢\n📊 多城市比較\n📍 GPS定位查詢\n🤖 智慧建議'
  };
  return client.replyMessage(event.replyToken, settingsMessage);
}

async function handleHelp(event) {
  const helpMessage = {
    type: 'text',
    text: '💡 使用說明\n\n📝 查詢方式：\n• 直接輸入城市名稱\n  例如：「台北空氣品質」\n\n• 比較多個城市\n  例如：「比較台北高雄」\n\n• 智慧建議\n  例如：「今天適合出門嗎？」\n\n• 分享位置查詢附近監測站\n\n🌟 支援城市包括台灣各縣市及國際主要城市'
  };
  return client.replyMessage(event.replyToken, [helpMessage, createMainMenuFlexMessage()]);
}

async function handleUnknownCommand(event) {
  const errorMessage = createErrorMessage('not_found');
  return client.replyMessage(event.replyToken, [errorMessage, createMainMenuFlexMessage()]);
}

// === 路由設定 ===

// 首頁
app.get('/', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.send(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智慧空氣品質機器人 | LINE Bot</title>
    <style>
        body { 
            font-family: 'Segoe UI', sans-serif; 
            background: linear-gradient(-45deg, #667eea, #764ba2, #6b73ff, #9644ff); 
            min-height: 100vh; 
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: white;
            padding: 3rem;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 600px;
            margin: 2rem;
        }
        h1 { color: #333; margin-bottom: 1rem; }
        p { color: #666; margin-bottom: 2rem; line-height: 1.6; }
        .btn {
            display: inline-block;
            background: #4CAF50;
            color: white;
            padding: 15px 30px;
            border-radius: 25px;
            text-decoration: none;
            margin: 0.5rem;
            transition: transform 0.3s ease;
        }
        .btn:hover { transform: translateY(-2px); }
        .status { color: #4CAF50; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌬️ 智慧空氣品質機器人</h1>
        <p class="status">✅ 服務正常運行中</p>
        <p>即時監測空氣品質，守護您和家人的健康</p>
        <a href="https://line.me/R/ti/p/@470kdmxx" class="btn" target="_blank">
            📱 加入 LINE 好友
        </a>
        <a href="/health" class="btn" style="background: #42a5f5;">
            🔧 服務狀態
        </a>
        
        <div style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.9rem; color: #999;">
            <p>🎯 主要功能：即時查詢 | 多城市比較 | 健康建議 | GPS定位</p>
            <p>🌏 支援台灣各縣市及國際主要城市</p>
        </div>
    </div>
</body>
</html>
      `);
    }
  } catch (error) {
    console.error('首頁載入錯誤:', error);
    res.status(500).send('服務暫時不可用');
  }
});

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'LINE智慧空氣品質機器人正常運行',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    features: [
      'real_time_air_quality_query',
      'multi_city_comparison',
      'smart_health_advice',
      'gps_location_query',
      'natural_language_processing'
    ],
    statistics: {
      supported_cities: Object.keys(cityMap).length,
      api_cache_entries: apiCache.size,
      location_cache_entries: locationCache.size,
      active_user_states: userStates.size
    }
  });
});

// API - 空氣品質查詢
app.get('/api/air-quality/:city', async (req, res) => {
  try {
    const city = req.params.city;
    const airQualityData = await getAirQuality(city);
    res.json(airQualityData);
  } catch (error) {
    console.error('API錯誤:', error);
    res.status(500).json({ 
      error: '無法獲取空氣品質數據',
      message: error.message,
      city: req.params.city
    });
  }
});

// API - 統計資訊
app.get('/api/stats', (req, res) => {
  res.json({
    service: {
      name: '智慧空氣品質機器人',
      version: '2.0.0',
      status: 'running'
    },
    statistics: {
      supportedCities: Object.keys(cityMap).length,
      apiCacheEntries: apiCache.size,
      locationCacheEntries: locationCache.size,
      activeUserStates: userStates.size
    },
    features: [
      'real_time_query',
      'multi_city_comparison',
      'smart_advice',
      'gps_location',
      'natural_language_processing'
    ],
    uptime: Math.floor(process.uptime())
  });
});

// Webhook
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook處理錯誤:', err);
      res.status(500).end();
    });
});

// 404處理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: '請求的路由不存在',
    available_routes: ['/', '/health', '/api/air-quality/:city', '/api/stats']
  });
});

// 錯誤處理
app.use((err, req, res, next) => {
  console.error('服務器錯誤:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: '服務暫時不可用'
  });
});

// === 定時任務 ===

// 每5分鐘清理過期緩存
cron.schedule('*/5 * * * *', () => {
  cleanExpiredCache();
  console.log(`緩存清理完成 - API緩存: ${apiCache.size}, 用戶狀態: ${userStates.size}, 位置緩存: ${locationCache.size}`);
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
  console.log(`🚀 智慧空氣品質機器人啟動成功！`);
  console.log(`🌐 服務地址: http://0.0.0.0:${port}`);
  console.log(`📊 支援城市: ${Object.keys(cityMap).length} 個`);
  console.log(`🎯 核心功能已就緒：`);
  console.log(`   ✅ 即時空氣品質查詢`);
  console.log(`   ✅ 多城市比較功能`);
  console.log(`   ✅ 智慧健康建議`);
  console.log(`   ✅ GPS定位查詢`);
  console.log(`   ✅ 自然語言處理`);
  
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
    console.warn('⚠️ 警告：LINE Bot 環境變數未設定');
  } else {
    console.log('✅ LINE Bot 配置完成');
  }
});
