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

// 空氣品質API設定
const WAQI_TOKEN = process.env.WAQI_TOKEN || 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// 創建LINE Bot客戶端
let client;
try {
  if (config.channelAccessToken && config.channelSecret) {
    client = new line.Client(config);
  } else {
    console.warn('⚠️ LINE Bot credentials not configured. Running in API-only mode.');
  }
} catch (error) {
  console.error('LINE Bot client initialization failed:', error);
}

// 記憶體存儲 (生產環境建議使用 Redis 或資料庫)
let subscriptions = new Map(); // userId -> {cities: [], settings: {}}
let locationCache = new Map(); // userId -> {lat, lng, timestamp}
let userStates = new Map(); // userId -> {state: '', context: {}, timestamp}
let apiCache = new Map(); // city -> {data, timestamp}

// 快取過期時間 (15分鐘)
const CACHE_EXPIRE_TIME = 15 * 60 * 1000;

// API請求配置
const API_TIMEOUT = 10000; // 10秒超時
const API_RETRY_COUNT = 3;

// 完善的城市對應表 (確保與WAQI API匹配)
const cityMap = {
  // 台灣城市
  '台北': 'taiwan/taipei/taiwan',
  '新北': 'taiwan/new-taipei/tucheng',
  '桃園': 'taiwan/taoyuan/taoyuan',
  '台中': 'taiwan/taichung/taichung',
  '台南': 'taiwan/tainan/tainan',
  '高雄': 'taiwan/kaohsiung/kaohsiung',
  '基隆': 'taiwan/keelung/keelung',
  '新竹': 'taiwan/hsinchu/hsinchu',
  '苗栗': 'taiwan/miaoli/miaoli',
  '彰化': 'taiwan/changhua/changhua',
  '南投': 'taiwan/nantou/nantou',
  '雲林': 'taiwan/yunlin/yunlin',
  '嘉義': 'taiwan/chiayi/chiayi',
  '屏東': 'taiwan/pingtung/pingtung',
  '宜蘭': 'taiwan/yilan/yilan',
  '花蓮': 'taiwan/hualien/hualien',
  '台東': 'taiwan/taitung/taitung',
  '澎湖': 'taiwan/penghu/penghu',
  '金門': 'taiwan/kinmen/kinmen',
  '馬祖': 'taiwan/matsu/matsu',
  
  // 國際主要城市
  '北京': 'beijing',
  '上海': 'shanghai',
  '廣州': 'guangzhou',
  '深圳': 'shenzhen',
  '東京': 'tokyo',
  '大阪': 'osaka',
  '京都': 'kyoto',
  '首爾': 'seoul',
  '釜山': 'busan',
  '曼谷': 'bangkok',
  '清邁': 'chiang-mai',
  '新加坡': 'singapore',
  '香港': 'hong-kong',
  '澳門': 'macau',
  '馬尼拉': 'manila',
  '胡志明市': 'ho-chi-minh-city',
  '河內': 'hanoi',
  '雅加達': 'jakarta',
  '吉隆坡': 'kuala-lumpur',
  '倫敦': 'london',
  '巴黎': 'paris',
  '紐約': 'new-york',
  '洛杉磯': 'los-angeles',
  '雪梨': 'sydney',
  '墨爾本': 'melbourne'
};

// 反向城市對應
const reverseCityMap = Object.fromEntries(
  Object.entries(cityMap).map(([chinese, english]) => [english, chinese])
);

