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
const WAQI_TOKEN = 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// 創建LINE Bot客戶端
const client = new line.Client(config);

// 訂閱管理（在實際部署中建議使用資料庫）
let subscriptions = new Map(); // userId -> {cities: [], settings: {}}
let locationCache = new Map(); // userId -> {lat, lng, timestamp}
let userStates = new Map(); // userId -> {state: 'awaiting_city', context: {}}

// 城市對應表
const cityMap = {
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
  '北京': 'beijing',
  '上海': 'shanghai',
  '東京': 'tokyo',
  '首爾': 'seoul',
  '曼谷': 'bangkok',
  '新加坡': 'singapore',
  '香港': 'hong-kong',
  '澳門': 'macau'
};

// 用戶狀態管理
function setUserState(userId, state, context = {}) {
  userStates.set(userId, { state, context, timestamp: Date.now() });
}

function getUserState(userId) {
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < 300000) { // 5分鐘過期
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
  const R = 6371; // 地球半徑（公里）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// 根據位置查找附近的監測站
async function findNearbyStations(lat, lng) {
  try {
    const url = `${WAQI_BASE_URL}/search/?token=${WAQI_TOKEN}&keyword=geo:${lat};${lng}`;
    const response = await axios.get(url);
    
    if (response.data.status === 'ok' && response.data.data.length > 0) {
      // 計算距離並排序
      const stationsWithDistance = response.data.data
        .filter(station => station.geo && station.geo.length === 2)
        .map(station => ({
          ...station,
          distance: calculateDistance(lat, lng, station.geo[0], station.geo[1])
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3); // 取前3個最近的站點
      
      return stationsWithDistance;
    }
    return [];
  } catch (error) {
    console.error('查找附近監測站錯誤:', error);
    return [];
  }
}

// 訂閱管理功能
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
  return subscriptions.get(userId) || { cities: [], settings: {} };
}

function updateUserSettings(userId, settings) {
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
  return userSub.settings;
}

// 每日定時推送空氣品質報告（每天早上8點）
cron.schedule('0 8 * * *', async () => {
  console.log('開始發送每日空氣品質報告...');
  
  for (const [userId, subscription] of subscriptions.entries()) {
    if (subscription.settings.dailyReport && subscription.cities.length > 0) {
      try {
        // 為用戶訂閱的城市創建報告
        const cityData = await getMultipleCitiesAirQuality(
          subscription.cities.map(city => ({ chinese: city, english: city }))
        );
        
        if (cityData.length > 0) {
          const dailyReportMessage = createDailyReportFlexMessage(cityData);
          await client.pushMessage(userId, dailyReportMessage);
        }
      } catch (error) {
        console.error(`發送每日報告給用戶 ${userId} 失敗:`, error);
      }
    }
  }
}, {
  timezone: "Asia/Taipei"
});

// 檢查緊急警報（每小時檢查一次）
cron.schedule('0 * * * *', async () => {
  for (const [userId, subscription] of subscriptions.entries()) {
    if (subscription.settings.emergencyAlert && subscription.cities.length > 0) {
      try {
        for (const city of subscription.cities) {
          const airQualityData = await getAirQuality(city);
          
          // 如果AQI超過用戶設定的閾值，發送警報
          if (airQualityData.aqi > subscription.settings.threshold) {
            const alertMessage = createEmergencyAlertFlexMessage(airQualityData);
            await client.pushMessage(userId, alertMessage);
          }
        }
      } catch (error) {
        console.error(`檢查緊急警報給用戶 ${userId} 失敗:`, error);
      }
    }
  }
}, {
  timezone: "Asia/Taipei"
});

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

// 解析自然語言查詢
function parseQuery(text) {
  const cleanText = text.toLowerCase().replace(/[空氣品質|空氣|空品|pm2.5|aqi|查詢|怎麼樣|如何]/g, '');
  
  // 檢查是否為訂閱相關指令
  if (text.includes('訂閱') || text.includes('subscribe')) {
    return parseSubscribeQuery(text);
  }
  
  // 檢查是否為取消訂閱
  if (text.includes('取消訂閱') || text.includes('unsubscribe')) {
    return parseUnsubscribeQuery(text);
  }
  
  // 檢查是否為查看訂閱
  if (text.includes('我的訂閱') || text.includes('訂閱清單')) {
    return { type: 'list_subscriptions' };
  }
  
  // 檢查是否為設定相關
  if (text.includes('設定') || text.includes('settings')) {
    return { type: 'settings' };
  }
  
  // 檢查是否為比較查詢
  if (text.includes('比較') || text.includes('vs') || text.includes('對比')) {
    return parseCompareQuery(text);
  }
  
  // 檢查是否包含城市名稱
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese) || cleanText.includes(english)) {
      return { type: 'single', city: english, cityName: chinese };
    }
  }
  
  // 如果沒有找到特定城市，返回null
  return null;
}

// 解析訂閱查詢
function parseSubscribeQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { type: 'subscribe', city: english, cityName: chinese };
    }
  }
  return { type: 'subscribe', city: null };
}

// 解析取消訂閱查詢
function parseUnsubscribeQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { type: 'unsubscribe', city: english, cityName: chinese };
    }
  }
  return { type: 'unsubscribe', city: null };
}

// 解析比較查詢
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

// 獲取空氣品質數據
async function getAirQuality(city) {
  try {
    const url = `${WAQI_BASE_URL}/feed/${city}/?token=${WAQI_TOKEN}`;
    const response = await axios.get(url);
    
    if (response.data.status === 'ok') {
      return response.data.data;
    } else {
      throw new Error('無法獲取空氣品質數據');
    }
  } catch (error) {
    console.error('獲取空氣品質數據錯誤:', error);
    throw error;
  }
}

// 獲取多個城市的空氣品質數據
async function getMultipleCitiesAirQuality(cities) {
  try {
    const promises = cities.map(async (cityInfo) => {
      try {
        const url = `${WAQI_BASE_URL}/feed/${cityInfo.english}/?token=${WAQI_TOKEN}`;
        const response = await axios.get(url);
        if (response.data.status === 'ok') {
          return {
            ...response.data.data,
            chineseName: cityInfo.chinese
          };
        }
        return null;
      } catch (error) {
        console.error(`獲取${cityInfo.chinese}空氣品質失敗:`, error);
        return null;
      }
    });
    
    const results = await Promise.all(promises);
    return results.filter(result => result !== null);
  } catch (error) {
    console.error('獲取多城市空氣品質數據錯誤:', error);
    throw error;
  }
}

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

