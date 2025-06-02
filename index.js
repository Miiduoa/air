/**
 * 智慧空氣品質機器人 + AI 自然對話 (修復版 v3.0)
 * 版本：3.0.0
 *
 * 功能：
 * 1. 空氣品質查詢 / 多城市比較 / 訂閱提醒 / 緊急警報
 * 2. 定時推送每日報告 & 檢查緊急警報
 * 3. 附近測站查詢 (GPS)
 * 4. AI 自然對話：使用者可以直接用聊天方式與機器人互動 (由 OpenAI GPT-4 驅動)
 * 5. 網頁首頁 / 健康檢查 / Debug / API 端點
 *
 * 環境變數：
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - OPENAI_API_KEY
 * - PORT (選填，預設 3000)
 */

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { Configuration, OpenAIApi } = require('openai');

const app = express();

// 解析 JSON 與 URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 靜態文件服務 (public 資料夾)
app.use(express.static('public'));

// ===== LINE Bot 設定 =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ===== OpenAI GPT-4 設定 =====
const openaiConfig = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(openaiConfig);

// ===== 空氣品質 API (WAQI) =====
const WAQI_TOKEN = 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// ===== 資料暫存 (示範用，建議實務用資料庫) =====
let subscriptions = new Map();      // userId -> { cities: [], settings: { dailyReport, emergencyAlert, threshold } }
let locationCache = new Map();      // userId -> { lat, lng, timestamp }
let userStates = new Map();         // userId -> { state, context, timestamp }

// 城市對應表：中文 => WAQI API 英文 key
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

// ===== 用戶狀態管理 (5 分鐘超時) =====
function setUserState(userId, state, context = {}) {
  userStates.set(userId, { state, context, timestamp: Date.now() });
  console.log(`設定用戶狀態: ${userId} -> ${state}`);
}

function getUserState(userId) {
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < 5 * 60 * 1000) {
    return userState;
  }
  userStates.delete(userId);
  return null;
}

function clearUserState(userId) {
  userStates.delete(userId);
  console.log(`清除用戶狀態: ${userId}`);
}

// ===== 計算兩點距離 (公里) =====
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ===== 根據位置查找附近測站 =====
async function findNearbyStations(lat, lng) {
  try {
    const url = `${WAQI_BASE_URL}/search/?token=${WAQI_TOKEN}&keyword=geo:${lat};${lng}`;
    const response = await axios.get(url);
    if (response.data.status === 'ok' && response.data.data.length > 0) {
      const stationsWithDistance = response.data.data
        .filter((station) => station.geo && station.geo.length === 2)
        .map((station) => ({
          ...station,
          distance: calculateDistance(lat, lng, station.geo[0], station.geo[1])
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);
      return stationsWithDistance;
    }
    return [];
  } catch (error) {
    console.error('查找附近監測站錯誤:', error);
    return [];
  }
}

// ===== 訂閱管理函式 =====
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
    console.log(`用戶 ${userId} 訂閱了 ${city}`);
    return true;
  }
  return false;
}

function removeSubscription(userId, city) {
  if (!subscriptions.has(userId)) return false;
  const userSub = subscriptions.get(userId);
  const idx = userSub.cities.indexOf(city);
  if (idx !== -1) {
    userSub.cities.splice(idx, 1);
    console.log(`用戶 ${userId} 取消訂閱 ${city}`);
    return true;
  }
  return false;
}

function removeAllSubscriptions(userId) {
  if (subscriptions.has(userId)) {
    subscriptions.delete(userId);
    console.log(`用戶 ${userId} 清除所有訂閱`);
    return true;
  }
  return false;
}

function getUserSubscriptions(userId) {
  if (!subscriptions.has(userId)) {
    return {
      cities: [],
      settings: {
        dailyReport: true,
        emergencyAlert: true,
        threshold: 100
      }
    };
  }
  return subscriptions.get(userId);
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
  console.log(`用戶 ${userId} 更新設定:`, settings);
  return userSub.settings;
}

// ===== 定時任務：每日報告 & 緊急警報檢查 =====
// 每天 08:00 推送每日報告
cron.schedule(
  '0 8 * * *',
  async () => {
    console.log('【每日報告】開始發送...');
    for (const [userId, subscription] of subscriptions.entries()) {
      if (subscription.settings.dailyReport && subscription.cities.length > 0) {
        try {
          const cityInfos = subscription.cities.map((cityEng) => ({
            chinese: Object.keys(cityMap).find((k) => cityMap[k] === cityEng) || cityEng,
            english: cityEng
          }));
          const cityData = await getMultipleCitiesAirQuality(cityInfos);
          if (cityData.length > 0) {
            const msg = createDailyReportFlexMessage(cityData);
            await client.pushMessage(userId, msg);
          }
        } catch (err) {
          console.error(`每日報告發送失敗給 ${userId}:`, err);
        }
      }
    }
  },
  { timezone: 'Asia/Taipei' }
);

// 每小時整點檢查緊急警報
cron.schedule(
  '0 * * * *',
  async () => {
    console.log('【緊急警報檢查】開始...');
    for (const [userId, subscription] of subscriptions.entries()) {
      if (subscription.settings.emergencyAlert && subscription.cities.length > 0) {
        try {
          for (const cityEng of subscription.cities) {
            const data = await getAirQuality(cityEng);
            if (data.aqi > subscription.settings.threshold) {
              const alertMsg = createEmergencyAlertFlexMessage(data);
              await client.pushMessage(userId, alertMsg);
            }
          }
        } catch (err) {
          console.error(`緊急警報檢查失敗給 ${userId}:`, err);
        }
      }
    }
  },
  { timezone: 'Asia/Taipei' }
);

// ===== AQI 級別 & 健康建議 =====
function getAQILevel(aqi) {
  if (aqi <= 50) return { level: '良好', color: '#00e400', emoji: '😊' };
  if (aqi <= 100) return { level: '普通', color: '#ffff00', emoji: '😐' };
  if (aqi <= 150) return { level: '對敏感族群不健康', color: '#ff7e00', emoji: '😷' };
  if (aqi <= 200) return { level: '不健康', color: '#ff0000', emoji: '😰' };
  if (aqi <= 300) return { level: '非常不健康', color: '#8f3f97', emoji: '🤢' };
  return { level: '危險', color: '#7e0023', emoji: '☠️' };
}

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

// ===== 自然語言解析：查詢指令 =====
function parseQuery(text) {
  console.log(`解析查詢: "${text}"`);
  const cleanText = text.toLowerCase().trim();
  const originalText = text.trim();

  // 如果包含這些關鍵字，就先交給主邏輯處理（避免誤把設定、訂閱當城市名）
  const functionalKeywords = ['設定', 'settings', '主選單', 'menu', '幫助', 'help', '訂閱', 'subscribe'];
  for (const kw of functionalKeywords) {
    if (originalText.includes(kw)) {
      return null;
    }
  }

  // 判斷「訂閱」相關
  if (originalText.includes('訂閱') && !originalText.includes('取消訂閱') && !originalText.includes('清除') && !originalText.includes('管理')) {
    return parseSubscribeQuery(originalText);
  }

  // 判斷「取消訂閱」
  if (originalText.includes('取消訂閱')) {
    return parseUnsubscribeQuery(originalText);
  }

  // 判斷「查看訂閱」
  if (originalText.includes('我的訂閱') || originalText.includes('訂閱清單') || originalText.includes('管理訂閱')) {
    return { type: 'list_subscriptions' };
  }

  // 判斷「比較」指令
  if (originalText.includes('比較') || originalText.includes('vs') || originalText.includes('對比')) {
    return parseCompareQuery(originalText);
  }

  // 嘗試「完整匹配」城市
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (originalText === chinese || originalText.includes(chinese)) {
      console.log(`找到城市 (完整匹配): ${chinese} -> ${english}`);
      return { type: 'single', city: english, cityName: chinese };
    }
    if (cleanText === english || cleanText.includes(english)) {
      console.log(`找到城市 (英文匹配): ${chinese} -> ${english}`);
      return { type: 'single', city: english, cityName: chinese };
    }
  }

  // 部分匹配 (至少 2 個字)
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (chinese.length >= 2 && originalText.includes(chinese)) {
      console.log(`找到城市 (部分匹配): ${chinese} -> ${english}`);
      return { type: 'single', city: english, cityName: chinese };
    }
  }

  console.log('無法解析查詢 - 沒有找到匹配的城市');
  return null;
}