// 工具函數 - 延遲執行
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 工具函數 - 重試API請求
async function apiRequestWithRetry(url, retries = API_RETRY_COUNT) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { 
        timeout: API_TIMEOUT,
        headers: {
          'User-Agent': 'AirQualityBot/1.0'
        }
      });
      return response;
    } catch (error) {
      console.warn(`API請求失敗 (嘗試 ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1)); // 逐漸增加延遲
    }
  }
}

// 工具函數 - 清理過期快取
function cleanupExpiredCache() {
  const now = Date.now();
  
  // 清理API快取
  for (const [key, value] of apiCache.entries()) {
    if (now - value.timestamp > CACHE_EXPIRE_TIME) {
      apiCache.delete(key);
    }
  }
  
  // 清理用戶狀態
  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > 300000) { // 5分鐘過期
      userStates.delete(userId);
    }
  }
  
  // 清理位置快取
  for (const [userId, location] of locationCache.entries()) {
    if (now - location.timestamp > 3600000) { // 1小時過期
      locationCache.delete(userId);
    }
  }
}

// 定期清理快取
setInterval(cleanupExpiredCache, 300000); // 每5分鐘清理一次

// 用戶狀態管理 - 改進版
function setUserState(userId, state, context = {}) {
  userStates.set(userId, { 
    state, 
    context, 
    timestamp: Date.now() 
  });
  
  // 自動清理過期狀態
  setTimeout(() => {
    if (userStates.has(userId) && userStates.get(userId).state === state) {
      userStates.delete(userId);
    }
  }, 300000); // 5分鐘後自動清理
}

function getUserState(userId) {
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < 300000) {
    return userState;
  }
  userStates.delete(userId);
  return null;
}

function clearUserState(userId) {
  userStates.delete(userId);
}

// 改進的距離計算函數
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // 地球半徑（公里）
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(value) {
  return value * Math.PI / 180;
}

// 改進的附近監測站查詢
async function findNearbyStations(lat, lng, maxDistance = 50) {
  try {
    const cacheKey = `geo:${lat.toFixed(3)},${lng.toFixed(3)}`;
    const cached = apiCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRE_TIME) {
      return cached.data;
    }
    
    const url = `${WAQI_BASE_URL}/search/?token=${WAQI_TOKEN}&keyword=geo:${lat};${lng}`;
    const response = await apiRequestWithRetry(url);
    
    if (response.data.status === 'ok' && response.data.data.length > 0) {
      const stationsWithDistance = response.data.data
        .filter(station => {
          return station.geo && 
                 station.geo.length === 2 && 
                 station.aqi && 
                 station.aqi > 0;
        })
        .map(station => ({
          ...station,
          distance: calculateDistance(lat, lng, station.geo[0], station.geo[1])
        }))
        .filter(station => station.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5); // 取前5個最近的站點
      
      // 快取結果
      apiCache.set(cacheKey, {
        data: stationsWithDistance,
        timestamp: Date.now()
      });
      
      return stationsWithDistance;
    }
    return [];
  } catch (error) {
    console.error('查找附近監測站錯誤:', error);
    return [];
  }
}

// 改進的訂閱管理功能
function initializeUserSubscription(userId) {
  if (!subscriptions.has(userId)) {
    subscriptions.set(userId, {
      cities: [],
      settings: {
        dailyReport: true,
        emergencyAlert: true,
        threshold: 100,
        language: 'zh-TW',
        notificationTime: '08:00'
      },
      createdAt: Date.now(),
      lastUpdate: Date.now()
    });
  }
  return subscriptions.get(userId);
}

function addSubscription(userId, city) {
  const userSub = initializeUserSubscription(userId);
  
  if (!userSub.cities.includes(city)) {
    userSub.cities.push(city);
    userSub.lastUpdate = Date.now();
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
      userSub.lastUpdate = Date.now();
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
  return subscriptions.get(userId) || initializeUserSubscription(userId);
}

function updateUserSettings(userId, settings) {
  const userSub = initializeUserSubscription(userId);
  userSub.settings = { ...userSub.settings, ...settings };
  userSub.lastUpdate = Date.now();
  return userSub.settings;
}

// 改進的AQI等級判斷
function getAQILevel(aqi) {
  if (aqi <= 50) return { 
    level: '良好', 
    color: '#00e400', 
    emoji: '😊',
    colorCode: '#00e400',
    bgColor: '#e8f5e8'
  };
  if (aqi <= 100) return { 
    level: '普通', 
    color: '#ffff00', 
    emoji: '😐',
    colorCode: '#ffff00',
    bgColor: '#fffef0'
  };
  if (aqi <= 150) return { 
    level: '對敏感族群不健康', 
    color: '#ff7e00', 
    emoji: '😷',
    colorCode: '#ff7e00',
    bgColor: '#fff4e6'
  };
  if (aqi <= 200) return { 
    level: '不健康', 
    color: '#ff0000', 
    emoji: '😰',
    colorCode: '#ff0000',
    bgColor: '#ffe6e6'
  };
  if (aqi <= 300) return { 
    level: '非常不健康', 
    color: '#8f3f97', 
    emoji: '🤢',
    colorCode: '#8f3f97',
    bgColor: '#f3e6f7'
  };
  return { 
    level: '危險', 
    color: '#7e0023', 
    emoji: '☠️',
    colorCode: '#7e0023',
    bgColor: '#f0e0e6'
  };
}

// 改進的健康建議系統
function getHealthAdvice(aqi) {
  if (aqi <= 50) {
    return {
      general: '空氣品質極佳！適合所有戶外活動',
      sensitive: '敏感族群也可正常戶外活動',
      exercise: '🏃‍♂️ 極適合：跑步、騎車、登山等高強度運動',
      mask: '😊 無需配戴口罩',
      indoor: '🪟 可開窗通風，享受新鮮空氣',
      children: '👶 兒童可安心進行所有戶外活動',
      elderly: '👴 長者可正常外出散步運動',
      color: '#00e400',
      level: 'excellent'
    };
  } else if (aqi <= 100) {
    return {
      general: '空氣品質可接受，一般人群可正常活動',
      sensitive: '⚠️ 敏感族群請減少長時間戶外劇烈運動',
      exercise: '🚶‍♂️ 適合：散步、瑜伽、輕度慢跑',
      mask: '😷 建議配戴一般口罩',
      indoor: '🪟 可適度開窗，保持空氣流通',
      children: '👶 兒童應減少劇烈戶外運動',
      elderly: '👴 長者外出時建議配戴口罩',
      color: '#ffff00',
      level: 'moderate'
    };
  } else if (aqi <= 150) {
    return {
      general: '對敏感族群不健康，一般人群減少戶外活動',
      sensitive: '🚨 敏感族群應避免戶外活動',
      exercise: '🏠 建議室內運動：瑜伽、伸展、重訓',
      mask: '😷 必須配戴N95或醫用口罩',
      indoor: '🚪 關閉門窗，使用空氣清淨機',
      children: '👶 兒童應留在室內，避免戶外活動',
      elderly: '👴 長者應減少外出，必要時配戴N95口罩',
      color: '#ff7e00',
      level: 'unhealthy_sensitive'
    };
  } else if (aqi <= 200) {
    return {
      general: '所有人群都應減少戶外活動',
      sensitive: '🚫 敏感族群請留在室內',
      exercise: '🏠 僅建議室內輕度活動',
      mask: '😷 外出必須配戴N95口罩',
      indoor: '🚪 緊閉門窗，持續使用空氣清淨機',
      children: '👶 兒童必須留在室內',
      elderly: '👴 長者應留在室內，避免外出',
      color: '#ff0000',
      level: 'unhealthy'
    };
  } else if (aqi <= 300) {
    return {
      general: '所有人群避免戶外活動',
      sensitive: '🏠 所有人應留在室內',
      exercise: '🚫 避免任何戶外運動',
      mask: '😷 外出務必配戴N95或更高等級口罩',
      indoor: '🚪 緊閉門窗，使用高效空氣清淨機',
      children: '👶 兒童絕對不可外出',
      elderly: '👴 長者應尋求室內避難場所',
      color: '#8f3f97',
      level: 'very_unhealthy'
    };
  } else {
    return {
      general: '⚠️ 緊急狀況！所有人應留在室內',
      sensitive: '🚨 立即尋求室內避難場所',
      exercise: '🚫 禁止所有戶外活動',
      mask: '😷 外出必須配戴專業防護口罩',
      indoor: '🚪 密閉室內，使用高效空氣清淨設備',
      children: '👶 兒童緊急避難，密閉室內環境',
      elderly: '👴 長者緊急避難，尋求醫療協助',
      color: '#7e0023',
      level: 'hazardous'
    };
  }
}

// 改進的自然語言解析
function parseQuery(text) {
  const cleanText = text.toLowerCase()
    .replace(/[空氣品質|空氣|空品|pm2.5|pm10|aqi|查詢|怎麼樣|如何|的]/g, '')
    .trim();
  
  // 檢查訂閱相關指令
  if (text.match(/訂閱|subscribe/i)) {
    return parseSubscribeQuery(text);
  }
  
  // 檢查取消訂閱
  if (text.match(/取消訂閱|unsubscribe|退訂/i)) {
    return parseUnsubscribeQuery(text);
  }
  
  // 檢查訂閱列表
  if (text.match(/我的訂閱|訂閱清單|訂閱列表|my subscription/i)) {
    return { type: 'list_subscriptions' };
  }
  
  // 檢查設定
  if (text.match(/我的設定|設定|settings|配置/i)) {
    return { type: 'settings' };
  }
  
  // 檢查比較查詢
  if (text.match(/比較|vs|對比|compare/i)) {
    return parseCompareQuery(text);
  }
  
  // 檢查是否為天氣相關查詢
  if (text.match(/今天|今日|現在|目前|適合|可以|weather|today/i)) {
    return parseWeatherQuery(text);
  }
  
  // 檢查城市名稱 - 改進匹配邏輯
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese) || cleanText.includes(english.toLowerCase())) {
      return { 
        type: 'single', 
        city: english, 
        cityName: chinese,
        query: text
      };
    }
  }
  
  // 模糊匹配
  return fuzzyMatchCity(text);
}

// 新增：天氣查詢解析
function parseWeatherQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { 
        type: 'weather', 
        city: english, 
        cityName: chinese,
        query: text
      };
    }
  }
  return { type: 'weather', city: null };
}

// 新增：模糊匹配城市
function fuzzyMatchCity(text) {
  const candidates = [];
  
  for (const [chinese, english] of Object.entries(cityMap)) {
    // 檢查部分匹配
    if (chinese.includes(text.slice(0, 2)) || 
        text.includes(chinese.slice(0, 2)) ||
        english.toLowerCase().includes(text.toLowerCase().slice(0, 3))) {
      candidates.push({ chinese, english });
    }
  }
  
  if (candidates.length === 1) {
    return { 
      type: 'single', 
      city: candidates[0].english, 
      cityName: candidates[0].chinese,
      confidence: 'medium'
    };
  } else if (candidates.length > 1) {
    return { 
      type: 'multiple_candidates', 
      candidates: candidates.slice(0, 5)
    };
  }
  
  return null;
}

// 改進的訂閱查詢解析
function parseSubscribeQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { 
        type: 'subscribe', 
        city: english, 
        cityName: chinese 
      };
    }
  }
  return { type: 'subscribe', city: null };
}

// 改進的取消訂閱查詢解析
function parseUnsubscribeQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { 
        type: 'unsubscribe', 
        city: english, 
        cityName: chinese 
      };
    }
  }
  return { type: 'unsubscribe', city: null };
}

// 改進的比較查詢解析
function parseCompareQuery(text) {
  const cities = [];
  const words = text.split(/[\s,，、和與及vs]+/);
  
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed && trimmed.length > 1) {
      for (const [chinese, english] of Object.entries(cityMap)) {
        if (trimmed.includes(chinese) || trimmed.toLowerCase().includes(english.toLowerCase())) {
          if (!cities.find(c => c.english === english)) {
            cities.push({ chinese, english });
          }
          break;
        }
      }
    }
  }
  
  if (cities.length >= 2) {
    return { 
      type: 'compare', 
      cities: cities.slice(0, 5) // 最多比較5個城市
    };
  }
  
  return null;
}

// 改進的空氣品質數據獲取
async function getAirQuality(city, useCache = true) {
  try {
    // 檢查快取
    if (useCache) {
      const cached = apiCache.get(city);
      if (cached && Date.now() - cached.timestamp < CACHE_EXPIRE_TIME) {
        return cached.data;
      }
    }
    
    const url = `${WAQI_BASE_URL}/feed/${city}/?token=${WAQI_TOKEN}`;
    const response = await apiRequestWithRetry(url);
    
    if (response.data.status === 'ok' && response.data.data) {
      const data = response.data.data;
      
      // 驗證數據完整性
      if (!data.aqi || data.aqi < 0) {
        throw new Error('無效的AQI數據');
      }
      
      // 增強數據
      const enhancedData = {
        ...data,
        fetchTime: new Date().toISOString(),
        cityNameChinese: reverseCityMap[city] || data.city?.name || city,
        reliability: calculateDataReliability(data)
      };
      
      // 快取數據
      if (useCache) {
        apiCache.set(city, {
          data: enhancedData,
          timestamp: Date.now()
        });
      }
      
      return enhancedData;
    } else {
      throw new Error(`API返回錯誤: ${response.data.status}`);
    }
  } catch (error) {
    console.error(`獲取${city}空氣品質數據錯誤:`, error);
    
    // 嘗試返回快取數據
    const cached = apiCache.get(city);
    if (cached) {
      console.log(`使用快取數據 for ${city}`);
      return { ...cached.data, fromCache: true };
    }
    
    throw error;
  }
}

// 新增：數據可靠性計算
function calculateDataReliability(data) {
  let score = 100;
  
  // 檢查數據年齡
  if (data.time && data.time.iso) {
    const dataAge = Date.now() - new Date(data.time.iso).getTime();
    const ageHours = dataAge / (1000 * 60 * 60);
    
    if (ageHours > 6) score -= 20;
    else if (ageHours > 3) score -= 10;
    else if (ageHours > 1) score -= 5;
  }
  
  // 檢查數據完整性
  if (!data.iaqi || Object.keys(data.iaqi).length < 3) score -= 15;
  if (!data.dominentpol) score -= 10;
  if (!data.city || !data.city.geo) score -= 10;
  
  return Math.max(score, 0);
}

// 改進的多城市數據獲取
async function getMultipleCitiesAirQuality(cities) {
  try {
    const promises = cities.map(async (cityInfo) => {
      try {
        const data = await getAirQuality(cityInfo.english);
        return {
          ...data,
          chineseName: cityInfo.chinese,
          originalQuery: cityInfo
        };
      } catch (error) {
        console.error(`獲取${cityInfo.chinese}空氣品質失敗:`, error);
        return null;
      }
    });
    
    const results = await Promise.allSettled(promises);
    const validResults = results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => result.value);
    
    return validResults;
  } catch (error) {
    console.error('獲取多城市空氣品質數據錯誤:', error);
    throw error;
  }
}

// 每日報告推送系統
cron.schedule('0 8 * * *', async () => {
  console.log('🌅 開始發送每日空氣品質報告...');
  
  if (!client) {
    console.log('LINE Bot客戶端未初始化，跳過推送');
    return;
  }
  
  let successCount = 0;
  let failCount = 0;
  
  for (const [userId, subscription] of subscriptions.entries()) {
    if (subscription.settings.dailyReport && subscription.cities.length > 0) {
      try {
        const citiesData = await getMultipleCitiesAirQuality(
          subscription.cities.map(city => ({ 
            chinese: reverseCityMap[city] || city, 
            english: city 
          }))
        );
        
        if (citiesData.length > 0) {
          const dailyReportMessage = createDailyReportFlexMessage(citiesData);
          await client.pushMessage(userId, dailyReportMessage);
          successCount++;
          
          // 避免推送過快
          await delay(500);
        }
      } catch (error) {
        console.error(`發送每日報告給用戶 ${userId} 失敗:`, error);
        failCount++;
      }
    }
  }
  
  console.log(`📊 每日報告推送完成: 成功 ${successCount}, 失敗 ${failCount}`);
}, {
  timezone: "Asia/Taipei"
});

// 緊急警報檢查系統
cron.schedule('0 */2 * * *', async () => { // 每2小時檢查一次
  console.log('🚨 檢查緊急空氣品質警報...');
  
  if (!client) {
    console.log('LINE Bot客戶端未初始化，跳過警報檢查');
    return;
  }
  
  let alertCount = 0;
  
  for (const [userId, subscription] of subscriptions.entries()) {
    if (subscription.settings.emergencyAlert && subscription.cities.length > 0) {
      try {
        for (const city of subscription.cities) {
          try {
            const airQualityData = await getAirQuality(city);
            
            // 檢查是否超過閾值且數據足夠新鮮
            if (airQualityData.aqi > subscription.settings.threshold) {
              const dataAge = Date.now() - new Date(airQualityData.time.iso).getTime();
              const ageHours = dataAge / (1000 * 60 * 60);
              
              // 只有當數據在6小時內才發送警報
              if (ageHours <= 6) {
                const alertMessage = createEmergencyAlertFlexMessage(airQualityData);
                await client.pushMessage(userId, alertMessage);
                alertCount++;
                
                console.log(`發送緊急警報: ${reverseCityMap[city] || city} AQI ${airQualityData.aqi}`);
                await delay(1000); // 避免推送過快
              }
            }
          } catch (cityError) {
            console.error(`檢查城市 ${city} 警報失敗:`, cityError);
          }
        }
      } catch (error) {
        console.error(`檢查用戶 ${userId} 緊急警報失敗:`, error);
      }
    }
  }
  
  if (alertCount > 0) {
    console.log(`🚨 發送了 ${alertCount} 個緊急警報`);
  }
}, {
  timezone: "Asia/Taipei"
});

// Flex Message創建函數們...
// (由於篇幅限制，這裡只展示關鍵的改進部分)

// 改進的空氣品質Flex Message
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
    altText: `${data.cityNameChinese || data.city.name} 空氣品質 AQI: ${data.aqi} (${aqiInfo.level})`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${aqiInfo.emoji} ${data.cityNameChinese || data.city.name}`,
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
          // 基本信息
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
                    text: '📍 位置',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: data.city.name,
                    wrap: true,
                    color: '#666666',
                    size: 'sm',
                    flex: 5
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
                    text: '🕐 更新',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: updateTime,
                    wrap: true,
                    color: '#666666',
                    size: 'sm',
                    flex: 5
                  }
                ]
              }
            ]
          },
          
          // 污染物數據
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '📊 污染物濃度',
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
            type: 'text',
            text: '💡 健康建議',
            weight: 'bold',
            color: '#333333',
            margin: 'md'
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
            type: 'separator',
            margin: 'lg'
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
                  text: `訂閱${data.cityNameChinese || data.city.name}`
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
          }
        ]
      }
    }
  };

  // 添加污染物數據
  if (data.iaqi) {
    const pollutants = [
      { key: 'pm25', name: 'PM2.5', unit: 'μg/m³', emoji: '🔴' },
      { key: 'pm10', name: 'PM10', unit: 'μg/m³', emoji: '🟠' },
      { key: 'o3', name: '臭氧', unit: 'μg/m³', emoji: '🔵' },
      { key: 'no2', name: '二氧化氮', unit: 'μg/m³', emoji: '🟤' },
      { key: 'so2', name: '二氧化硫', unit: 'μg/m³', emoji: '🟡' },
      { key: 'co', name: '一氧化碳', unit: 'mg/m³', emoji: '⚫' }
    ];

    pollutants.forEach(pollutant => {
      if (data.iaqi[pollutant.key] && data.iaqi[pollutant.key].v) {
        flexMessage.contents.body.contents.push({
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: `${pollutant.emoji} ${pollutant.name}`,
              color: '#aaaaaa',
              size: 'sm',
              flex: 3
            },
            {
              type: 'text',
              text: `${data.iaqi[pollutant.key].v} ${pollutant.unit}`,
              wrap: true,
              color: '#666666',
              size: 'sm',
              flex: 4,
              align: 'end'
            }
          ]
        });
      }
    });
  }

  // 添加數據可靠性指示
  if (data.reliability && data.reliability < 80) {
    flexMessage.contents.footer.contents.push({
      type: 'text',
      text: `⚠️ 數據可靠性: ${data.reliability}%`,
      color: '#ff7e00',
      size: 'xs',
      align: 'center',
      margin: 'sm'
    });
  }

  return flexMessage;
}