// 創建城市選擇Flex Message
function createCitySelectionFlexMessage() {
  return {
    type: 'flex',
    altText: '選擇城市 - 空氣品質查詢',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🏙️ 台灣主要城市',
                weight: 'bold',
                color: '#ffffff',
                align: 'center'
              }
            ],
            backgroundColor: '#4CAF50',
            paddingAll: '15px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '台北',
                  text: '台北空氣品質'
                },
                color: '#42a5f5'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '台中',
                  text: '台中空氣品質'
                },
                color: '#42a5f5'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '台南',
                  text: '台南空氣品質'
                },
                color: '#42a5f5'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '高雄',
                  text: '高雄空氣品質'
                },
                color: '#42a5f5'
              }
            ]
          }
        },
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🌏 國際城市',
                weight: 'bold',
                color: '#ffffff',
                align: 'center'
              }
            ],
            backgroundColor: '#ff7e00',
            paddingAll: '15px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '東京',
                  text: '東京空氣品質'
                },
                color: '#ff7e00'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '首爾',
                  text: '首爾空氣品質'
                },
                color: '#ff7e00'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '新加坡',
                  text: '新加坡空氣品質'
                },
                color: '#ff7e00'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '香港',
                  text: '香港空氣品質'
                },
                color: '#ff7e00'
              }
            ]
          }
        },
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🆚 多城市比較',
                weight: 'bold',
                color: '#ffffff',
                align: 'center'
              }
            ],
            backgroundColor: '#8f3f97',
            paddingAll: '15px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '台北 vs 高雄',
                  text: '比較台北高雄'
                },
                color: '#8f3f97'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '台灣五大城市',
                  text: '比較台北台中台南高雄新北'
                },
                color: '#8f3f97'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '自訂比較',
                  text: '自訂城市比較'
                },
                color: '#8f3f97'
              },
              {
                type: 'button',
                action: {
                  type: 'location',
                  label: '📍 附近查詢'
                }
              }
            ]
          }
        }
      ]
    }
  };
}

// 創建訂閱管理Flex Message
function createSubscriptionManagementFlexMessage(userId) {
  const userSub = getUserSubscriptions(userId);
  const hasSubscriptions = userSub.cities.length > 0;
  
  const flexMessage = {
    type: 'flex',
    altText: '訂閱管理 - 空氣品質提醒',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🔔 訂閱管理',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: '#8f3f97',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: []
      }
    }
  };

  if (hasSubscriptions) {
    // 顯示當前訂閱
    flexMessage.contents.body.contents.push(
      {
        type: 'text',
        text: '📋 您的訂閱清單：',
        weight: 'bold',
        color: '#333333',
        margin: 'md'
      }
    );

    userSub.cities.forEach((city, index) => {
      const chinese = Object.keys(cityMap).find(key => cityMap[key] === city) || city;
      flexMessage.contents.body.contents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          {
            type: 'text',
            text: `${index + 1}. ${chinese}`,
            flex: 3,
            color: '#666666'
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '取消',
              text: `取消訂閱${chinese}`
            },
            style: 'secondary',
            height: 'sm',
            flex: 1
          }
        ]
      });
    });

    // 顯示設定
    flexMessage.contents.body.contents.push(
      {
        type: 'separator',
        margin: 'lg'
      },
      {
        type: 'text',
        text: '⚙️ 目前設定：',
        weight: 'bold',
        color: '#333333',
        margin: 'md'
      },
      {
        type: 'text',
        text: `📅 每日報告：${userSub.settings.dailyReport ? '開啟' : '關閉'}`,
        size: 'sm',
        color: '#666666',
        margin: 'sm'
      },
      {
        type: 'text',
        text: `🚨 緊急警報：${userSub.settings.emergencyAlert ? '開啟' : '關閉'}`,
        size: 'sm',
        color: '#666666',
        margin: 'xs'
      },
      {
        type: 'text',
        text: `⚠️ 警報閾值：AQI > ${userSub.settings.threshold}`,
        size: 'sm',
        color: '#666666',
        margin: 'xs'
      }
    );
  } else {
    flexMessage.contents.body.contents.push({
      type: 'text',
      text: '您目前沒有訂閱任何城市',
      color: '#666666',
      align: 'center',
      margin: 'lg'
    });
  }

  // 添加操作按鈕
  flexMessage.contents.body.contents.push(
    {
      type: 'separator',
      margin: 'lg'
    },
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      margin: 'lg',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#4CAF50',
          action: {
            type: 'message',
            label: '➕ 新增訂閱',
            text: '新增訂閱'
          }
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'message',
            label: '⚙️ 修改設定',
            text: '修改設定'
          }
        }
      ]
    }
  );

  if (hasSubscriptions) {
    flexMessage.contents.body.contents[flexMessage.contents.body.contents.length - 1].contents.push({
      type: 'button',
      style: 'secondary',
      action: {
        type: 'message',
        label: '🗑️ 清除所有訂閱',
        text: '清除所有訂閱'
      }
    });
  }

  return flexMessage;
}