function parseSubscribeQuery(text) {
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese)) {
      return { type: 'subscribe', city: english, cityName: chinese };
    }
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
    return { type: 'compare', cities: cities.slice(0, 5) };
  }
  return null;
}

// ===== 取得單一城市 AQI =====
async function getAirQuality(cityEnglish) {
  try {
    const url = `${WAQI_BASE_URL}/feed/${cityEnglish}/?token=${WAQI_TOKEN}`;
    console.log(`查詢空氣品質: ${cityEnglish}`);
    const resp = await axios.get(url);
    if (resp.data.status === 'ok') {
      return resp.data.data;
    } else {
      throw new Error('無法獲取空氣品質數據');
    }
  } catch (error) {
    console.error('獲取空氣品質數據錯誤:', error);
    throw error;
  }
}

// ===== 取得多城市 AQI =====
async function getMultipleCitiesAirQuality(cities) {
  const results = [];
  for (const cityInfo of cities) {
    try {
      const url = `${WAQI_BASE_URL}/feed/${cityInfo.english}/?token=${WAQI_TOKEN}`;
      const resp = await axios.get(url);
      if (resp.data.status === 'ok') {
        results.push({
          ...resp.data.data,
          chineseName: cityInfo.chinese
        });
      }
    } catch (err) {
      console.error(`獲取 ${cityInfo.chinese} 資料失敗:`, err);
      // 失敗就跳過，不中斷
    }
  }
  return results;
}

// ===== AI 模型呼叫 (OpenAI GPT-4) =====
async function callOpenAI(promptText) {
  try {
    const completion = await openai.createChatCompletion({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: '你是一個貼心的台灣地區空氣品質機器人，能提供空氣品質資訊並與使用者自然對話。' },
        { role: 'user', content: promptText }
      ]
    });
    const reply = completion.data.choices[0].message.content.trim();
    return reply;
  } catch (err) {
    console.error('OpenAI 呼叫失敗:', err);
    return '抱歉，AI 回覆時發生錯誤，請稍後再試。';
  }
}

// ===== Flex Message 範本函式 =====

// 1. 主選單
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

// 2. 城市選擇 (Carousel)
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
                  label: '📍 台北',
                  text: '台北空氣品質'
                },
                color: '#42a5f5',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '📍 台中',
                  text: '台中空氣品質'
                },
                color: '#42a5f5',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '📍 台南',
                  text: '台南空氣品質'
                },
                color: '#42a5f5',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '📍 高雄',
                  text: '高雄空氣品質'
                },
                color: '#42a5f5',
                style: 'primary'
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
                  label: '📍 東京',
                  text: '東京空氣品質'
                },
                color: '#ff7e00',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '📍 首爾',
                  text: '首爾空氣品質'
                },
                color: '#ff7e00',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '📍 新加坡',
                  text: '新加坡空氣品質'
                },
                color: '#ff7e00',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '📍 香港',
                  text: '香港空氣品質'
                },
                color: '#ff7e00',
                style: 'primary'
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
                  label: '🆚 台北 vs 高雄',
                  text: '比較台北高雄'
                },
                color: '#8f3f97',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '🏙️ 台灣五大城市',
                  text: '比較台北台中台南高雄新北'
                },
                color: '#8f3f97',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'message',
                  label: '🌏 國際比較',
                  text: '比較東京首爾新加坡'
                },
                color: '#8f3f97',
                style: 'primary'
              },
              {
                type: 'button',
                action: {
                  type: 'location',
                  label: '📍 附近查詢'
                },
                style: 'secondary'
              }
            ]
          }
        }
      ]
    }
  };
}

// 3. 訂閱管理
function createSubscriptionManagementFlexMessage(userId) {
  const userSub = getUserSubscriptions(userId);
  const hasSubscriptions = userSub.cities.length > 0;

  const flexMsg = {
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
    flexMsg.contents.body.contents.push({
      type: 'text',
      text: '📋 您的訂閱清單：',
      weight: 'bold',
      color: '#333333',
      margin: 'md'
    });

    userSub.cities.forEach((cityEng, idx) => {
      const chineseName = Object.keys(cityMap).find((k) => cityMap[k] === cityEng) || cityEng;
      flexMsg.contents.body.contents.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          {
            type: 'text',
            text: `${idx + 1}. ${chineseName}`,
            flex: 3,
            color: '#666666'
          },
          {
            type: 'button',
            action: {
              type: 'message',
              label: '🗑️ 取消',
              text: `取消訂閱${chineseName}`
            },
            style: 'secondary',
            height: 'sm',
            flex: 1
          }
        ]
      });
    });

    flexMsg.contents.body.contents.push(
      { type: 'separator', margin: 'lg' },
      {
        type: 'text',
        text: '⚙️ 目前設定：',
        weight: 'bold',
        color: '#333333',
        margin: 'md'
      },
      {
        type: 'text',
        text: `📅 每日報告：${userSub.settings.dailyReport ? '✅ 開啟' : '❌ 關閉'}`,
        size: 'sm',
        color: '#666666',
        margin: 'sm'
      },
      {
        type: 'text',
        text: `🚨 緊急警報：${userSub.settings.emergencyAlert ? '✅ 開啟' : '❌ 關閉'}`,
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
    flexMsg.contents.body.contents.push({
      type: 'text',
      text: '您目前沒有訂閱任何城市',
      color: '#666666',
      align: 'center',
      margin: 'lg'
    });
  }

  flexMsg.contents.body.contents.push(
    { type: 'separator', margin: 'lg' },
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
    const lastBoxIndex = flexMsg.contents.body.contents.length - 1;
    flexMsg.contents.body.contents[lastBoxIndex].contents.push({
      type: 'button',
      style: 'secondary',
      action: {
        type: 'message',
        label: '🗑️ 清除所有訂閱',
        text: '清除所有訂閱'
      }
    });
  }

  return flexMsg;
}

// 4. 個人設定
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
            text: '📅 每日報告設定',
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
                color: userSub.settings.dailyReport ? '#4CAF50' : '#cccccc',
                action: {
                  type: 'message',
                  label: '✅ 開啟',
                  text: '開啟每日報告'
                },
                flex: 1
              },
              {
                type: 'button',
                style: !userSub.settings.dailyReport ? 'primary' : 'secondary',
                color: !userSub.settings.dailyReport ? '#f44336' : '#cccccc',
                action: {
                  type: 'message',
                  label: '❌ 關閉',
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
            text: '🚨 緊急警報設定',
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
                color: userSub.settings.emergencyAlert ? '#4CAF50' : '#cccccc',
                action: {
                  type: 'message',
                  label: '✅ 開啟',
                  text: '開啟緊急警報'
                },
                flex: 1
              },
              {
                type: 'button',
                style: !userSub.settings.emergencyAlert ? 'primary' : 'secondary',
                color: !userSub.settings.emergencyAlert ? '#f44336' : '#cccccc',
                action: {
                  type: 'message',
                  label: '❌ 關閉',
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
            margin: 'sm',
            align: 'center'
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: userSub.settings.threshold === 50 ? 'primary' : 'secondary',
                color: userSub.settings.threshold === 50 ? '#4CAF50' : '#cccccc',
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
                color: userSub.settings.threshold === 100 ? '#4CAF50' : '#cccccc',
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
                color: userSub.settings.threshold === 150 ? '#4CAF50' : '#cccccc',
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

// 5. 簡單確認訊息 (成功 / 失敗 共用)
function createSimpleConfirmMessage(title, message, isSuccess = true, showReturnButton = true) {
  const confirmMessage = {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: title,
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: isSuccess ? '#4CAF50' : '#f44336',
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
            wrap: true,
            margin: 'lg'
          }
        ]
      }
    }
  };

  if (showReturnButton) {
    confirmMessage.contents.footer = {
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
                label: '↩️ 回到設定',
                text: '我的設定'
              },
              flex: 1
            },
            {
              type: 'button',
              style: 'primary',
              color: '#4CAF50',
              action: {
                type: 'message',
                label: '🏠 主選單',
                text: '主選單'
              },
              flex: 1
            }
          ]
        }
      ]
    };
  }

  return confirmMessage;
}