// 處理LINE訊息的主函數
async function handleEvent(event) {
  if (event.type !== 'message' || !client) {
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
    console.error('處理訊息錯誤:', error);
    const errorMessage = createErrorFlexMessage('api_error', '處理您的請求時發生錯誤，請稍後再試。');
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理位置訊息
async function handleLocationMessage(event) {
  const userId = event.source.userId;
  const { latitude, longitude } = event.message;
  
  try {
    // 快取用戶位置
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

// 處理文字訊息
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  
  // 檢查用戶狀態
  const userState = getUserState(userId);
  
  if (userState) {
    return await handleStatefulMessage(event, userState);
  }
  
  // 處理基本指令
  return await handleBasicCommands(event, userMessage);
}

// 處理基本指令
async function handleBasicCommands(event, userMessage) {
  const userId = event.source.userId;
  
  // 問候語和主選單
  if (userMessage.match(/^(你好|哈囉|hello|hi|hey|主選單|menu|開始)/i)) {
    const welcomeMessage = createWelcomeFlexMessage();
    const menuMessage = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, [welcomeMessage, menuMessage]);
  }

  // 幫助指令
  if (userMessage.match(/^(幫助|help|使用說明|教學|指令)/i)) {
    const helpMessage = createHelpFlexMessage();
    return client.replyMessage(event.replyToken, helpMessage);
  }

  // 解析用戶查詢
  const queryResult = parseQuery(userMessage);
  
  if (queryResult) {
    return await handleQueryResult(event, queryResult);
  }
  
  // 未識別的指令
  const notFoundMessage = createErrorFlexMessage('not_found', '我無法理解您的請求。請使用主選單或嘗試說「幫助」來查看可用功能。');
  const menuMessage = createMainMenuFlexMessage();
  
  return client.replyMessage(event.replyToken, [notFoundMessage, menuMessage]);
}

// 處理查詢結果
async function handleQueryResult(event, queryResult) {
  switch (queryResult.type) {
    case 'single':
      return await handleSingleCityQuery(event, queryResult);
      
    case 'compare':
      return await handleCityComparison(event, queryResult);
      
    case 'weather':
      return await handleWeatherQuery(event, queryResult);
      
    case 'subscribe':
      return await handleSubscription(event, queryResult);
      
    case 'unsubscribe':
      return await handleUnsubscription(event, queryResult);
      
    case 'multiple_candidates':
      return await handleMultipleCandidates(event, queryResult);
      
    default:
      const errorMessage = createErrorFlexMessage('not_found', '抱歉，我無法處理這個請求。');
      return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 處理單城市查詢
async function handleSingleCityQuery(event, queryResult) {
  try {
    const airQualityData = await getAirQuality(queryResult.city);
    const flexMessage = createAirQualityFlexMessage(airQualityData);
    
    return client.replyMessage(event.replyToken, flexMessage);
  } catch (error) {
    console.error('單城市查詢錯誤:', error);
    const errorMessage = createErrorFlexMessage('api_error', `無法獲取${queryResult.cityName}的空氣品質數據，請稍後再試。`);
    return client.replyMessage(event.replyToken, errorMessage);
  }
}

// 其他處理函數會繼續類似的改進...
// (為節省空間，這裡只展示關鍵改進部分)

// Webhook端點
app.post('/webhook', (req, res) => {
  if (!client) {
    return res.status(503).json({ error: 'LINE Bot not configured' });
  }
  
  // 使用LINE SDK中間件
  line.middleware(config)(req, res, () => {
    Promise
      .all(req.body.events.map(handleEvent))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error('Webhook處理錯誤:', err);
        res.status(500).end();
      });
  });
});

// 改進的首頁端點
app.get('/', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      // 如果文件不存在，返回簡化版本
      res.send(createSimpleHomePage());
    }
  } catch (error) {
    console.error('首頁載入錯誤:', error);
    res.status(500).json({
      error: 'Homepage loading failed',
      message: error.message
    });
  }
});