// 創建設定Flex Message
function createSettingsFlexMessage(userId) {
  const userSub = getUserSubscriptions(userId);
  
  return {
    type: 'flex',
    altText: '個人設定 - 智慧空氣品質機器人',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '⚙️ 個人設定',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: '#666666',
        paddingAll: '20px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '📅 每日報告',
            weight: 'bold',
            color: '#333333'
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: userSub.settings.dailyReport ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '開啟',
                  text: '開啟每日報告'
                },
                flex: 1
              },
              {
                type: 'button',
                style: !userSub.settings.dailyReport ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '關閉',
                  text: '關閉每日報告'
                },
                flex: 1
              }
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '🚨 緊急警報',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: userSub.settings.emergencyAlert ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '開啟',
                  text: '開啟緊急警報'
                },
                flex: 1
              },
              {
                type: 'button',
                style: !userSub.settings.emergencyAlert ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '關閉',
                  text: '關閉緊急警報'
                },
                flex: 1
              }
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '⚠️ 警報閾值設定',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          {
            type: 'text',
            text: `目前閾值：AQI > ${userSub.settings.threshold}`,
            color: '#666666',
            size: 'sm',
            margin: 'sm'
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: userSub.settings.threshold === 50 ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '50',
                  text: '設定警報閾值50'
                },
                flex: 1
              },
              {
                type: 'button',
                style: userSub.settings.threshold === 100 ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '100',
                  text: '設定警報閾值100'
                },
                flex: 1
              },
              {
                type: 'button',
                style: userSub.settings.threshold === 150 ? 'primary' : 'secondary',
                action: {
                  type: 'message',
                  label: '150',
                  text: '設定警報閾值150'
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
            type: 'button',
            style: 'secondary',
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

// 創建每日報告Flex Message
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
            text: '📊 今日空氣品質排名',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          ...citiesData.map((city, index) => {
            const aqiInfo = getAQILevel(city.aqi);
            const rankEmoji = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][index] || `${index + 1}️⃣`;
            
            return {
              type: 'box',
              layout: 'horizontal',
              contents: [
                {
                  type: 'text',
                  text: rankEmoji,
                  flex: 1,
                  align: 'center'
                },
                {
                  type: 'text',
                  text: city.chineseName,
                  weight: 'bold',
                  size: 'sm',
                  color: '#333333',
                  flex: 3
                },
                {
                  type: 'text',
                  text: `AQI ${city.aqi}`,
                  weight: 'bold',
                  size: 'sm',
                  color: aqiInfo.color,
                  align: 'end',
                  flex: 2
                }
              ],
              margin: 'md'
            };
          }),
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: `🏆 今日推薦：${bestCity.chineseName}`,
            weight: 'bold',
            color: '#4CAF50',
            align: 'center',
            margin: 'lg'
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
            text: '💡 點擊任一城市可查看詳細資訊',
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

// 創建緊急警報Flex Message
function createEmergencyAlertFlexMessage(airQualityData) {
  const aqiInfo = getAQILevel(airQualityData.aqi);
  const healthAdvice = getHealthAdvice(airQualityData.aqi);
  
  return {
    type: 'flex',
    altText: `🚨 空氣品質警報 - ${airQualityData.city.name}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🚨 空氣品質警報',
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          },
          {
            type: 'text',
            text: '請立即採取防護措施',
            color: '#ffffff',
            size: 'sm',
            align: 'center',
            margin: 'sm'
          }
        ],
        backgroundColor: '#ff0000',
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
            contents: [
              {
                type: 'text',
                text: '📍 地點',
                color: '#aaaaaa',
                size: 'sm',
                flex: 2
              },
              {
                type: 'text',
                text: airQualityData.city.name,
                color: '#333333',
                size: 'sm',
                flex: 3
              }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '💨 AQI',
                color: '#aaaaaa',
                size: 'sm',
                flex: 2
              },
              {
                type: 'text',
                text: `${airQualityData.aqi} (${aqiInfo.level})`,
                color: aqiInfo.color,
                size: 'lg',
                weight: 'bold',
                flex: 3
              }
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '🚨 緊急建議',
            weight: 'bold',
            color: '#ff0000',
            margin: 'lg'
          },
          {
            type: 'text',
            text: healthAdvice.mask,
            size: 'sm',
            color: '#333333',
            margin: 'sm'
          },
          {
            type: 'text',
            text: healthAdvice.indoor,
            size: 'sm',
            color: '#333333',
            margin: 'xs'
          },
          {
            type: 'text',
            text: healthAdvice.exercise,
            size: 'sm',
            color: '#333333',
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
            type: 'button',
            style: 'primary',
            color: '#4CAF50',
            action: {
              type: 'message',
              label: '查看詳細資訊',
              text: `${airQualityData.city.name}空氣品質`
            },
            margin: 'sm'
          }
        ]
      }
    }
  };
}

// 創建附近監測站Flex Message
function createNearbyStationsFlexMessage(stations, userLat, userLng) {
  if (stations.length === 0) {
    return {
      type: 'flex',
      altText: '附近監測站查詢結果',
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '📍 附近監測站',
              weight: 'bold',
              color: '#ffffff',
              size: 'lg',
              align: 'center'
            }
          ],
          backgroundColor: '#ff7e00',
          paddingAll: '20px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '😔 抱歉，找不到您附近的空氣品質監測站',
              color: '#666666',
              align: 'center',
              margin: 'lg',
              wrap: true
            },
            {
              type: 'text',
              text: '請嘗試查詢特定城市的空氣品質',
              color: '#aaaaaa',
              size: 'sm',
              align: 'center',
              margin: 'md',
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
              action: {
                type: 'message',
                label: '🔍 選擇城市查詢',
                text: '查詢空氣品質'
              },
              margin: 'sm'
            }
          ]
        }
      }
    };
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

    flexMessage.contents.body.contents.push(
      {
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
                text: station.station?.name || '未知站點',
                weight: 'bold',
                size: 'md',
                color: '#333333',
                wrap: true
              },
              {
                type: 'text',
                text: `📏 距離: ${distanceText}`,
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
                align: 'end'
              }
            ]
          }
        ]
      }
    );

    if (index < stations.length - 1) {
      flexMessage.contents.body.contents.push({
        type: 'separator',
        margin: 'md'
      });
    }
  });

  return flexMessage;
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
    altText: `${data.city.name} 空氣品質 AQI: ${data.aqi}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${aqiInfo.emoji} 空氣品質報告`,
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
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
                    text: '📍 城市',
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
                    text: '💨 AQI',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: data.aqi.toString(),
                    wrap: true,
                    color: aqiInfo.color,
                    size: 'xl',
                    weight: 'bold',
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
                    text: '📊 等級',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: aqiInfo.level,
                    wrap: true,
                    color: '#666666',
                    size: 'sm',
                    flex: 5
                  }
                ]
              },
              {
                type: 'separator',
                margin: 'md'
              },
              {
                type: 'text',
                text: '🏥 健康建議',
                weight: 'bold',
                size: 'md',
                margin: 'md',
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
                text: healthAdvice.sensitive,
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
                margin: 'md'
              },
              {
                type: 'text',
                text: '📊 詳細數據',
                weight: 'bold',
                size: 'md',
                margin: 'md',
                color: '#333333'
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
                  label: '🔔 訂閱提醒',
                  text: `訂閱${data.city.name}`
                },
                flex: 1
              },
              {
                type: 'button',
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '🆚 比較城市',
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
  if (data.iaqi) {
    const pollutants = [
      { key: 'pm25', name: 'PM2.5', unit: 'μg/m³' },
      { key: 'pm10', name: 'PM10', unit: 'μg/m³' },
      { key: 'o3', name: '臭氧', unit: 'ppb' },
      { key: 'no2', name: '二氧化氮', unit: 'ppb' },
      { key: 'so2', name: '二氧化硫', unit: 'ppb' },
      { key: 'co', name: '一氧化碳', unit: 'mg/m³' }
    ];

    pollutants.forEach(pollutant => {
      if (data.iaqi[pollutant.key]) {
        flexMessage.contents.body.contents[0].contents.push({
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
              flex: 5
            }
          ]
        });
      }
    });
  }

  return flexMessage;
}

// 創建多城市比較Flex Message
function createCityComparisonFlexMessage(citiesData) {
  // 按AQI排序
  const sortedCities = citiesData.sort((a, b) => a.aqi - b.aqi);
  
  // 決定最佳城市的建議
  const bestCity = sortedCities[0];
  const worstCity = sortedCities[sortedCities.length - 1];
  const bestAqiInfo = getAQILevel(bestCity.aqi);
  
  const flexMessage = {
    type: 'flex',
    altText: `多城市空氣品質比較 - 最佳: ${bestCity.chineseName} AQI: ${bestCity.aqi}`,
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

  // 添加排名圖標
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
              text: city.chineseName,
              weight: 'bold',
              size: 'md',
              color: '#333333'
            },
            {
              type: 'text',
              text: `${city.city.name}`,
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
              align: 'end'
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

  // 添加旅行建議
  const recommendation = bestCity.aqi <= 100 ? 
    `✈️ 推薦前往 ${bestCity.chineseName}！空氣品質${bestAqiInfo.level}` :
    `⚠️ 所有城市空氣品質都需注意，${bestCity.chineseName} 相對最佳`;

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
    }
  );

  return flexMessage;
}

// 創建歡迎訊息Flex Message
function createWelcomeFlexMessage() {
  return {
    type: 'flex',
    altText: '歡迎使用智慧空氣品質機器人',
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: 'https://via.placeholder.com/1040x585/4CAF50/FFFFFF?text=%F0%9F%8C%AC%EF%B8%8F+%E6%99%BA%E6%85%A7%E7%A9%BA%E6%B0%A3%E5%93%81%E8%B3%AA%E6%A9%9F%E5%99%A8%E4%BA%BA',
        size: 'full',
        aspectRatio: '1040:585',
        aspectMode: 'cover'
      },
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
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '💡 使用教學',
              text: '使用說明'
            }
          }
        ]
      }
    }
  };
}

// 創建使用說明Flex Message
function createHelpFlexMessage() {
  return {
    type: 'flex',
    altText: '使用說明 - 智慧空氣品質機器人',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🔍 查詢功能',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#42a5f5',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '📱 使用方式',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '• 直接輸入城市名稱\n• 點擊主選單按鈕\n• 分享位置查詢附近站點',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '📝 範例',
                weight: 'bold',
                color: '#333333',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '「台北空氣品質」\n「東京空氣品質」\n「比較台北高雄」',
                size: 'sm',
                color: '#666666',
                wrap: true
              }
            ]
          }
        },
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🔔 訂閱功能',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#8f3f97',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '📅 自動推送',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '• 每日08:00空氣品質報告\n• 空氣品質惡化警報\n• 個人化健康建議',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '⚙️ 個人設定',
                weight: 'bold',
                color: '#333333',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 調整警報閾值\n• 開關推送功能\n• 管理訂閱城市',
                size: 'sm',
                color: '#666666',
                wrap: true
              }
            ]
          }
        },
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '💊 健康建議',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#ff7e00',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '🏥 專業建議',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '• 6級AQI健康分級\n• 運動建議\n• 口罩配戴建議\n• 室內空氣管理',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '👥 族群分類',
                weight: 'bold',
                color: '#333333',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 一般民眾\n• 敏感族群\n• 孕婦及兒童\n• 老年人',
                size: 'sm',
                color: '#666666',
                wrap: true
              }
            ]
          }
        }
      ]
    }
  };
}

// 創建錯誤訊息Flex Message
function createErrorFlexMessage(errorType, message) {
  const errorConfig = {
    'not_found': {
      emoji: '🤔',
      title: '無法識別',
      color: '#ff7e00'
    },
    'api_error': {
      emoji: '😵',
      title: '查詢錯誤',
      color: '#ff0000'
    },
    'network_error': {
      emoji: '🌐',
      title: '網路錯誤',
      color: '#ff0000'
    }
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

// 處理LINE訊息
async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;

  // 處理位置訊息
  if (event.message.type === 'location') {
    try {
      const { latitude, longitude } = event.message;
      locationCache.set(userId, { lat: latitude, lng: longitude, timestamp: Date.now() });
      
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
  if (event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  
  try {
    // 檢查用戶狀態
    const userState = getUserState(userId);
    
    // 處理有狀態的對話
    if (userState) {
      return await handleStatefulMessage(event, userState);
    }
    
    // 檢查是否為問候語或主選單
    if (userMessage.match(/^(你好|哈囉|hello|hi|主選單|menu)/i)) {
      const welcomeMessage = createWelcomeFlexMessage();
      const menuMessage = createMainMenuFlexMessage();
      return client.replyMessage(event.replyToken, [welcomeMessage, menuMessage]);
    }

    // 檢查是否為幫助指令
    if (userMessage.match(/^(幫助|help|使用說明|教學)/i)) {
      const helpMessage = createHelpFlexMessage();
      return client.replyMessage(event.replyToken, helpMessage);
    }

    // 檢查是否為設定相關功能
    if (userMessage.match(/^(我的設定|設定|settings)/i)) {
      const settingsMessage = createSettingsFlexMessage(userId);
      return client.replyMessage(event.replyToken, settingsMessage);
    }

    // 處理設定相關指令
    if (userMessage.includes('開啟每日報告') || userMessage.includes('關閉每日報告')) {
      const enable = userMessage.includes('開啟');
      updateUserSettings(userId, { dailyReport: enable });
      
      const confirmMessage = {
        type: 'flex',
        altText: `每日報告已${enable ? '開啟' : '關閉'}`,
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: `✅ 每日報告已${enable ? '開啟' : '關閉'}`,
                weight: 'bold',
                color: '#4CAF50',
                align: 'center'
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
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '↩️ 回到設定',
                  text: '我的設定'
                }
              }
            ]
          }
        }
      };
      
      return client.replyMessage(event.replyToken, confirmMessage);
    }

    if (userMessage.includes('開啟緊急警報') || userMessage.includes('關閉緊急警報')) {
      const enable = userMessage.includes('開啟');
      updateUserSettings(userId, { emergencyAlert: enable });
      
      const confirmMessage = {
        type: 'flex',
        altText: `緊急警報已${enable ? '開啟' : '關閉'}`,
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: `✅ 緊急警報已${enable ? '開啟' : '關閉'}`,
                weight: 'bold',
                color: '#4CAF50',
                align: 'center'
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
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '↩️ 回到設定',
                  text: '我的設定'
                }
              }
            ]
          }
        }
      };
      
      return client.replyMessage(event.replyToken, confirmMessage);
    }

    if (userMessage.includes('設定警報閾值')) {
      const thresholdMatch = userMessage.match(/設定警報閾值(\d+)/);
      if (thresholdMatch) {
        const threshold = parseInt(thresholdMatch[1]);
        updateUserSettings(userId, { threshold });
        
        const confirmMessage = {
          type: 'flex',
          altText: `警報閾值已設定為 ${threshold}`,
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: `✅ 警報閾值已設定為 AQI > ${threshold}`,
                  weight: 'bold',
                  color: '#4CAF50',
                  align: 'center',
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
                  style: 'secondary',
                  action: {
                    type: 'message',
                    label: '↩️ 回到設定',
                    text: '我的設定'
                  }
                }
              ]
            }
          }
        };
        
        return client.replyMessage(event.replyToken, confirmMessage);
      }
    }

    // 處理主選單功能
    if (userMessage === '查詢空氣品質') {
      const citySelectionMessage = createCitySelectionFlexMessage();
      return client.replyMessage(event.replyToken, citySelectionMessage);
    }

    if (userMessage === '比較城市') {
      setUserState(userId, 'awaiting_compare_cities');
      const instructionMessage = {
        type: 'flex',
        altText: '多城市比較 - 請輸入城市',
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🆚 多城市比較',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#8f3f97',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '請輸入要比較的城市名稱',
                color: '#333333',
                align: 'center',
                weight: 'bold'
              },
              {
                type: 'text',
                text: '📝 範例格式：',
                color: '#666666',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 台北 高雄\n• 台北 台中 台南\n• 東京 首爾 新加坡',
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
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '❌ 取消',
                  text: '主選單'
                },
                margin: 'sm'
              }
            ]
          }
        }
      };
      return client.replyMessage(event.replyToken, instructionMessage);
    }

    if (userMessage === '訂閱提醒') {
      const subscriptionMessage = createSubscriptionManagementFlexMessage(userId);
      return client.replyMessage(event.replyToken, subscriptionMessage);
    }

    if (userMessage === '附近查詢') {
      const locationMessage = {
        type: 'flex',
        altText: 'GPS定位查詢',
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '📍 GPS定位查詢',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#00e400',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '請分享您的位置',
                color: '#333333',
                align: 'center',
                weight: 'bold'
              },
              {
                type: 'text',
                text: '我們會為您找到最近的空氣品質監測站',
                size: 'sm',
                color: '#666666',
                align: 'center',
                wrap: true,
                margin: 'md'
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
                color: '#00e400',
                action: {
                  type: 'location',
                  label: '📍 分享位置'
                }
              },
              {
                type: 'button',
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '❌ 取消',
                  text: '主選單'
                }
              }
            ]
          }
        }
      };
      return client.replyMessage(event.replyToken, locationMessage);
    }

    if (userMessage === '新增訂閱') {
      setUserState(userId, 'awaiting_subscribe_city');
      const citySelectionMessage = createCitySelectionFlexMessage();
      return client.replyMessage(event.replyToken, citySelectionMessage);
    }

    if (userMessage === '修改設定') {
      const settingsMessage = createSettingsFlexMessage(userId);
      return client.replyMessage(event.replyToken, settingsMessage);
    }

    if (userMessage === '清除所有訂閱') {
      const success = removeAllSubscriptions(userId);
      const confirmMessage = {
        type: 'flex',
        altText: success ? '已清除所有訂閱' : '清除失敗',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: success ? '✅ 已清除所有訂閱' : '❌ 您目前沒有任何訂閱',
                weight: 'bold',
                color: success ? '#4CAF50' : '#ff0000',
                align: 'center'
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
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '↩️ 回到訂閱管理',
                  text: '訂閱提醒'
                }
              }
            ]
          }
        }
      };
      return client.replyMessage(event.replyToken, confirmMessage);
    }

    // 解析查詢的內容
    const queryResult = parseQuery(userMessage);
    
    // 處理訂閱功能
    if (queryResult && queryResult.type === 'subscribe') {
      if (queryResult.city) {
        const success = addSubscription(userId, queryResult.city);
        const message = success ? 
          `✅ 已成功訂閱 ${queryResult.cityName} 的空氣品質提醒！` :
          `📋 您已經訂閱了 ${queryResult.cityName} 的空氣品質提醒`;
          
        const confirmMessage = {
          type: 'flex',
          altText: message,
          contents: {
            type: 'bubble',
            header: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: success ? '🎉 訂閱成功' : '📋 已訂閱',
                  weight: 'bold',
                  color: '#ffffff',
                  size: 'lg',
                  align: 'center'
                }
              ],
              backgroundColor: success ? '#4CAF50' : '#ff7e00',
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
                  color: '#333333',
                  align: 'center',
                  wrap: true
                },
                ...(success ? [
                  {
                    type: 'separator',
                    margin: 'lg'
                  },
                  {
                    type: 'text',
                    text: '📅 每日 08:00 推送空氣品質報告\n🚨 AQI>100 時發送緊急警報',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    wrap: true,
                    margin: 'lg'
                  }
                ] : [])
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
                  style: 'secondary',
                  action: {
                    type: 'message',
                    label: '📋 管理訂閱',
                    text: '訂閱提醒'
                  },
                  margin: 'sm'
                }
              ]
            }
          }
        };
        
        return client.replyMessage(event.replyToken, confirmMessage);
      } else {
        setUserState(userId, 'awaiting_subscribe_city');
        const citySelectionMessage = createCitySelectionFlexMessage();
        return client.replyMessage(event.replyToken, citySelectionMessage);
      }
    }

    // 處理取消訂閱
    if (queryResult && queryResult.type === 'unsubscribe') {
      if (queryResult.city) {
        const success = removeSubscription(userId, queryResult.city);
        const message = success ?
          `✅ 已取消訂閱 ${queryResult.cityName} 的空氣品質提醒` :
          `❌ 您沒有訂閱 ${queryResult.cityName} 的提醒`;
        
        const confirmMessage = {
          type: 'flex',
          altText: message,
          contents: {
            type: 'bubble',
            header: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: success ? '✅ 取消訂閱成功' : '❌ 取消失敗',
                  weight: 'bold',
                  color: '#ffffff',
                  size: 'lg',
                  align: 'center'
                }
              ],
              backgroundColor: success ? '#4CAF50' : '#ff0000',
              paddingAll: '20px'
            },
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: message,
                  color: '#333333',
                  align: 'center',
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
                  style: 'secondary',
                  action: {
                    type: 'message',
                    label: '📋 管理訂閱',
                    text: '訂閱提醒'
                  },
                  margin: 'sm'
                }
              ]
            }
          }
        };
        
        return client.replyMessage(event.replyToken, confirmMessage);
      } else {
        // 顯示當前訂閱讓用戶選擇取消
        const userSub = getUserSubscriptions(userId);
        if (userSub.cities.length === 0) {
          const noSubMessage = {
            type: 'flex',
            altText: '沒有訂閱需要取消',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'text',
                    text: '❌ 您目前沒有任何訂閱',
                    color: '#666666',
                    align: 'center'
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
                      label: '➕ 新增訂閱',
                      text: '新增訂閱'
                    }
                  }
                ]
              }
            }
          };
          return client.replyMessage(event.replyToken, noSubMessage);
        }
        
        const subscriptionMessage = createSubscriptionManagementFlexMessage(userId);
        return client.replyMessage(event.replyToken, subscriptionMessage);
      }
    }

    // 處理查看訂閱清單
    if (queryResult && queryResult.type === 'list_subscriptions') {
      const subscriptionMessage = createSubscriptionManagementFlexMessage(userId);
      return client.replyMessage(event.replyToken, subscriptionMessage);
    }

    // 處理多城市比較
    if (queryResult && queryResult.type === 'compare') {
      const citiesData = await getMultipleCitiesAirQuality(queryResult.cities);
      
      if (citiesData.length === 0) {
        const errorMessage = createErrorFlexMessage('api_error', '抱歉，無法獲取這些城市的空氣品質數據。請稍後再試，或嘗試其他城市。');
        return client.replyMessage(event.replyToken, errorMessage);
      }
      
      if (citiesData.length === 1) {
        // 如果只有一個城市有數據，返回單城市查詢結果
        const flexMessage = createAirQualityFlexMessage(citiesData[0]);
        return client.replyMessage(event.replyToken, flexMessage);
      }
      
      // 創建比較結果
      const comparisonMessage = createCityComparisonFlexMessage(citiesData);
      return client.replyMessage(event.replyToken, comparisonMessage);
    }

    // 處理單城市查詢
    if (queryResult && queryResult.type === 'single') {
      const airQualityData = await getAirQuality(queryResult.city);
      const flexMessage = createAirQualityFlexMessage(airQualityData);
      
      return client.replyMessage(event.replyToken, flexMessage);
    }

    // 處理自訂比較指令
    if (userMessage === '自訂城市比較') {
      setUserState(userId, 'awaiting_compare_cities');
      const instructionMessage = {
        type: 'flex',
        altText: '自訂多城市比較',
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🆚 自訂城市比較',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#8f3f97',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '請輸入要比較的城市名稱',
                color: '#333333',
                align: 'center',
                weight: 'bold'
              },
              {
                type: 'text',
                text: '用空格分隔，最多可比較5個城市',
                size: 'sm',
                color: '#666666',
                align: 'center',
                margin: 'sm'
              },
              {
                type: 'text',
                text: '📝 範例：',
                color: '#666666',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '台北 高雄 台中\n東京 首爾 新加坡 香港',
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
                style: 'secondary',
                action: {
                  type: 'message',
                  label: '❌ 取消',
                  text: '主選單'
                },
                margin: 'sm'
              }
            ]
          }
        }
      };
      return client.replyMessage(event.replyToken, instructionMessage);
    }
    
    // 如果沒有匹配到任何指令，顯示錯誤訊息和主選單
    const notFoundMessage = createErrorFlexMessage('not_found', '我無法識別您的指令。請使用下方選單或嘗試直接輸入城市名稱。');
    const menuMessage = createMainMenuFlexMessage();
    
    return client.replyMessage(event.replyToken, [notFoundMessage, menuMessage]);
    
  } catch (error) {
    console.error('處理訊息錯誤:', error);
    
    const errorMessage = createErrorFlexMessage('api_error', '查詢空氣品質時發生錯誤，請稍後再試。');
    const menuMessage = createMainMenuFlexMessage();
    
    return client.replyMessage(event.replyToken, [errorMessage, menuMessage]);
  }
}

// 處理有狀態的對話
async function handleStatefulMessage(event, userState) {
  const userId = event.source.userId;
  const userMessage = event.message.text;
  
  try {
    if (userState.state === 'awaiting_compare_cities') {
      // 處理城市比較輸入
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
      
      clearUserState(userId);
      
      if (cities.length < 2) {
        const errorMessage = createErrorFlexMessage('not_found', '請至少輸入2個城市名稱，用空格分隔。');
        return client.replyMessage(event.replyToken, errorMessage);
      }
      
      if (cities.length > 5) {
        cities.splice(5); // 限制最多5個城市
      }
      
      const citiesData = await getMultipleCitiesAirQuality(cities);
      
      if (citiesData.length === 0) {
        const errorMessage = createErrorFlexMessage('api_error', '無法獲取這些城市的空氣品質數據，請檢查城市名稱是否正確。');
        return client.replyMessage(event.replyToken, errorMessage);
      }
      
      const comparisonMessage = createCityComparisonFlexMessage(citiesData);
      return client.replyMessage(event.replyToken, comparisonMessage);
    }
    
    if (userState.state === 'awaiting_subscribe_city') {
      // 處理訂閱城市輸入
      const queryResult = parseQuery(userMessage);
      
      clearUserState(userId);
      
      if (queryResult && queryResult.type === 'single') {
        const success = addSubscription(userId, queryResult.city);
        const message = success ? 
          `✅ 已成功訂閱 ${queryResult.cityName} 的空氣品質提醒！` :
          `📋 您已經訂閱了 ${queryResult.cityName} 的空氣品質提醒`;
          
        const confirmMessage = {
          type: 'flex',
          altText: message,
          contents: {
            type: 'bubble',
            header: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: success ? '🎉 訂閱成功' : '📋 已訂閱',
                  weight: 'bold',
                  color: '#ffffff',
                  size: 'lg',
                  align: 'center'
                }
              ],
              backgroundColor: success ? '#4CAF50' : '#ff7e00',
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
                  color: '#333333',
                  align: 'center',
                  wrap: true
                },
                ...(success ? [
                  {
                    type: 'separator',
                    margin: 'lg'
                  },
                  {
                    type: 'text',
                    text: '📅 每日 08:00 推送空氣品質報告\n🚨 AQI>100 時發送緊急警報',
                    size: 'sm',
                    color: '#666666',
                    align: 'center',
                    wrap: true,
                    margin: 'lg'
                  }
                ] : [])
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
                  style: 'secondary',
                  action: {
                    type: 'message',
                    label: '📋 管理訂閱',
                    text: '訂閱提醒'
                  },
                  margin: 'sm'
                }
              ]
            }
          }
        };
        
        return client.replyMessage(event.replyToken, confirmMessage);
      } else {
        const errorMessage = createErrorFlexMessage('not_found', '無法識別城市名稱，請重新輸入或使用選單選擇。');
        const citySelectionMessage = createCitySelectionFlexMessage();
        return client.replyMessage(event.replyToken, [errorMessage, citySelectionMessage]);
      }
    }
    
    // 如果狀態不匹配，清除狀態並顯示主選單
    clearUserState(userId);
    const menuMessage = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, menuMessage);
    
  } catch (error) {
    console.error('處理狀態對話錯誤:', error);
    clearUserState(userId);
    
    const errorMessage = createErrorFlexMessage('api_error', '處理請求時發生錯誤，請重試。');
    const menuMessage = createMainMenuFlexMessage();
    
    return client.replyMessage(event.replyToken, [errorMessage, menuMessage]);
  }
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

// 修復後的首頁端點 - 解決文件路徑問題
app.get('/', (req, res) => {
  try {
    // 檢查文件是否存在
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      // 如果 index.html 不存在，直接返回 HTML 內容
      res.send(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智慧空氣品質機器人 | LINE Bot</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', sans-serif; 
            background: linear-gradient(-45deg, #667eea, #764ba2, #6b73ff, #9644ff); 
            background-size: 400% 400%;
            animation: gradient-shift 8s ease infinite;
            min-height: 100vh; 
            padding: 2rem 1rem;
        }
        @keyframes gradient-shift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        .main-container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .hero-section { 
            background: white; 
            padding: 3rem; 
            border-radius: 20px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.1); 
            text-align: center; 
            margin-bottom: 3rem;
        }
        h1 { color: #333; margin-bottom: 1rem; font-size: 2.5rem; }
        p { color: #666; margin-bottom: 2rem; font-size: 1.2rem; line-height: 1.6; }
        .cta-button { 
            display: inline-block; 
            background: #00b900; 
            color: white; 
            padding: 15px 40px; 
            border-radius: 50px; 
            text-decoration: none; 
            font-weight: 600; 
            transition: all 0.3s ease; 
            margin: 0.5rem;
        }
        .cta-button:hover { 
            transform: translateY(-3px); 
            box-shadow: 0 10px 30px rgba(0,185,0,0.3); 
        }
        .features { 
            margin-top: 2rem; 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); 
            gap: 1rem; 
        }
        .feature { 
            padding: 1rem; 
            background: #f8fafc; 
            border-radius: 10px; 
            transition: all 0.3s ease;
        }
        .feature:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 20px rgba(0,0,0,0.1);
        }
        .feature i { 
            font-size: 2rem; 
            color: #00b900; 
            margin-bottom: 0.5rem; 
        }
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            background: #00e400;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
    </style>
</head>
<body>
    <div class="main-container">
        <div class="hero-section">
            <h1>🌬️ 智慧空氣品質機器人</h1>
            <p><span class="status-indicator"></span>服務正常運行中</p>
            <p>即時監測空氣品質，守護您和家人的健康</p>
            
            <div style="margin: 2rem 0;">
                <a href="https://line.me/R/ti/p/@470kdmxx" class="cta-button" target="_blank">
                    <i class="fab fa-line"></i> 立即加入好友
                </a>
                <a href="/health" class="cta-button" style="background: #42a5f5;">
                    🔧 服務狀態
                </a>
            </div>
            
            <div class="features">
                <div class="feature">
                    <i class="fas fa-search-location"></i>
                    <h4>即時查詢</h4>
                    <p>30+ 支援城市</p>
                </div>
                <div class="feature">
                    <i class="fas fa-chart-line"></i>
                    <h4>多城市比較</h4>
                    <p>智慧排序推薦</p>
                </div>
                <div class="feature">
                    <i class="fas fa-user-md"></i>
                    <h4>健康建議</h4>
                    <p>專業防護指導</p>
                </div>
                <div class="feature">
                    <i class="fas fa-bell"></i>
                    <h4>訂閱提醒</h4>
                    <p>每日報告+警報</p>
                </div>
                <div class="feature">
                    <i class="fas fa-map-marker-alt"></i>
                    <h4>GPS定位</h4>
                    <p>附近監測站查詢</p>
                </div>
                <div class="feature">
                    <i class="fas fa-robot"></i>
                    <h4>AI智慧</h4>
                    <p>自然語言理解</p>
                </div>
            </div>
        </div>
        
        <div class="hero-section">
            <h3 style="color: #333; margin-bottom: 1rem;">🚀 快速測試</h3>
            <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; font-size: 0.9rem;">
                <a href="/api/air-quality/taipei" style="color: #00b900; text-decoration: none;">📡 台北空氣品質API</a>
                <a href="/api/air-quality/kaohsiung" style="color: #00b900; text-decoration: none;">📡 高雄空氣品質API</a>
                <a href="/debug" style="color: #666; text-decoration: none;">🔍 系統診斷</a>
            </div>
            
            <div style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.85rem; color: #999;">
                © 2025 智慧空氣品質機器人 | 用科技守護每一次呼吸 🌱
            </div>
        </div>
    </div>
</body>
</html>
      `);
    }
  } catch (error) {
    console.error('首頁載入錯誤:', error);
    res.status(500).send(`
      <h1>服務臨時不可用</h1>
      <p>請稍後再試，或聯繫技術支援</p>
      <p>錯誤: ${error.message}</p>
    `);
  }
});