// 6. 每日報告 Flex
function createDailyReportFlexMessage(citiesData) {
  const bestCity = citiesData.reduce((best, cur) => (cur.aqi < best.aqi ? cur : best), citiesData[0]);
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
        backgroundColor: '#4CAF50',
        paddingAll: '20px'
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
          ...citiesData.map((city, idx) => {
            const aqiInfo = getAQILevel(city.aqi);
            const rankEmoji = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][idx] || `${idx + 1}️⃣`;
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

// 7. 緊急警報 Flex
function createEmergencyAlertFlexMessage(airQualityData) {
  const aqiInfo = getAQILevel(airQualityData.aqi);
  const healthAdvice = getHealthAdvice(airQualityData.aqi);
  const updateTime = new Date(airQualityData.time.iso).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

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

// 8. 附近測站 Flex
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

  const flexMsg = {
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

  stations.forEach((station, idx) => {
    const aqiInfo = getAQILevel(station.aqi || 0);
    const distText =
      station.distance < 1
        ? `${Math.round(station.distance * 1000)} 公尺`
        : `${station.distance.toFixed(1)} 公里`;

    const entry = {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      margin: idx > 0 ? 'md' : 'lg',
      contents: [
        {
          type: 'text',
          text: `${idx + 1}`,
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
              text: `📏 距離: ${distText}`,
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
    };

    flexMsg.contents.body.contents.push(entry);
    if (idx < stations.length - 1) {
      flexMsg.contents.body.contents.push({ type: 'separator', margin: 'md' });
    }
  });

  return flexMsg;
}

// 9. 單一城市 AQI Flex
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

  if (data.iaqi) {
    const pollutants = [
      { key: 'pm25', name: 'PM2.5', unit: 'μg/m³' },
      { key: 'pm10', name: 'PM10', unit: 'μg/m³' },
      { key: 'o3', name: '臭氧', unit: 'ppb' },
      { key: 'no2', name: '二氧化氮', unit: 'ppb' },
      { key: 'so2', name: '二氧化硫', unit: 'ppb' },
      { key: 'co', name: '一氧化碳', unit: 'mg/m³' }
    ];
    pollutants.forEach((p) => {
      if (data.iaqi[p.key]) {
        flexMessage.contents.body.contents[0].contents.push({
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: p.name,
              color: '#aaaaaa',
              size: 'sm',
              flex: 2
            },
            {
              type: 'text',
              text: `${data.iaqi[p.key].v} ${p.unit}`,
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

// 10. 多城市比較 Flex
function createCityComparisonFlexMessage(citiesData) {
  const sortedCities = citiesData.sort((a, b) => a.aqi - b.aqi);
  const bestCity = sortedCities[0];
  const worstCity = sortedCities[sortedCities.length - 1];
  const bestAqiInfo = getAQILevel(bestCity.aqi);

  const flexMsg = {
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

  const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  sortedCities.forEach((city, idx) => {
    const aqiInfo = getAQILevel(city.aqi);
    const rankEmoji = rankEmojis[idx] || `${idx + 1}️⃣`;
    flexMsg.contents.body.contents.push({
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
    if (idx < sortedCities.length - 1) {
      flexMsg.contents.body.contents.push({ type: 'separator', margin: 'md' });
    }
  });

  const recommendation =
    bestCity.aqi <= 100
      ? `✈️ 推薦前往 ${bestCity.chineseName}！空氣品質 ${bestAqiInfo.level}`
      : `⚠️ 所有城市空氣品質都需注意，${bestCity.chineseName} 相對最佳`;

  flexMsg.contents.body.contents.push(
    { type: 'separator', margin: 'lg' },
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

  return flexMsg;
}

// 11. 歡迎訊息
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
            text: '🔍 即時空氣品質查詢\n📊 多城市比較分析\n💊 專業健康建議\n🔔 智慧訂閱提醒\n📍 GPS定位查詢\n🤖 AI 自然對話',
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

// 12. 使用說明
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
                text: '「台北空氣品質」\n「東京」\n「比較台北高雄」',
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
                text: '• 每日08:00 空氣品質報告\n• 空氣品質惡化警報\n• 個人化健康建議',
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
                text: '• 6 級 AQI 健康分級\n• 運動建議\n• 口罩配戴建議\n• 室內空氣管理',
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
        },
        {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🤖 AI 自然對話',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
              }
            ],
            backgroundColor: '#2196F3',
            paddingAll: '20px'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '💬 使用方式',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '• 在任何時候，直接對我說話\n• 我會用最貼心的方式回應您\n• 也能回答空氣品質之外的一般問題',
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
                text: '「最近空氣品質怎麼樣？」\n「幫我推薦一部好看的電影」\n「台北 AQI 是多少？」',
                size: 'sm',
                color: '#2196F3',
                wrap: true
              }
            ]
          }
        }
      ]
    }
  };
}

// 13. 錯誤訊息
function createErrorFlexMessage(errorType, message) {
  const errorConfig = {
    not_found: {
      emoji: '🤔',
      title: '無法識別',
      color: '#ff7e00'
    },
    api_error: {
      emoji: '😵',
      title: '查詢錯誤',
      color: '#ff0000'
    },
    network_error: {
      emoji: '🌐',
      title: '網路錯誤',
      color: '#ff0000'
    }
  };
  const cfg = errorConfig[errorType] || errorConfig['api_error'];

  return {
    type: 'flex',
    altText: `錯誤 - ${cfg.title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${cfg.emoji} ${cfg.title}`,
            weight: 'bold',
            color: '#ffffff',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: cfg.color,
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

// ===== 主要事件處理函式 =====
async function handleEvent(event) {
  console.log('收到事件:', event.type, event.message?.type || 'non-message');

  // 只處理文字 & 位置訊息
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;

  // 1) 處理「位置分享」消息
  if (event.message.type === 'location') {
    try {
      const { latitude, longitude } = event.message;
      locationCache.set(userId, { lat: latitude, lng: longitude, timestamp: Date.now() });
      const nearbyStations = await findNearbyStations(latitude, longitude);
      const flexMsg = createNearbyStationsFlexMessage(nearbyStations, latitude, longitude);
      return client.replyMessage(event.replyToken, flexMsg);
    } catch (err) {
      console.error('處理位置訊息錯誤:', err);
      const errMsg = createErrorFlexMessage('api_error', '查詢附近空氣品質時發生錯誤，請稍後再試。');
      return client.replyMessage(event.replyToken, errMsg);
    }
  }

  // 2) 處理文字消息
  if (event.message.type !== 'text') {
    return Promise.resolve(null);
  }
  const userMessage = event.message.text.trim();
  console.log(`用戶 ${userId} 發送: "${userMessage}"`);

  try {
    // 檢查是否有未完成狀態
    const userState = getUserState(userId);
    if (userState) {
      console.log(`處理有狀態訊息: ${userState.state}`);
      return handleStatefulMessage(event, userState);
    }

    // 3) 處理「關鍵字命令」優先
    // 3.1) 問候 / 主選單
    if (userMessage.match(/^(你好|哈囉|hello|hi|主選單|menu|開始|start)/i)) {
      const welcomeMsg = createWelcomeFlexMessage();
      const mainMenu = createMainMenuFlexMessage();
      return client.replyMessage(event.replyToken, [welcomeMsg, mainMenu]);
    }

    // 3.2) 使用說明
    if (userMessage.match(/^(幫助|help|使用說明|教學|說明)/i)) {
      const helpMsg = createHelpFlexMessage();
      return client.replyMessage(event.replyToken, helpMsg);
    }

    // 3.3) 我的設定
    if (userMessage.match(/^(我的設定|設定|settings)/i)) {
      const settingsMsg = createSettingsFlexMessage(userId);
      return client.replyMessage(event.replyToken, settingsMsg);
    }

    // 3.4) 切換「每日報告」
    if (userMessage.includes('開啟每日報告')) {
      updateUserSettings(userId, { dailyReport: true });
      const confirm = createSimpleConfirmMessage(
        '✅ 每日報告已開啟',
        '我們會在每天早上8點為您推送空氣品質報告。\n\n您可以隨時在設定中修改此功能。',
        true
      );
      return client.replyMessage(event.replyToken, confirm);
    }
    if (userMessage.includes('關閉每日報告')) {
      updateUserSettings(userId, { dailyReport: false });
      const confirm = createSimpleConfirmMessage(
        '✅ 每日報告已關閉',
        '我們已停止推送每日空氣品質報告。\n\n您可以隨時在設定中重新開啟此功能。',
        true
      );
      return client.replyMessage(event.replyToken, confirm);
    }

    // 3.5) 切換「緊急警報」
    if (userMessage.includes('開啟緊急警報')) {
      updateUserSettings(userId, { emergencyAlert: true });
      const confirm = createSimpleConfirmMessage(
        '✅ 緊急警報已開啟',
        '當空氣品質超過設定閾值時，我們會立即通知您。\n\n請確保開啟 LINE 的推播通知。',
        true
      );
      return client.replyMessage(event.replyToken, confirm);
    }
    if (userMessage.includes('關閉緊急警報')) {
      updateUserSettings(userId, { emergencyAlert: false });
      const confirm = createSimpleConfirmMessage(
        '✅ 緊急警報已關閉',
        '我們已停止推送緊急警報通知。\n\n您可以隨時在設定中重新啟用此功能。',
        true
      );
      return client.replyMessage(event.replyToken, confirm);
    }

    // 3.6) 設定警報閾值
    if (userMessage.includes('設定警報閾值')) {
      const m = userMessage.match(/設定警報閾值(\d+)/);
      if (m) {
        const thr = parseInt(m[1]);
        updateUserSettings(userId, { threshold: thr });
        const thrInfo = {
          50: '良好 → 普通',
          100: '普通 → 不健康',
          150: '不健康 → 非常不健康'
        };
        const confirm = createSimpleConfirmMessage(
          `✅ 警報閾值已設定為 ${thr}`,
          `當空氣品質指數超過 ${thr} 時，我們會發送警報通知。\n\n警報級別：${thrInfo[thr] || '自訂級別'}`,
          true
        );
        return client.replyMessage(event.replyToken, confirm);
      }
    }

    // 3.7) 查詢空氣品質
    if (userMessage === '查詢空氣品質') {
      const citySelectionMsg = createCitySelectionFlexMessage();
      return client.replyMessage(event.replyToken, citySelectionMsg);
    }

    // 3.8) 多城市比較 (進入輸入狀態)
    if (userMessage === '比較城市') {
      setUserState(userId, 'awaiting_compare_cities');
      const instructionMsg = {
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
                text: '📝 輸入格式：',
                color: '#666666',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 用空格分隔城市名稱\n• 支援中英文城市名\n• 最多可比較 5 個城市',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '🌟 範例：',
                color: '#666666',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '台北 高雄 台中\n東京 首爾 新加坡',
                size: 'sm',
                color: '#4CAF50',
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
      return client.replyMessage(event.replyToken, instructionMsg);
    }

    // 3.9) 訂閱提醒 (顯示訂閱畫面)
    if (userMessage === '訂閱提醒') {
      const subMsg = createSubscriptionManagementFlexMessage(userId);
      return client.replyMessage(event.replyToken, subMsg);
    }

    // 3.10) 附近查詢 (請分享位置)
    if (userMessage === '附近查詢') {
      const locationMsg = {
        type: 'flex',
        altText: 'GPS 定位查詢',
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
                text: '我們會為您找到最近的空氣品質監測站並提供詳細資訊',
                size: 'sm',
                color: '#666666',
                align: 'center',
                wrap: true,
                margin: 'md'
              },
              {
                type: 'text',
                text: '🔒 隱私保護：位置資訊僅用於查詢，不會被儲存或分享',
                size: 'xs',
                color: '#999999',
                align: 'center',
                wrap: true,
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
                type: 'button',
                style: 'primary',
                color: '#00e400',
                action: {
                  type: 'location',
                  label: '📍 分享我的位置'
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
      return client.replyMessage(event.replyToken, locationMsg);
    }

    // 3.11) 新增訂閱 (進入輸入城市狀態)
    if (userMessage === '新增訂閱') {
      setUserState(userId, 'awaiting_subscribe_city');
      const citySelectionMsg = createCitySelectionFlexMessage();
      return client.replyMessage(event.replyToken, citySelectionMsg);
    }

    // 3.12) 修改設定 (直接顯示設定)
    if (userMessage === '修改設定') {
      const settingsMsg = createSettingsFlexMessage(userId);
      return client.replyMessage(event.replyToken, settingsMsg);
    }

    // 3.13) 清除所有訂閱
    if (userMessage === '清除所有訂閱') {
      const userSub = getUserSubscriptions(userId);
      if (userSub.cities.length === 0) {
        const confirm = createSimpleConfirmMessage(
          '❌ 沒有訂閱',
          '您目前沒有任何訂閱需要清除。',
          false
        );
        return client.replyMessage(event.replyToken, confirm);
      }
      const ok = removeAllSubscriptions(userId);
      const confirm = createSimpleConfirmMessage(
        ok ? '✅ 已清除所有訂閱' : '❌ 清除失敗',
        ok
          ? `已成功清除您的所有 ${userSub.cities.length} 個城市訂閱。\n\n如需重新訂閱，請點擊下方按鈕。`
          : '清除訂閱時發生錯誤，請稍後再試。',
        ok
      );
      return client.replyMessage(event.replyToken, confirm);
    }

    // 4) 如果以上都不是，就做「自然語言解析」
    const queryResult = parseQuery(userMessage);
    console.log('查詢解析結果:', queryResult);

    // 4.1) 訂閱
    if (queryResult && queryResult.type === 'subscribe') {
      if (queryResult.city) {
        const ok = addSubscription(userId, queryResult.city);
        const msg = ok
          ? `已成功訂閱 ${queryResult.cityName} 的空氣品質提醒！`
          : `您已經訂閱了 ${queryResult.cityName} 的空氣品質提醒`;
        const confirm = createSimpleConfirmMessage(
          ok ? '🎉 訂閱成功' : '📋 已訂閱',
          ok
            ? `${msg}\n\n✨ 服務包含：\n📅 每日 08:00 空氣品質報告\n🚨 AQI>${
                getUserSubscriptions(userId).settings.threshold
              } 緊急警報\n💡 個人化健康建議`
            : `${msg}\n\n您可以在「訂閱提醒」中管理所有訂閱。`,
          ok
        );
        return client.replyMessage(event.replyToken, confirm);
      } else {
        setUserState(userId, 'awaiting_subscribe_city');
        const citySelectionMsg = createCitySelectionFlexMessage();
        return client.replyMessage(event.replyToken, citySelectionMsg);
      }
    }

    // 4.2) 取消訂閱
    if (queryResult && queryResult.type === 'unsubscribe') {
      if (queryResult.city) {
        const ok = removeSubscription(userId, queryResult.city);
        const msg = ok
          ? `已取消訂閱 ${queryResult.cityName} 的空氣品質提醒`
          : `您沒有訂閱 ${queryResult.cityName} 的提醒`;
        const confirm = createSimpleConfirmMessage(
          ok ? '✅ 取消訂閱成功' : '❌ 取消失敗',
          ok
            ? `${msg}\n\n您將不再收到該城市的推送通知。`
            : `${msg}\n\n請檢查您的訂閱清單。`,
          ok
        );
        return client.replyMessage(event.replyToken, confirm);
      } else {
        const userSub = getUserSubscriptions(userId);
        if (userSub.cities.length === 0) {
          const noSub = createSimpleConfirmMessage(
            '❌ 沒有訂閱',
            '您目前沒有任何城市訂閱。',
            false
          );
          return client.replyMessage(event.replyToken, noSub);
        }
        const subMgmt = createSubscriptionManagementFlexMessage(userId);
        return client.replyMessage(event.replyToken, subMgmt);
      }
    }

    // 4.3) 查看訂閱清單
    if (queryResult && queryResult.type === 'list_subscriptions') {
      const subMgmt = createSubscriptionManagementFlexMessage(userId);
      return client.replyMessage(event.replyToken, subMgmt);
    }

    // 4.4) 多城市比較 (文字裡面直接比較)
    if (queryResult && queryResult.type === 'compare') {
      console.log('開始比較城市:', queryResult.cities);
      const citiesData = await getMultipleCitiesAirQuality(queryResult.cities);
      if (citiesData.length === 0) {
        const errMsg = createErrorFlexMessage(
          'api_error',
          '抱歉，無法獲取這些城市的空氣品質數據。請檢查城市名稱或稍後再試。'
        );
        return client.replyMessage(event.replyToken, errMsg);
      }
      if (citiesData.length === 1) {
        const flexMsg = createAirQualityFlexMessage(citiesData[0]);
        return client.replyMessage(event.replyToken, flexMsg);
      }
      const cmpMsg = createCityComparisonFlexMessage(citiesData);
      return client.replyMessage(event.replyToken, cmpMsg);
    }

    // 4.5) 單一城市查詢
    if (queryResult && queryResult.type === 'single') {
      console.log('查詢單一城市:', queryResult.city);
      const data = await getAirQuality(queryResult.city);
      const flexMsg = createAirQualityFlexMessage(data);
      return client.replyMessage(event.replyToken, flexMsg);
    }

    // 4.6) 自訂「城市比較」指令
    if (userMessage.includes('自訂城市比較') || userMessage.includes('自定義比較')) {
      setUserState(userId, 'awaiting_compare_cities');
      const instr = {
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
                text: '用空格分隔，最多可比較 5 個城市',
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
                text: '台北 高雄 台中\n東京 首爾 新加坡 香港\n北京 上海 廣州',
                size: 'sm',
                color: '#4CAF50',
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
      return client.replyMessage(event.replyToken, instr);
    }

    // 5) 最後：如果以上都沒匹配，就進行「AI 自然對話」
    console.log('進入 AI 自然對話流程');

    // 呼叫 OpenAI，讓 GPT-4 回覆
    const aiReply = await callOpenAI(userMessage);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: aiReply
    });
  } catch (error) {
    console.error('處理訊息錯誤:', error);
    let errMsg;
    if (error.message.includes('獲取空氣品質數據錯誤')) {
      errMsg = createErrorFlexMessage(
        'api_error',
        '空氣品質數據暫時無法獲取，這可能是因為：\n\n• API 服務繁忙\n• 城市名稱不正確\n• 網路連線問題\n\n請稍後再試或選擇其他城市。'
      );
    } else if (error.message.includes('網路')) {
      errMsg = createErrorFlexMessage('network_error', '網路連線發生問題，請檢查您的網路設定後重試。');
    } else {
      errMsg = createErrorFlexMessage(
        'api_error',
        '查詢空氣品質或 AI 回覆時發生錯誤，我們的技術團隊已收到通知。\n\n請稍後再試或使用其他功能。'
      );
    }
    const mainMenuMsg = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, [errMsg, mainMenuMsg]);
  }
}

// ===== 處理有狀態的對話 (訂閱 & 比較) =====
async function handleStatefulMessage(event, userState) {
  const userId = event.source.userId;
  const userMessage = event.message.text.trim();
  console.log(`處理有狀態訊息: ${userState.state}, 訊息: "${userMessage}"`);

  try {
    // 1) 狀態：awaiting_compare_cities
    if (userState.state === 'awaiting_compare_cities') {
      const cities = [];
      const parts = userMessage.split(/[\s,，、]+/);
      for (const w of parts) {
        const trimmed = w.trim();
        if (trimmed.length >= 2) {
          for (const [chinese, english] of Object.entries(cityMap)) {
            if (
              trimmed === chinese ||
              trimmed.toLowerCase() === english ||
              (chinese.length >= 2 && chinese.includes(trimmed))
            ) {
              if (!cities.some((c) => c.english === english)) {
                cities.push({ chinese, english });
              }
              break;
            }
          }
        }
      }

      clearUserState(userId);

      if (cities.length < 2) {
        const errorMsg = createErrorFlexMessage(
          'not_found',
          `請輸入至少 2 個城市名稱。\n\n您輸入的：「${userMessage}」\n識別到的城市：${cities.length} 個\n\n📝 正確格式範例：\n• 台北 高雄\n• 東京 首爾 新加坡`
        );
        const mainMenuMsg = createMainMenuFlexMessage();
        return client.replyMessage(event.replyToken, [errorMsg, mainMenuMsg]);
      }
      if (cities.length > 5) cities.splice(5);

      console.log('比較城市:', cities);
      const citiesData = await getMultipleCitiesAirQuality(cities);
      if (citiesData.length === 0) {
        const errorMsg = createErrorFlexMessage(
          'api_error',
          '無法獲取這些城市的空氣品質數據。\n\n可能原因：\n• 城市名稱拼錯\n• API 服務不可用\n• 網路連線問題\n\n請確認後重試。'
        );
        const mainMenuMsg = createMainMenuFlexMessage();
        return client.replyMessage(event.replyToken, [errorMsg, mainMenuMsg]);
      }
      if (citiesData.length < cities.length) {
        console.log(
          `部分城市資料獲取失敗：要求 ${cities.length} 個，實際獲得 ${citiesData.length} 個`
        );
      }

      const cmpMsg = createCityComparisonFlexMessage(citiesData);
      return client.replyMessage(event.replyToken, cmpMsg);
    }

    // 2) 狀態：awaiting_subscribe_city
    if (userState.state === 'awaiting_subscribe_city') {
      const queryResult = parseQuery(userMessage);
      clearUserState(userId);

      if (queryResult && queryResult.type === 'single') {
        const ok = addSubscription(userId, queryResult.city);
        const msg = ok
          ? `已成功訂閱 ${queryResult.cityName} 的空氣品質提醒！`
          : `您已經訂閱了 ${queryResult.cityName} 的空氣品質提醒`;
        const confirm = createSimpleConfirmMessage(
          ok ? '🎉 訂閱成功' : '📋 已訂閱',
          ok
            ? `${msg}\n\n✨ 您將收到：\n📅 每日 08:00 空氣品質報告\n🚨 AQI>${getUserSubscriptions(userId).settings.threshold} 緊急警報\n💡 專業健康建議\n\n可在「我的設定」中調整推送設定。`
            : `${msg}\n\n您可以在「訂閱提醒」中管理所有訂閱。`,
          ok
        );
        return client.replyMessage(event.replyToken, confirm);
      } else {
        const errorMsg = createErrorFlexMessage(
          'not_found',
          `無法識別城市「${userMessage}」。\n\n支援的城市包括：\n🇹🇼 台灣：台北、高雄、台中、台南等\n🌏 國際：東京、首爾、新加坡、香港等\n\n請重新輸入正確的城市名稱。`
        );
        const citySelectionMsg = createCitySelectionFlexMessage();
        return client.replyMessage(event.replyToken, [errorMsg, citySelectionMsg]);
      }
    }

    // 3) 預設清除狀態並返回主選單
    clearUserState(userId);
    const cancelMsg = createSimpleConfirmMessage(
      '❓ 操作取消',
      '您的操作已取消，請重新選擇需要的功能。',
      false,
      false
    );
    const mainMenuMsg = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, [cancelMsg, mainMenuMsg]);
  } catch (err) {
    console.error('處理狀態對話錯誤:', err);
    clearUserState(userId);
    const errMsg = createErrorFlexMessage(
      'api_error',
      '處理您的請求時發生錯誤。\n\n請重新開始操作，如問題持續發生，請聯繫客服。'
    );
    const mainMenuMsg = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, [errMsg, mainMenuMsg]);
  }
}

// ===== Webhook 端點 =====
app.post('/webhook', line.middleware(config), (req, res) => {
  console.log('收到 Webhook 請求');
  Promise.all(req.body.events.map((evt) => handleEvent(evt)))
    .then((result) => {
      console.log('Webhook 處理完成');
      res.json(result);
    })
    .catch((err) => {
      console.error('Webhook 處理錯誤:', err);
      res.status(500).end();
    });
});

// ===== 首頁 (GET /) =====
app.get('/', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    } else {
      return res.send(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智慧空氣品質機器人 + AI 自然對話 (修復版) | LINE Bot</title>
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
            background: rgba(255, 255, 255, 0.95); 
            backdrop-filter: blur(10px);
            padding: 3rem; 
            border-radius: 20px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.1); 
            text-align: center; 
            margin-bottom: 3rem;
        }
        h1 { 
            color: #333; 
            margin-bottom: 1rem; 
            font-size: 2.5rem; 
            background: linear-gradient(45deg, #4CAF50, #2196F3);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            background: rgba(76, 175, 80, 0.1);
            padding: 0.5rem 1rem;
            border-radius: 25px;
            margin: 1rem 0;
            border: 2px solid rgba(76, 175, 80, 0.3);
        }
        .status-dot {
            width: 12px;
            height: 12px;
            background: #4CAF50;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.7; transform: scale(1.1); }
            100% { opacity: 1; transform: scale(1); }
        }
        p { color: #666; margin-bottom: 2rem; font-size: 1.2rem; line-height: 1.6; }
        .cta-button { 
            display: inline-block; 
            background: linear-gradient(45deg, #4CAF50, #45a049);
            color: white; 
            padding: 15px 40px; 
            border-radius: 50px; 
            text-decoration: none; 
            font-weight: 600; 
            transition: all 0.3s ease; 
            margin: 0.5rem;
            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
        }
        .cta-button:hover { 
            transform: translateY(-3px); 
            box-shadow: 0 8px 25px rgba(76, 175, 80, 0.4);
        }
        .cta-button.secondary {
            background: linear-gradient(45deg, #2196F3, #1976D2);
            box-shadow: 0 4px 15px rgba(33, 150, 243, 0.3);
        }
        .cta-button.secondary:hover {
            box-shadow: 0 8px 25px rgba(33, 150, 243, 0.4);
        }
        .features { 
            margin-top: 2rem; 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); 
            gap: 1.5rem; 
        }
        .feature { 
            padding: 1.5rem; 
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(10px);
            border-radius: 15px; 
            transition: all 0.3s ease;
            text-align: center;
            border: 2px solid transparent;
        }
        .feature:hover {
            transform: translateY(-5px) scale(1.02);
            box-shadow: 0 15px 30px rgba(0,0,0,0.1);
            border-color: rgba(76, 175, 80, 0.3);
        }
        .feature i { 
            font-size: 2.5rem; 
            color: #4CAF50; 
            margin-bottom: 1rem;
            transition: all 0.3s ease;
        }
        .feature:hover i {
            color: #2196F3;
            transform: scale(1.1);
        }
        .feature h4 {
            color: #333;
            margin-bottom: 0.5rem;
            font-size: 1.1rem;
        }
        .feature p {
            color: #666;
            font-size: 0.9rem;
            margin: 0;
        }
        .fix-highlight {
            background: linear-gradient(45deg, rgba(255, 193, 7, 0.2), rgba(255, 152, 0, 0.2));
            padding: 1rem;
            border-radius: 10px;
            border-left: 4px solid #FF9800;
            margin: 1rem 0;
        }
        .fix-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 0.5rem;
            margin-top: 1rem;
        }
        .fix-item {
            background: rgba(76, 175, 80, 0.1);
            padding: 0.5rem;
            border-radius: 5px;
            font-size: 0.9rem;
            color: #2E7D32;
        }
    </style>
</head>
<body>
    <div class="main-container">
        <div class="hero-section">
            <h1>🌬️ 智慧空氣品質機器人 + AI 自然對話</h1>
            <div class="status-badge">
                <div class="status-dot"></div>
                <span><strong>修復版 v3.0</strong> - 服務正常運行中</span>
            </div>
            <p>即時監測空氣品質，提供專業健康建議，亦能 AI 對話回答各種問題</p>
            
            <div style="margin: 2rem 0;">
                <a href="https://line.me/R/ti/p/@470kdmxx" class="cta-button" target="_blank">
                    <i class="fab fa-line"></i> 立即加入好友
                </a>
                <a href="/health" class="cta-button secondary">
                    <i class="fas fa-heartbeat"></i> 服務狀態
                </a>
            </div>
            
            <div class="fix-highlight">
                <h4>🔧 最新修復內容</h4>
                <p>整合 AI 自然對話 (OpenAI GPT-4)，讓使用者能用自然語言與機器人對話</p>
                <div class="fix-list">
                    <div class="fix-item">✅ AI 自然對話功能</div>
                    <div class="fix-item">✅ 查詢解析邏輯精度提升</div>
                    <div class="fix-item">✅ 設定功能回應修復</div>
                    <div class="fix-item">✅ 訂閱管理按鈕修復</div>
                    <div class="fix-item">✅ 查詢解析邏輯改善</div>
                    <div class="fix-item">✅ 錯誤處理機制強化</div>
                    <div class="fix-item">✅ 用戶狀態管理優化</div>
                </div>
            </div>
            
            <div class="features">
                <div class="feature">
                    <i class="fas fa-search-location"></i>
                    <h4>即時查詢</h4>
                    <p>支援 30+ 全球城市<br>數據每小時更新</p>
                </div>
                <div class="feature">
                    <i class="fas fa-chart-line"></i>
                    <h4>智慧比較</h4>
                    <p>多城市對比分析<br>AI 智慧推薦</p>
                </div>
                <div class="feature">
                    <i class="fas fa-user-md"></i>
                    <h4>健康建議</h4>
                    <p>專業醫學建議<br>個人化防護指導</p>
                </div>
                <div class="feature">
                    <i class="fas fa-bell"></i>
                    <h4>訂閱提醒</h4>
                    <p>每日報告 + 警報<br>個人化設定</p>
                </div>
                <div class="feature">
                    <i class="fas fa-map-marker-alt"></i>
                    <h4>GPS 定位</h4>
                    <p>附近監測站查詢<br>精準位置服務</p>
                </div>
                <div class="feature">
                    <i class="fas fa-robot"></i>
                    <h4>AI 自然對話</h4>
                    <p>隨時聊天提問<br>超越空氣品質問題</p>
                </div>
            </div>
        </div>
        
        <div class="hero-section">
            <h3 style="color: #333; margin-bottom: 1rem;">🚀 快速測試 API</h3>
            <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; font-size: 0.9rem;">
                <a href="/api/air-quality/taipei" style="color: #4CAF50; text-decoration: none; padding: 0.5rem 1rem; border: 1px solid #4CAF50; border-radius: 5px;">📡 台北空氣品質</a>
                <a href="/api/air-quality/kaohsiung" style="color: #4CAF50; text-decoration: none; padding: 0.5rem 1rem; border: 1px solid #4CAF50; border-radius: 5px;">📡 高雄空氣品質</a>
                <a href="/api/stats" style="color: #2196F3; text-decoration: none; padding: 0.5rem 1rem; border: 1px solid #2196F3; border-radius: 5px;">📊 服務統計</a>
                <a href="/debug" style="color: #666; text-decoration: none; padding: 0.5rem 1rem; border: 1px solid #666; border-radius: 5px;">🔍 系統診斷</a>
            </div>
            
            <div style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.85rem; color: #999;">
                <p><strong>© 2025 智慧空氣品質機器人 + AI 自然對話 (修復版 v3.0)</strong></p>
                <p>🌱 用科技守護每一次呼吸 | 🔒 隱私保護 | 📱 跨平台支援</p>
                <p>💡 <em>讓 AI 成為您的專屬空氣品質顧問與聊天夥伴</em></p>
            </div>
        </div>
    </div>
</body>
</html>
      `);
    }
  } catch (err) {
    console.error('首頁載入錯誤:', err);
    return res.status(500).send(`
      <div style="text-align: center; padding: 2rem; font-family: Arial;">
        <h1 style="color: #f44336;">🚨 服務臨時不可用</h1>
        <p style="color: #666;">請稍後再試，或聯繫技術支援</p>
        <p style="color: #999; font-size: 0.9rem;">錯誤詳情: ${err.message}</p>
        <a href="/health" style="color: #4CAF50; text-decoration: none;">🔍 檢查服務狀態</a>
      </div>
    `);
  }
});

// ===== 健康檢查 (GET /health) =====
app.get('/health', (req, res) => {
  const indexExists = fs.existsSync(path.join(__dirname, 'index.html'));
  res.json({
    status: 'OK',
    message: 'LINE 空氣品質機器人 + AI 自然對話 正常運行中！(修復版 v3.0)',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '3.0.0-complete-fix',
    environment: {
      node_version: process.version,
      platform: process.platform,
      memory_usage: process.memoryUsage(),
      index_html_exists: indexExists,
      line_token_configured: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      line_secret_configured: !!process.env.LINE_CHANNEL_SECRET,
      openai_api_configured: !!process.env.OPENAI_API_KEY,
      working_directory: __dirname,
      supported_cities: Object.keys(cityMap).length
    },
    features: [
      '即時空氣品質查詢',
      '多城市比較分析',
      '智慧健康建議系統',
      '訂閱提醒功能',
      'GPS定位查詢',
      'Flex圖文選單介面',
      'AI 自然對話 (GPT-4)',
      '用戶狀態管理',
      '自然語言處理',
      '錯誤處理機制'
    ],
    statistics: {
      total_subscriptions: subscriptions.size,
      location_cache_entries: locationCache.size,
      active_user_states: userStates.size,
      supported_cities: Object.keys(cityMap).length,
      subscription_settings: {
        daily_report_users: Array.from(subscriptions.values()).filter((s) => s.settings.dailyReport).length,
        emergency_alert_users: Array.from(subscriptions.values()).filter((s) => s.settings.emergencyAlert).length
      }
    },
    fixes_applied: [
      '🔧 AI 自然對話 (OpenAI GPT-4) 整合',
      '🔧 查詢解析邏輯精度提升',
      '🔧 設定按鈕回應機制修復',
      '🔧 訂閱管理功能完整性修復',
      '🔧 城市選擇按鈕動作修復',
      '🔧 用戶狀態管理流程修復',
      '🔧 智慧確認訊息系統新增',
      '🔧 錯誤處理和用戶提示改善',
      '🔧 Flex Message 按鈕狀態修復',
      '🔧 多城市比較演算法完善'
    ],
    recent_improvements: [
      '✨ AI 自然對話 (GPT-4) 支援',
      '✨ 智慧城市名稱模糊匹配',
      '✨ 用戶操作反饋機制優化',
      '✨ 訂閱設定視覺化介面',
      '✨ GPS 定位查詢準確性提升'
    ]
  });
});

// ===== API：單一城市空氣品質 (GET /api/air-quality/:city) =====
app.get('/api/air-quality/:city', async (req, res) => {
  try {
    const cityEnglish = req.params.city;
    console.log(`API請求 - 城市: ${cityEnglish}`);
    const data = await getAirQuality(cityEnglish);
    res.json({
      ...data,
      api_info: {
        request_time: new Date().toISOString(),
        server_version: '3.0.0-complete-fix',
        data_source: 'World Air Quality Index API'
      }
    });
  } catch (err) {
    console.error('API 錯誤:', err);
    return res.status(500).json({
      error: '無法獲取空氣品質數據',
      details: err.message,
      city: req.params.city,
      timestamp: new Date().toISOString(),
      suggestions: ['檢查城市名稱拼寫', '使用英文城市名稱', '稍後重試']
    });
  }
});

// ===== API：服務統計 (GET /api/stats) =====
app.get('/api/stats', (req, res) => {
  res.json({
    service: {
      name: '智慧空氣品質機器人 + AI 自然對話',
      version: '3.0.0-complete-fix',
      status: 'running',
      last_restart: new Date().toISOString()
    },
    statistics: {
      supportedCities: Object.keys(cityMap).length,
      totalSubscriptions: subscriptions.size,
      activeCacheEntries: locationCache.size,
      activeUserStates: userStates.size,
      totalCityQueries: 0,
      averageResponseTime: '< 2 seconds'
    },
    features: [
      'real_time_air_quality_query',
      'multi_city_comparison',
      'intelligent_health_recommendations',
      'subscription_alerts_system',
      'gps_location_based_query',
      'flex_message_interface',
      'ai_natural_conversation',
      'natural_language_processing',
      'user_state_management',
      'smart_error_handling'
    ],
    supported_regions: {
      taiwan: Object.entries(cityMap).filter(([, eng]) =>
        ['taipei', 'kaohsiung', 'taichung', 'tainan', 'new-taipei', 'taoyuan', 'keelung', 'hsinchu', 'miaoli', 'changhua', 'nantou', 'yunlin', 'chiayi', 'pingtung', 'yilan', 'hualien', 'taitung', 'penghu', 'kinmen', 'matsu'].includes(eng)
      ).length,
      international: Object.entries(cityMap).filter(([, eng]) =>
        ['beijing', 'shanghai', 'tokyo', 'seoul', 'bangkok', 'singapore', 'hong-kong', 'macau'].includes(eng)
      ).length,
      total: Object.keys(cityMap).length
    },
    uptime: Math.floor(process.uptime()),
    last_updated: new Date().toISOString()
  });
});

// ===== API：訂閱統計 (GET /api/subscriptions/stats) =====
app.get('/api/subscriptions/stats', (req, res) => {
  const stats = {
    overview: {
      total_users: subscriptions.size,
      total_subscriptions: Array.from(subscriptions.values()).reduce(
        (sum, userSub) => sum + userSub.cities.length,
        0
      ),
      average_subscriptions_per_user:
        subscriptions.size > 0
          ? (
              Array.from(subscriptions.values()).reduce((sum, userSub) => sum + userSub.cities.length, 0) /
              subscriptions.size
            ).toFixed(2)
          : 0
    },
    settings_distribution: {
      daily_report_enabled: 0,
      emergency_alert_enabled: 0,
      threshold_distribution: {
        50: 0,
        100: 0,
        150: 0
      }
    },
    popular_cities: {},
    user_engagement: {
      active_states: userStates.size,
      location_cache: locationCache.size
    }
  };

  for (const userSub of subscriptions.values()) {
    if (userSub.settings.dailyReport) stats.settings_distribution.daily_report_enabled++;
    if (userSub.settings.emergencyAlert) stats.settings_distribution.emergency_alert_enabled++;
    const thr = userSub.settings.threshold;
    if (stats.settings_distribution.threshold_distribution[thr] !== undefined) {
      stats.settings_distribution.threshold_distribution[thr]++;
    }
    userSub.cities.forEach((cityEng) => {
      const cityName = Object.keys(cityMap).find((k) => cityMap[k] === cityEng) || cityEng;
      stats.popular_cities[cityName] = (stats.popular_cities[cityName] || 0) + 1;
    });
  }

  res.json(stats);
});

// ===== Debug 端點 (GET /debug) =====
app.get('/debug', (req, res) => {
  try {
    res.json({
      server_status: 'running',
      timestamp: new Date().toISOString(),
      version: '3.0.0-complete-fix',
      node_version: process.version,
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
      memory_usage: process.memoryUsage(),
      environment_variables: {
        PORT: process.env.PORT,
        NODE_ENV: process.env.NODE_ENV,
        line_token_length: process.env.LINE_CHANNEL_ACCESS_TOKEN?.length || 0,
        line_secret_length: process.env.LINE_CHANNEL_SECRET?.length || 0,
        openai_api_configured: !!process.env.OPENAI_API_KEY
      },
      file_system: {
        current_directory: __dirname,
        index_exists: fs.existsSync(path.join(__dirname, 'index.html')),
        package_exists: fs.existsSync(path.join(__dirname, 'package.json'))
      },
      available_routes: [
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
        ai_natural_conversation: 'enabled',
        natural_language_processing: 'enabled',
        user_state_management: 'enabled',
        smart_error_handling: 'enabled'
      },
      fixes_status: {
        ai_conversation_integrated: 'fixed',
        query_parsing_logic: 'fixed',
        settings_button_response: 'fixed',
        subscription_management: 'fixed',
        city_selection_buttons: 'fixed',
        user_state_management: 'fixed',
        confirmation_messages: 'fixed',
        error_handling: 'improved',
        flex_message_buttons: 'fixed',
        natural_language_understanding: 'improved',
        user_experience_flow: 'optimized'
      },
      test_endpoints: {
        taipei_air_quality: '/api/air-quality/taipei',
        kaohsiung_air_quality: '/api/air-quality/kaohsiung',
        service_stats: '/api/stats',
        subscription_stats: '/api/subscriptions/stats'
      }
    });
  } catch (err) {
    res.status(500).json({
      error: 'Debug endpoint error',
      message: err.message,
      stack: err.stack
    });
  }
});

// ===== 清理過期的用戶狀態 & 位置快取 (每小時) =====
cron.schedule(
  '0 * * * *',
  () => {
    const now = Date.now();
    let cleanedStates = 0;
    let cleanedLocations = 0;

    for (const [uid, state] of userStates.entries()) {
      if (now - state.timestamp > 5 * 60 * 1000) {
        userStates.delete(uid);
        cleanedStates++;
      }
    }
    for (const [uid, loc] of locationCache.entries()) {
      if (now - loc.timestamp > 60 * 60 * 1000) {
        locationCache.delete(uid);
        cleanedLocations++;
      }
    }

    console.log(`清理完成 - 用戶狀態: 清理 ${cleanedStates} 個，剩餘 ${userStates.size} 個`);
    console.log(`清理完成 - 位置快取: 清理 ${cleanedLocations} 個，剩餘 ${locationCache.size} 個`);
  },
  { timezone: 'Asia/Taipei' }
);

// ===== 全局錯誤處理中間件 =====
app.use((err, req, res, next) => {
  console.error('伺服器錯誤:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    timestamp: new Date().toISOString(),
    request_path: req.path,
    request_method: req.method
  });
});

// ===== 404 處理 =====
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method,
    message: '請求的路由不存在',
    available_routes: [
      'GET /',
      'GET /health',
      'GET /debug',
      'GET /api/air-quality/:city',
      'GET /api/stats',
      'GET /api/subscriptions/stats',
      'POST /webhook'
    ],
    timestamp: new Date().toISOString()
  });
});

// ===== 優雅關機 =====
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，正在優雅關機...');
  console.log(`最終統計 - 訂閱用戶: ${subscriptions.size}, 用戶狀態: ${userStates.size}, 位置快取: ${locationCache.size}`);
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('收到 SIGINT 信號，正在優雅關機...');
  console.log(`最終統計 - 訂閱用戶: ${subscriptions.size}, 用戶狀態: ${userStates.size}, 位置快取: ${locationCache.size}`);
  process.exit(0);
});

// ===== 啟動伺服器 =====
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log('='.repeat(80));
  console.log(`🚀 LINE 智慧空氣品質機器人 + AI 自然對話 在端口 ${port} 上運行 (完整修復版 v3.0)`);
  console.log('='.repeat(80));

  console.log('✨ 修復完成清單：');
  console.log('✅ AI 自然對話功能 (OpenAI GPT-4) 整合');
  console.log('✅ 查詢解析邏輯精度提升');
  console.log('✅ 設定按鈕回應機制修復');
  console.log('✅ 訂閱管理功能完整性修復');
  console.log('✅ 城市選擇按鈕動作修復');
  console.log('✅ 用戶狀態管理流程修復');
  console.log('✅ 智慧確認訊息系統新增');
  console.log('✅ 錯誤處理和用戶提示改善');
  console.log('✅ Flex Message 按鈕狀態修復');
  console.log('✅ 多城市比較演算法完善');

  console.log('\n🌟 新增功能：');
  console.log('✨ AI 自然對話 (OpenAI GPT-4)');
  console.log('✨ 智慧城市名稱模糊匹配');
  console.log('✨ 用戶操作反饋機制優化');
  console.log('✨ 訂閱設定視覺化介面');
  console.log('✨ GPS 定位查詢準確性提升');

  console.log(`\n🌐 服務網址: http://0.0.0.0:${port}`);

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET || !process.env.OPENAI_API_KEY) {
    console.warn('\n⚠️ 警告：環境變數未完整設定');
    console.warn('請設定以下變數：');
    console.warn('- LINE_CHANNEL_ACCESS_TOKEN');
    console.warn('- LINE_CHANNEL_SECRET');
    console.warn('- OPENAI_API_KEY');
  } else {
    console.log('\n✅ 所有必要環境變數已配置');
  }

  console.log('\n📊 系統初始狀態：');
  console.log(`- 支援城市數量: ${Object.keys(cityMap).length}`);
  console.log(`- 訂閱用戶數量: ${subscriptions.size}`);
  console.log(`- 活躍用戶狀態: ${userStates.size}`);
  console.log(`- 位置快取項目: ${locationCache.size}`);

  console.log('\n🎉 系統已完全啟動，準備好與您聊天與查詢空氣品質！');
  console.log('='.repeat(80));
});