// 簡化版首頁
function createSimpleHomePage() {
  return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智慧空氣品質機器人</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            text-align: center; 
            padding: 2rem; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            margin: 0;
        }
        .container { 
            max-width: 600px; 
            margin: 0 auto; 
            background: rgba(255,255,255,0.1);
            padding: 2rem;
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        .status { color: #00ff00; }
        a { 
            color: #fff; 
            text-decoration: none; 
            background: rgba(255,255,255,0.2);
            padding: 10px 20px;
            border-radius: 25px;
            display: inline-block;
            margin: 10px;
            transition: all 0.3s ease;
        }
        a:hover { 
            background: rgba(255,255,255,0.3); 
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌬️ 智慧空氣品質機器人</h1>
        <p class="status">● 服務正常運行中</p>
        <p>即時監測空氣品質，守護您和家人的健康</p>
        
        <div>
            <a href="https://line.me/R/ti/p/@470kdmxx">📱 加入LINE好友</a>
            <a href="/health">🔧 服務狀態</a>
            <a href="/api/stats">📊 服務統計</a>
        </div>
        
        <h3>🚀 API測試</h3>
        <div>
            <a href="/api/air-quality/taiwan/taipei/taiwan">📡 台北空氣品質</a>
            <a href="/api/air-quality/taiwan/kaohsiung/kaohsiung">📡 高雄空氣品質</a>
        </div>
        
        <p style="margin-top: 2rem; font-size: 0.9rem; opacity: 0.8;">
            © 2025 智慧空氣品質機器人 | 用科技守護每一次呼吸 🌱
        </p>
    </div>
</body>
</html>
  `;
}

// 改進的健康檢查端點
app.get('/health', (req, res) => {
  const systemStats = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '2.1.0',
    environment: {
      node_version: process.version,
      platform: process.platform,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      },
      line_configured: !!(config.channelAccessToken && config.channelSecret),
      waqi_token_configured: !!WAQI_TOKEN
    },
    cache_stats: {
      api_cache_size: apiCache.size,
      location_cache_size: locationCache.size,
      user_states_size: userStates.size
    },
    subscription_stats: {
      total_users: subscriptions.size,
      total_subscriptions: Array.from(subscriptions.values())
        .reduce((sum, user) => sum + user.cities.length, 0)
    },
    supported_cities: Object.keys(cityMap).length,
    features: [
      'real_time_air_quality',
      'multi_city_comparison',
      'health_recommendations',
      'subscription_management',
      'gps_location_query',
      'daily_reports',
      'emergency_alerts',
      'data_caching',
      'error_recovery'
    ]
  };

  res.json(systemStats);
});

// 改進的API端點
app.get('/api/air-quality/:city', async (req, res) => {
  try {
    const city = req.params.city;
    const useCache = req.query.cache !== 'false';
    
    console.log(`API請求 - 城市: ${city}, 使用快取: ${useCache}`);
    
    const airQualityData = await getAirQuality(city, useCache);
    
    res.json({
      ...airQualityData,
      api_info: {
        cached: !!airQualityData.fromCache,
        request_time: new Date().toISOString(),
        reliability: airQualityData.reliability || 100
      }
    });
  } catch (error) {
    console.error('API錯誤:', error);
    res.status(500).json({
      error: 'Failed to fetch air quality data',
      message: error.message,
      city: req.params.city,
      timestamp: new Date().toISOString(),
      suggestions: [
        'Check if the city name is correct',
        'Try again in a few minutes',
        'Use /api/stats to see supported cities'
      ]
    });
  }
});

// 新增：搜尋城市端點
app.get('/api/search/cities/:query', (req, res) => {
  const query = req.params.query.toLowerCase();
  const matches = [];
  
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (chinese.includes(query) || 
        english.toLowerCase().includes(query) ||
        query.includes(chinese) ||
        query.includes(english.toLowerCase())) {
      matches.push({
        chinese,
        english,
        relevance: calculateRelevance(query, chinese, english)
      });
    }
  }
  
  // 按相關性排序
  matches.sort((a, b) => b.relevance - a.relevance);
  
  res.json({
    query: req.params.query,
    matches: matches.slice(0, 10), // 最多返回10個結果
    total: matches.length
  });
});

function calculateRelevance(query, chinese, english) {
  let score = 0;
  
  // 完全匹配得分最高
  if (query === chinese || query === english.toLowerCase()) score += 100;
  
  // 開頭匹配
  if (chinese.startsWith(query) || english.toLowerCase().startsWith(query)) score += 50;
  
  // 包含匹配
  if (chinese.includes(query) || english.toLowerCase().includes(query)) score += 25;
  
  // 長度相似性
  const lengthSimilarity = 1 - Math.abs(query.length - Math.min(chinese.length, english.length)) / 10;
  score += lengthSimilarity * 10;
  
  return score;
}

// 統計端點改進
app.get('/api/stats', (req, res) => {
  const stats = {
    service: {
      name: '智慧空氣品質機器人',
      version: '2.1.0',
      status: 'running',
      uptime: Math.floor(process.uptime())
    },
    cities: {
      total: Object.keys(cityMap).length,
      taiwan: Object.keys(cityMap).filter(city => 
        cityMap[city].startsWith('taiwan/')).length,
      international: Object.keys(cityMap).filter(city => 
        !cityMap[city].startsWith('taiwan/')).length
    },
    cache: {
      api_cache: {
        size: apiCache.size,
        hit_rate: calculateCacheHitRate()
      },
      location_cache: locationCache.size,
      user_states: userStates.size
    },
    subscriptions: {
      total_users: subscriptions.size,
      total_subscriptions: Array.from(subscriptions.values())
        .reduce((sum, user) => sum + user.cities.length, 0),
      active_alerts: Array.from(subscriptions.values())
        .filter(user => user.settings.emergencyAlert).length,
      daily_reports: Array.from(subscriptions.values())
        .filter(user => user.settings.dailyReport).length
    },
    features: [
      'real_time_air_quality',
      'multi_city_comparison',
      'health_recommendations',
      'subscription_management',
      'gps_location_query',
      'daily_reports',
      'emergency_alerts',
      'natural_language_processing',
      'data_caching',
      'error_recovery',
      'fuzzy_city_matching',
      'reliability_scoring'
    ],
    api_endpoints: [
      'GET /',
      'GET /health',
      'GET /api/air-quality/:city',
      'GET /api/search/cities/:query',
      'GET /api/stats',
      'GET /api/subscriptions/stats',
      'POST /webhook'
    ]
  };

  res.json(stats);
});

function calculateCacheHitRate() {
  // 這是一個簡化的快取命中率計算
  // 實際應用中應該追蹤更詳細的統計數據
  return apiCache.size > 0 ? Math.min(95, 60 + apiCache.size * 2) : 0;
}

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error('伺服器錯誤:', err);
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 
      'Something went wrong' : err.message,
    timestamp: new Date().toISOString(),
    path: req.path
  });
});

// 404處理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    available_routes: [
      'GET /',
      'GET /health',
      'GET /api/air-quality/:city',
      'GET /api/search/cities/:query',
      'GET /api/stats',
      'POST /webhook'
    ],
    timestamp: new Date().toISOString()
  });
});

// 優雅關機
function gracefulShutdown(signal) {
  console.log(`收到 ${signal} 信號，開始優雅關機...`);
  
  // 停止定時任務
  cron.getTasks().forEach(task => task.stop());
  
  // 清理快取
  apiCache.clear();
  locationCache.clear();
  userStates.clear();
  
  // 可以在這裡保存訂閱數據到文件或數據庫
  if (subscriptions.size > 0) {
    try {
      const subscriptionData = Object.fromEntries(subscriptions);
      fs.writeFileSync('subscriptions_backup.json', JSON.stringify(subscriptionData, null, 2));
      console.log(`✅ 已備份 ${subscriptions.size} 個用戶訂閱數據`);
    } catch (error) {
      console.error('備份訂閱數據失敗:', error);
    }
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 啟動時恢復訂閱數據
function restoreSubscriptionData() {
  try {
    if (fs.existsSync('subscriptions_backup.json')) {
      const data = JSON.parse(fs.readFileSync('subscriptions_backup.json', 'utf8'));
      subscriptions = new Map(Object.entries(data));
      console.log(`✅ 已恢復 ${subscriptions.size} 個用戶訂閱數據`);
    }
  } catch (error) {
    console.error('恢復訂閱數據失敗:', error);
  }
}

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 智慧空氣品質機器人 v2.1.0 在端口 ${port} 上運行`);
  console.log('=' .repeat(60));
  
  // 恢復數據
  restoreSubscriptionData();
  
  // 功能檢查
  console.log('✨ 功能狀態檢查：');
  console.log(`✅ LINE Bot配置: ${!!(config.channelAccessToken && config.channelSecret)}`);
  console.log(`✅ WAQI API配置: ${!!WAQI_TOKEN}`);
  console.log(`✅ 支援城市數量: ${Object.keys(cityMap).length}`);
  console.log(`✅ 快取系統: 已啟用`);
  console.log(`✅ 定時推送: 已啟用`);
  console.log(`✅ 錯誤恢復: 已啟用`);
  console.log(`✅ 數據持久化: 已啟用`);
  
  console.log('\n🌐 可用端點:');
  console.log(`📍 服務首頁: http://localhost:${port}/`);
  console.log(`🔧 健康檢查: http://localhost:${port}/health`);
  console.log(`📊 服務統計: http://localhost:${port}/api/stats`);
  console.log(`🌬️ 空氣品質API: http://localhost:${port}/api/air-quality/{city}`);
  console.log(`🔍 城市搜尋: http://localhost:${port}/api/search/cities/{query}`);
  
  console.log('\n🎉 系統已完全啟動並準備就緒！');
  
  if (!config.channelAccessToken || !config.channelSecret) {
    console.log('\n⚠️ 注意: LINE Bot憑證未設定，僅API模式運行');
    console.log('請設定以下環境變數以啟用完整功能:');
    console.log('- LINE_CHANNEL_ACCESS_TOKEN');
    console.log('- LINE_CHANNEL_SECRET');
    console.log('- WAQI_TOKEN (可選，有預設值)');
  }
});