// 健康檢查端點 - 增強診斷功能
app.get('/health', (req, res) => {
  const indexExists = fs.existsSync(path.join(__dirname, 'index.html'));
  
  res.json({ 
    status: 'OK', 
    message: 'LINE空氣品質機器人正常運行中！',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: {
      node_version: process.version,
      platform: process.platform,
      memory_usage: process.memoryUsage(),
      index_html_exists: indexExists,
      line_token_configured: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      line_secret_configured: !!process.env.LINE_CHANNEL_SECRET,
      working_directory: __dirname
    },
    features: [
      '即時空氣品質查詢',
      '多城市比較',
      '智慧健康建議',
      '訂閱提醒系統',
      'GPS定位查詢',
      '圖文選單介面',
      '用戶狀態管理'
    ],
    statistics: {
      total_subscriptions: subscriptions.size,
      location_cache_entries: locationCache.size,
      active_user_states: userStates.size,
      supported_cities: Object.keys(cityMap).length
    }
  });
});

// API端點 - 獲取城市空氣品質
app.get('/api/air-quality/:city', async (req, res) => {
  try {
    const city = req.params.city;
    console.log(`API請求 - 城市: ${city}`);
    const airQualityData = await getAirQuality(city);
    res.json(airQualityData);
  } catch (error) {
    console.error('API錯誤:', error);
    res.status(500).json({ 
      error: '無法獲取空氣品質數據',
      details: error.message,
      city: req.params.city,
      timestamp: new Date().toISOString()
    });
  }
});

// 統計端點 - 獲取服務統計
app.get('/api/stats', (req, res) => {
  res.json({
    service: {
      name: '智慧空氣品質機器人',
      version: '2.0.0',
      status: 'running'
    },
    statistics: {
      supportedCities: Object.keys(cityMap).length,
      totalSubscriptions: subscriptions.size,
      activeCacheEntries: locationCache.size,
      activeUserStates: userStates.size
    },
    features: [
      'real_time_air_quality',
      'multi_city_comparison', 
      'health_recommendations',
      'subscription_alerts',
      'gps_location_query',
      'flex_message_interface',
      'user_state_management'
    ],
    cities: Object.keys(cityMap),
    uptime: Math.floor(process.uptime()),
    last_updated: new Date().toISOString()
  });
});

// 訂閱統計端點
app.get('/api/subscriptions/stats', (req, res) => {
  const stats = {
    total_users: subscriptions.size,
    total_subscriptions: Array.from(subscriptions.values()).reduce((sum, user) => sum + user.cities.length, 0),
    settings_distribution: {
      daily_report_enabled: 0,
      emergency_alert_enabled: 0,
      threshold_50: 0,
      threshold_100: 0,
      threshold_150: 0
    }
  };

  for (const userSub of subscriptions.values()) {
    if (userSub.settings.dailyReport) stats.settings_distribution.daily_report_enabled++;
    if (userSub.settings.emergencyAlert) stats.settings_distribution.emergency_alert_enabled++;
    
    switch (userSub.settings.threshold) {
      case 50: stats.settings_distribution.threshold_50++; break;
      case 100: stats.settings_distribution.threshold_100++; break;
      case 150: stats.settings_distribution.threshold_150++; break;
    }
  }

  res.json(stats);
});

// 調試端點 - 檢查服務狀態
app.get('/debug', (req, res) => {
  try {
    res.json({
      server_status: 'running',
      timestamp: new Date().toISOString(),
      node_version: process.version,
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
      memory_usage: process.memoryUsage(),
      environment_variables: {
        PORT: process.env.PORT,
        NODE_ENV: process.env.NODE_ENV,
        line_token_length: process.env.LINE_CHANNEL_ACCESS_TOKEN?.length || 0,
        line_secret_length: process.env.LINE_CHANNEL_SECRET?.length || 0
      },
      file_system: {
        current_directory: __dirname,
        index_exists: fs.existsSync(path.join(__dirname, 'index.html')),
        package_exists: fs.existsSync(path.join(__dirname, 'package.json'))
      },
      routes: [
        'GET /',
        'GET /health', 
        'GET /debug',
        'GET /api/air-quality/:city',
        'GET /api/stats',
        'GET /api/subscriptions/stats',
        'POST /webhook'
      ],
      data_statistics: {
        subscriptions_count: subscriptions.size,
        location_cache_count: locationCache.size,
        user_states_count: userStates.size,
        supported_cities_count: Object.keys(cityMap).length
      },
      features_status: {
        real_time_query: 'enabled',
        multi_city_comparison: 'enabled',
        subscription_management: 'enabled',
        gps_location_query: 'enabled',
        health_recommendations: 'enabled',
        flex_message_interface: 'enabled',
        daily_reports: 'enabled',
        emergency_alerts: 'enabled'
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Debug endpoint error',
      message: error.message
    });
  }
});

// 清理過期的用戶狀態和位置快取（每小時執行一次）
cron.schedule('0 * * * *', () => {
  const now = Date.now();
  
  // 清理過期的用戶狀態（超過5分鐘）
  for (const [userId, state] of userStates.entries()) {
    if (now - state.timestamp > 300000) {
      userStates.delete(userId);
    }
  }
  
  // 清理過期的位置快取（超過1小時）
  for (const [userId, location] of locationCache.entries()) {
    if (now - location.timestamp > 3600000) {
      locationCache.delete(userId);
    }
  }
  
  console.log(`清理完成 - 用戶狀態: ${userStates.size}, 位置快取: ${locationCache.size}`);
}, {
  timezone: "Asia/Taipei"
});

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error('伺服器錯誤:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method,
    message: '請求的路由不存在',
    available_routes: ['/', '/health', '/debug', '/api/air-quality/:city', '/api/stats', '/api/subscriptions/stats'],
    timestamp: new Date().toISOString()
  });
});

// 優雅關機處理
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，正在優雅關機...');
  // 可以在這裡保存數據到數據庫
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('收到 SIGINT 信號，正在優雅關機...');
  // 可以在這裡保存數據到數據庫
  process.exit(0);
});

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 LINE智慧空氣品質機器人在端口 ${port} 上運行`);
  console.log('✨ 全新功能列表：');
  console.log('✅ 即時空氣品質查詢');
  console.log('✅ 多城市比較功能');
  console.log('✅ 智慧健康建議系統');
  console.log('✅ 完整訂閱管理系統');
  console.log('✅ GPS定位查詢');
  console.log('✅ 圖文選單介面');
  console.log('✅ 用戶狀態管理');
  console.log('✅ 個人化設定');
  console.log('✅ 每日報告推送');
  console.log('✅ 緊急警報系統');
  console.log('✅ 優雅錯誤處理');
  console.log(`🌐 服務網址: http://0.0.0.0:${port}`);
  
  // 檢查環境變數
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
    console.warn('⚠️ 警告：LINE Bot 環境變數未完整設定');
    console.warn('請在 Render Dashboard 設定以下環境變數：');
    console.warn('- LINE_CHANNEL_ACCESS_TOKEN');
    console.warn('- LINE_CHANNEL_SECRET');
  } else {
    console.log('✅ LINE Bot 環境變數設定完成');
  }
  
  // 統計信息
  console.log('📊 初始統計：');
  console.log(`- 支援城市數量: ${Object.keys(cityMap).length}`);
  console.log(`- 訂閱用戶數量: ${subscriptions.size}`);
  console.log(`- 活躍用戶狀態: ${userStates.size}`);
  console.log(`- 位置快取項目: ${locationCache.size}`);
  
  console.log('🎉 系統已完全啟動，準備接收 LINE 訊息！');
});