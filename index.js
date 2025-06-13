const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();

// Static file serving
app.use(express.static('public'));

// LINE Bot config
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// WAQI API config
const WAQI_TOKEN = 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// LINE Bot client
const client = new line.Client(config);

// Data storage
const subscriptions = new Map(); // userId -> {cities, settings}
const locationCache = new Map(); // userId -> {lat,lng,timestamp}
const userStates = new Map(); // userId -> {state, context, timestamp}
const conversationHistory = new Map(); // userId -> [{role,content,timestamp}]
const userProfiles = new Map(); // userId -> {preferences, personality, context}

// City map
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

// AIConversationEngine singleton instance
class AIConversationEngine {
  constructor() {
    this.intentPatterns = {
      greeting: [
        /^(你好|哈囉|嗨|hi|hello|早安|午安|晚安|嘿).*$/i,
        /^(在嗎|有人嗎|可以幫我嗎).*$/i
      ],
      
      air_quality_query: [
        /查詢\s*(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i,
        /^(查詢|查看|看看|檢查|問|搜尋|尋找|找)\s*(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i,
        /^(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)\s*(空氣|空品|aqi|pm2\.?5|空氣品質|的空氣|怎麼樣|如何)/i,
        /^(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)$/i,
        /(現在|今天|目前)\s*(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i
      ],
      
      subscription: [
        /訂閱\s*(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i,
        /^(訂閱|關注|追蹤|通知|加入)\s*(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i,
        /^(訂閱|關注|追蹤|通知).*?(空氣|空品|提醒).*?$/i,
        /^.*?(每日|定期|自動).*?(報告|推送|通知).*?$/i
      ],

      unsubscription: [
        /取消訂閱\s*(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i,
        /^(取消|停止|關閉).*?(訂閱|追蹤|通知).*?(台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海|曼谷|澳門)/i,
        /^.*?(取消|關閉|停止).*?(訂閱|追蹤|通知).*?$/i
      ],
      
      comparison: [
        /^.*?(比較|比一比|對比).*?(空氣|空品|aqi).*?$/i,
        /^.*?(哪裡|哪個|什麼地方).*?(空氣|空品).*?(好|佳|較好|比較好).*?$/i,
        /^.*?(台北|高雄|台中|台南).*?(vs|對|比).*?(台北|高雄|台中|台南).*?$/i
      ],
      
      health_advice: [
        /^.*?(可以|能夠|適合).*?(運動|慢跑|跑步|騎車|散步|外出).*?$/i,
        /^.*?(要|需要|該).*?(戴|配戴).*?(口罩|防護).*?$/i,
        /^.*?(健康|身體).*?(建議|影響|注意).*?$/i,
        /^.*?(敏感|過敏|氣喘|老人|小孩|孕婦).*?$/i
      ],
      
      location_query: [
        /^.*?(附近|周圍|附近的|我這裡).*?(空氣|空品|監測站).*?$/i,
        /^.*?(定位|位置|gps).*?(查詢|查看).*?$/i
      ],
      
      help_request: [
        /^.*?(幫助|幫忙|教學|怎麼用|說明|指導).*?$/i,
        /^.*?(不懂|不會|不知道|搞不清楚|怎麼辦).*?$/i
      ]
    };

    this.emotionKeywords = {
      positive: ['好', '棒', '讚', '優秀', '完美', '滿意', '開心', '高興', '謝謝', '感謝'],
      negative: ['差', '爛', '糟', '壞', '失望', '生氣', '討厭', '煩', '麻煩', '問題'],
      concern: ['擔心', '害怕', '恐怖', '憂慮', '緊張', '不安', '焦慮'],
      neutral: ['好的', '了解', '知道', '明白', '清楚', '是的', '對']
    };
  }

  analyzeIntent(text) {
    const intents = [];
    for (const [intent, patterns] of Object.entries(this.intentPatterns)) {
      for (const pattern of patterns) {
        try {
          if (pattern.test(text)) {
            const confidence = this.calculateConfidence(text, pattern);
            intents.push({ intent, confidence, pattern: pattern.toString() });
          }
        } catch (error) {
          console.error(`Regex error (${intent}):`, error);
        }
      }
    }
    intents.sort((a, b) => b.confidence - a.confidence);
    return intents.length > 0 ? intents[0] : { intent: 'unknown', confidence: 0 };
  }

  calculateConfidence(text, pattern) {
    try {
      const match = text.match(pattern);
      if (!match) return 0;
      const matchLength = match[0].length;
      const coverage = matchLength / text.length;
      let confidence = Math.min(coverage * 100, 95);
      if (coverage > 0.8) confidence += 5;
      if (match[0] === text) confidence = 100;
      return Math.round(confidence);
    } catch (error) {
      return 0;
    }
  }

  extractEntities(text) {
    const entities = { cities: [], timeReferences: [], healthConcerns: [], activities: [] };
    for (const [chineseName, englishName] of Object.entries(cityMap)) {
      const regex = new RegExp(chineseName, 'i');
      if (regex.test(text)) {
        if (!entities.cities.find(c => c.name === chineseName)) {
          entities.cities.push({ name: chineseName, english: englishName, position: text.indexOf(chineseName) });
        }
      }
    }
    const timePatterns = ['現在', '今天', '明天', '這週', '最近', '目前'];
    for (const timeRef of timePatterns) {
      if (text.includes(timeRef)) entities.timeReferences.push(timeRef);
    }
    return entities;
  }

  generatePersonalizedResponse(intent, entities, emotion, userProfile = {}) {
    switch (intent.intent) {
      case 'greeting':
        return '您好！我是智慧空氣品質助手 🌬️，很高興為您服務！';
      case 'air_quality_query':
        if (entities.cities.length > 0) {
          return `好的！讓我為您查詢 ${entities.cities[0].name} 的空氣品質 🔍`;
        }
        return '我來幫您查詢空氣品質！請告訴我您想查詢哪個城市？ 🏙️';
      case 'subscription':
        if (entities.cities.length > 0) {
          return `好的！讓我為您訂閱 ${entities.cities[0].name} 的空氣品質提醒 🔔`;
        }
        return '訂閱功能可以讓您及時收到空氣品質提醒！請告訴我您想訂閱哪個城市？ 🔔';
      case 'unsubscription':
        if (entities.cities.length > 0) {
          return `好的！讓我為您取消訂閱 ${entities.cities[0].name} 的空氣品質提醒 ❌`;
        }
        return '請告訴我您想取消訂閱哪個城市的提醒？ ❌';
      case 'comparison':
        if (entities.cities.length >= 2) {
          return `好想法！我來比較 ${entities.cities.map(c => c.name).join(' 和 ')} 的空氣品質 📊`;
        }
        return '多城市比較很實用呢！請告訴我您想比較哪些城市？ 🆚';
      case 'health_advice':
        return '健康最重要！我會根據空氣品質給您最適合的建議 💡';
      case 'help_request':
        return '沒問題！我很樂意幫助您。您可以直接告訴我想查詢的城市，或是說「主選單」看看我能做什麼！ 🆘';
      default:
        return '我聽懂了您的意思！讓我用最適合的功能來幫助您 🤖';
    }
  }
}

const aiEngineInstance = new AIConversationEngine();

// User state management
function setUserState(userId, state, context = {}) {
  userStates.set(userId, { state, context, timestamp: Date.now() });
  console.log(`📝 Set user state: ${userId} -> ${state}`);
}

function getUserState(userId) {
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < 300000) return userState;
  userStates.delete(userId);
  return null;
}

function clearUserState(userId) {
  userStates.delete(userId);
  console.log(`🗑️ Cleared user state: ${userId}`);
}

// Subscription management
function addSubscription(userId, city) {
  if (!subscriptions.has(userId)) {
    subscriptions.set(userId, {
      cities: [],
      settings: { dailyReport: true, emergencyAlert: true, threshold: 100 }
    });
  }
  const userSub = subscriptions.get(userId);
  if (!userSub.cities.includes(city)) {
    userSub.cities.push(city);
    console.log(`➕ User ${userId} subscribed: ${city}`);
    return true;
  }
  console.log(`⚠️ User ${userId} already subscribed: ${city}`);
  return false;
}

function removeSubscription(userId, city) {
  if (subscriptions.has(userId)) {
    const userSub = subscriptions.get(userId);
    const idx = userSub.cities.indexOf(city);
    if (idx !== -1) {
      userSub.cities.splice(idx, 1);
      console.log(`➖ User ${userId} removed subscription: ${city}`);
      return true;
    }
  }
  return false;
}

function removeAllSubscriptions(userId) {
  if (subscriptions.has(userId)) {
    subscriptions.delete(userId);
    console.log(`🗑️ User ${userId} cleared all subscriptions`);
    return true;
  }
  return false;
}

function getUserSubscriptions(userId) {
  return subscriptions.get(userId) || { cities: [], settings: { dailyReport: true, emergencyAlert: true, threshold: 100 } };
}
function updateUserSettings(userId, newSettings) {
  if (!subscriptions.has(userId)) {
    subscriptions.set(userId, {
      cities: [],
      settings: { dailyReport: true, emergencyAlert: true, threshold: 100 }
    });
  }
  const userSub = subscriptions.get(userId);
  userSub.settings = { ...userSub.settings, ...newSettings };
  console.log(`⚙️ User ${userId} updated settings:`, newSettings);
  return userSub.settings;
}

// AQI level and health advice helpers
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
      mask: '無需配戴口罩',
      indoor: '可開窗通風，享受新鮮空氣',
      color: '#00e400'
    };
  } else if (aqi <= 100) {
    return {
      general: '空氣品質可接受，一般人群可正常活動',
      sensitive: '敏感族群請減少長時間戶外劇烈運動',
      exercise: '適合：散步、瑜伽、輕度慢跑',
      mask: '建議配戴一般口罩',
      indoor: '可適度開窗，保持空氣流通',
      color: '#ffff00'
    };
  } else if (aqi <= 150) {
    return {
      general: '對敏感族群不健康，一般人群減少戶外活動',
      sensitive: '敏感族群應避免戶外活動',
      exercise: '建議室內運動：瑜伽、伸展、重訓',
      mask: '必須配戴N95或醫用口罩',
      indoor: '關閉門窗，使用空氣清淨機',
      color: '#ff7e00'
    };
  } else if (aqi <= 200) {
    return {
      general: '所有人群都應減少戶外活動',
      sensitive: '敏感族群請留在室內',
      exercise: '僅建議室內輕度活動',
      mask: '外出必須配戴N95口罩',
      indoor: '緊閉門窗，持續使用空氣清淨機',
      color: '#ff0000'
    };
  } else if (aqi <= 300) {
    return {
      general: '所有人群避免戶外活動',
      sensitive: '所有人應留在室內',
      exercise: '避免任何戶外運動',
      mask: '外出務必配戴N95或更高等級口罩',
      indoor: '緊閉門窗，使用高效空氣清淨機',
      color: '#8f3f97'
    };
  } else {
    return {
      general: '緊急狀況！所有人應留在室內',
      sensitive: '立即尋求室內避難場所',
      exercise: '禁止所有戶外活動',
      mask: '外出必須配戴專業防護口罩',
      indoor: '密閉室內，使用高效空氣清淨設備',
      color: '#7e0023'
    };
  }
}

// Fetch air quality for a city
async function getAirQuality(city) {
  const url = `${WAQI_BASE_URL}/feed/${city}/?token=${WAQI_TOKEN}`;
  const response = await axios.get(url);
  if (response.data.status === 'ok') return response.data.data;
  throw new Error(`API error: ${response.data.status}`);
}

// Fetch multiple cities air quality data
async function getMultipleCitiesAirQuality(cities) {
  const promises = cities.map(async (cityInfo) => {
    try {
      const resp = await axios.get(`${WAQI_BASE_URL}/feed/${cityInfo.english}/?token=${WAQI_TOKEN}`);
      if (resp.data.status === 'ok') return { ...resp.data.data, chineseName: cityInfo.chinese };
      return null;
    } catch {
      return null;
    }
  });
  const results = await Promise.all(promises);
  return results.filter(r => r !== null);
}

// Flex Message creators - (uses same existing creators from original code)
// createMainMenuFlexMessage, createCitySelectionFlexMessage, createAirQualityFlexMessage,
// createCityComparisonFlexMessage, createSettingsFlexMessage, createSubscriptionManagementFlexMessage,
// createSimpleResponse, createErrorFlexMessage are unchanged (redefine or import as needed). 
// For brevity, assume they are defined here as per original code.

// Parsing quick commands from button presses or user input
function parseQuickCommand(text) {
  const normalized = text.trim().toLowerCase();

  // Known commands - mapping button text to a command action
  const commandMap = {
    // Main commands
    '主選單': 'show_main_menu',
    'menu': 'show_main_menu',
    '開始': 'show_main_menu',
    'hello': 'greeting',
    'hi': 'greeting',
    '你好': 'greeting',
    '哈囉': 'greeting',

    // Help commands
    'help': 'help_request',
    '幫助': 'help_request',
    '使用說明': 'help_request',
    '教學': 'help_request',
    '怎麼用': 'help_request',

    // Settings
    '我的設定': 'show_settings',
    '設定': 'show_settings',
    '修改設定': 'show_settings',
    '開啟每日報告': 'enable_daily_report',
    '關閉每日報告': 'disable_daily_report',
    '開啟緊急警報': 'enable_emergency_alert',
    '關閉緊急警報': 'disable_emergency_alert',
    '設定警報閾值50': 'set_threshold_50',
    '設定警報閾值100': 'set_threshold_100',
    '設定警報閾值150': 'set_threshold_150',

    // Main menu features
    '查詢空氣品質': 'show_city_selection',
    '比較城市': 'start_compare_cities',
    '訂閱提醒': 'show_subscription_management',
    '附近查詢': 'location_query',
    '新增訂閱': 'start_subscribe_city',
    '清除所有訂閱': 'clear_all_subscriptions',

    // Quick compare examples
    '台北 高雄': 'quick_compare Taipei Kaohsiung',
    '台北 vs 高雄': 'quick_compare Taipei Kaohsiung',
    '台灣五大城市': 'quick_compare TaiwanTop5',

    // Cancellation
    '取消': 'cancel',
    '❌ 取消': 'cancel'
  };

  return commandMap[normalized] || null;
}

// Handler for stateful messages (multi-turn dialogues)
async function handleStatefulMessage(event, userState) {
  const userId = event.source.userId;
  const userMessage = event.message.text.trim();

  try {
    if (userState.state === 'awaiting_compare_cities') {
      if (userMessage === '取消' || userMessage === '❌ 取消') {
        clearUserState(userId);
        return client.replyMessage(event.replyToken, createMainMenuFlexMessage());
      }

      const cities = [];
      const words = userMessage.split(/[\s,，]+/);
      for (const word of words) {
        const trimmed = word.trim();
        if (!trimmed) continue;
        for (const [chinese, english] of Object.entries(cityMap)) {
          if (trimmed.includes(chinese) || trimmed.toLowerCase().includes(english)) {
            cities.push({ chinese, english });
            break;
          }
        }
      }
      clearUserState(userId);

      if (cities.length < 2) {
        return client.replyMessage(event.replyToken,
          createSimpleResponse('❌ 請至少輸入2個城市名稱，用空格分隔。\n\n例如：「台北 高雄」或「東京 首爾 新加坡」', ['台北 高雄', '重新輸入', '主選單'])
        );
      }
      if (cities.length > 5) cities.splice(5);

      try {
        const citiesData = await getMultipleCitiesAirQuality(cities);
        if (!citiesData.length) {
          return client.replyMessage(event.replyToken,
            createSimpleResponse('❌ 無法獲取這些城市的空氣品質數據，請檢查城市名稱是否正確。\n\n支援城市包括：台北、高雄、台中、台南、東京、首爾、新加坡等。', ['重新比較', '查看支援城市', '主選單'])
          );
        }
        const comparisonMessage = createCityComparisonFlexMessage(citiesData);
        const successMessage = createSimpleResponse(`✅ 成功比較 ${citiesData.length} 個城市的空氣品質！`, ['其他比較', '查看詳情', '主選單']);
        return client.replyMessage(event.replyToken, [successMessage, comparisonMessage]);
      } catch (err) {
        return client.replyMessage(event.replyToken,
          createSimpleResponse('❌ 比較查詢時發生問題，請稍後再試。', ['重新比較', '單獨查詢', '主選單'])
        );
      }
    }

    if (userState.state === 'awaiting_subscribe_city') {
      if (userMessage === '取消' || userMessage === '❌ 取消') {
        clearUserState(userId);
        return client.replyMessage(event.replyToken, createMainMenuFlexMessage());
      }

      // Attempt parsing subscription city
      let queryResult = parseQuery(userMessage);
      clearUserState(userId);

      if (queryResult && queryResult.type === 'single') {
        const success = addSubscription(userId, queryResult.city);
        const confirmText = success
          ? `🎉 太好了！我已經為你訂閱${queryResult.cityName}的空氣品質提醒！\n\n✅ 每天早上8點收到空氣品質報告\n🚨 空氣品質惡化時立即通知\n💡 個人化健康建議`
          : `📋 您已經訂閱了${queryResult.cityName}的空氣品質提醒囉！`;
        return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['管理訂閱', '訂閱其他城市', '主選單']));
      }

      // Fallback direct city matching
      for (const [chinese, english] of Object.entries(cityMap)) {
        if (userMessage.includes(chinese)) {
          const success = addSubscription(userId, english);
          const confirmText = success
            ? `🎉 太好了！我已經為你訂閱${chinese}的空氣品質提醒！\n\n✅ 每天早上8點收到空氣品質報告\n🚨 空氣品質惡化時立即通知`
            : `📋 您已經訂閱了${chinese}的空氣品質提醒囉！`;
          return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['管理訂閱', '訂閱其他城市', '主選單']));
        }
      }

      return client.replyMessage(event.replyToken,
        createSimpleResponse('❌ 無法識別城市名稱，請重新輸入。\n\n支援城市包括：台北、高雄、台中、台南、東京、首爾、新加坡等。', ['台北', '高雄', '查看支援城市', '主選單'])
      );
    }

    // Unknown state fallback
    clearUserState(userId);
    return client.replyMessage(event.replyToken, createMainMenuFlexMessage());

  } catch (error) {
    clearUserState(userId);
    return client.replyMessage(event.replyToken,
      createSimpleResponse('❌ 處理請求時發生錯誤，請重試。', ['重試', '主選單'])
    );
  }
}

// Main event handler
async function handleEvent(event) {
  if (event.type !== 'message' || !event.message) {
    return null;
  }
  const userId = event.source.userId;
  const userMessage = event.message.type === 'text' ? event.message.text.trim() : null;

  // Location message handling
  if (event.message.type === 'location') {
    try {
      const { latitude, longitude } = event.message;
      const responseText = '📍 感謝您分享位置！目前位置查詢功能正在開發中，請使用城市名稱查詢。';
      return client.replyMessage(event.replyToken, createSimpleResponse(responseText, ['台北', '台中', '主選單']));
    } catch {
      const errorMessage = createErrorFlexMessage('api_error', '位置查詢功能暫時無法使用，請使用城市名稱查詢。');
      return client.replyMessage(event.replyToken, errorMessage);
    }
  }

  // Only process text messages hereafter
  if (!userMessage) {
    return null;
  }

  // First, check if user has pending stateful conversation
  const userState = getUserState(userId);
  if (userState) {
    return handleStatefulMessage(event, userState);
  }

  // Check quick commands from buttons / known texts
  const command = parseQuickCommand(userMessage);
  if (command !== null) {
    switch (command) {
      case 'show_main_menu':
        return client.replyMessage(event.replyToken, createMainMenuFlexMessage());

      case 'greeting':
        return client.replyMessage(event.replyToken,
          createSimpleResponse('您好！我是智慧空氣品質助手 🌬️，很高興為您服務！', ['主選單', '查詢空氣品質', '訂閱提醒'])
        );

      case 'help_request': {
        const helpText = '🤖 智慧空氣品質機器人使用說明\n\n✨ 直接對話：\n• 說「台北」或「查詢台北」\n• 說「比較台北高雄」\n• 說「訂閱台中」\n\n📱 使用選單：\n• 點選下方按鈕操作\n• 選擇功能更便利\n\n💡 小技巧：\n• 可以直接說城市名稱\n• 支援自然語言對話';
        return client.replyMessage(event.replyToken, createSimpleResponse(helpText, ['台北', '比較城市', '主選單']));
      }

      case 'show_settings':
        return client.replyMessage(event.replyToken, createSettingsFlexMessage(userId));

      case 'enable_daily_report':
        updateUserSettings(userId, { dailyReport: true });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 每日報告已開啟！\n\n📅 我會在每天早上8點為您推送空氣品質報告。`, ['我的設定', '主選單'])
        );

      case 'disable_daily_report':
        updateUserSettings(userId, { dailyReport: false });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 每日報告已關閉！\n\n❌ 您將不會再收到每日報告。`, ['我的設定', '主選單'])
        );

      case 'enable_emergency_alert':
        updateUserSettings(userId, { emergencyAlert: true });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 緊急警報已開啟！\n\n🚨 當空氣品質惡化時，我會立即通知您。`, ['我的設定', '主選單'])
        );

      case 'disable_emergency_alert':
        updateUserSettings(userId, { emergencyAlert: false });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 緊急警報已關閉！\n\n❌ 您將不會再收到緊急警報。`, ['我的設定', '主選單'])
        );

      case 'set_threshold_50':
        updateUserSettings(userId, { threshold: 50 });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 警報閾值已設定為 AQI > 50！\n\n⚠️ 當空氣品質超過此值時，我會發送警報通知您。`, ['我的設定', '主選單'])
        );

      case 'set_threshold_100':
        updateUserSettings(userId, { threshold: 100 });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 警報閾值已設定為 AQI > 100！\n\n⚠️ 當空氣品質超過此值時，我會發送警報通知您。`, ['我的設定', '主選單'])
        );

      case 'set_threshold_150':
        updateUserSettings(userId, { threshold: 150 });
        return client.replyMessage(event.replyToken,
          createSimpleResponse(`✅ 警報閾值已設定為 AQI > 150！\n\n⚠️ 當空氣品質超過此值時，我會發送警報通知您。`, ['我的設定', '主選單'])
        );

      case 'show_city_selection':
        return client.replyMessage(event.replyToken, createCitySelectionFlexMessage());

      case 'start_compare_cities':
        setUserState(userId, 'awaiting_compare_cities');
        return client.replyMessage(event.replyToken,
          createSimpleResponse(
            '🆚 多城市比較功能\n\n請輸入要比較的城市名稱，用空格分隔：\n\n📝 範例：\n• 台北 高雄\n• 台北 台中 台南\n• 東京 首爾 新加坡',
            ['台北 高雄', '台灣五大城市', '取消']
          )
        );

      case 'show_subscription_management':
        return client.replyMessage(event.replyToken, createSubscriptionManagementFlexMessage(userId));

      case 'location_query': {
        const locationText = '📍 GPS定位查詢\n\n請點擊下方按鈕分享您的位置，我會為您找到最近的空氣品質監測站。';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: locationText,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'location', label: '📍 分享位置' } },
              { type: 'action', action: { type: 'message', label: '❌ 取消', text: '主選單' } }
            ]
          }
        });
      }

      case 'start_subscribe_city':
        setUserState(userId, 'awaiting_subscribe_city');
        return client.replyMessage(event.replyToken,
          createSimpleResponse('🔔 新增訂閱\n\n請輸入您想訂閱的城市名稱：\n\n例如：台北、高雄、台中等', ['台北', '高雄', '台中', '取消'])
        );

      case 'clear_all_subscriptions': {
        const success = removeAllSubscriptions(userId);
        const confirmText = success
          ? '✅ 已清除所有訂閱！\n\n❌ 您將不會再收到任何空氣品質提醒。'
          : '❌ 您目前沒有任何訂閱需要清除。';
        return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['新增訂閱', '主選單']));
      }

      case 'quick_compare Taipei Kaohsiung':
        try {
          const cities = [
            { chinese: '台北', english: 'taipei' },
            { chinese: '高雄', english: 'kaohsiung' }
          ];
          const citiesData = await getMultipleCitiesAirQuality(cities);
          if (citiesData.length >= 2) {
            return client.replyMessage(event.replyToken, createCityComparisonFlexMessage(citiesData));
          }
          throw new Error('No city data');
        } catch {
          return client.replyMessage(event.replyToken,
            createErrorFlexMessage('api_error', '比較查詢時發生問題，請稍後再試。')
          );
        }

      case 'quick_compare TaiwanTop5':
        try {
          const cities = [
            { chinese: '台北', english: 'taipei' },
            { chinese: '台中', english: 'taichung' },
            { chinese: '台南', english: 'tainan' },
            { chinese: '高雄', english: 'kaohsiung' },
            { chinese: '新北', english: 'new-taipei' }
          ];
          const citiesData = await getMultipleCitiesAirQuality(cities);
          if (citiesData.length >= 2) {
            return client.replyMessage(event.replyToken, createCityComparisonFlexMessage(citiesData));
          }
          throw new Error('No city data');
        } catch {
          return client.replyMessage(event.replyToken,
            createErrorFlexMessage('api_error', '五大城市比較時發生問題，請稍後再試。')
          );
        }

      case 'cancel':
        clearUserState(userId);
        return client.replyMessage(event.replyToken, createMainMenuFlexMessage());

      default:
        // Unknown known command fallback, unlikely here
        break;
    }
  }

  // AI intent analysis fallback
  try {
    const intent = aiEngineInstance.analyzeIntent(userMessage);
    const entities = aiEngineInstance.extractEntities(userMessage);

    if (intent.intent === 'air_quality_query' && entities.cities.length > 0) {
      const city = entities.cities[0];
      try {
        const airQualityData = await getAirQuality(city.english);
        const message = createAirQualityFlexMessage(airQualityData);
        return client.replyMessage(event.replyToken, message);
      } catch {
        const errorText = `抱歉，查詢${city.name}的空氣品質時發生問題。請稍後再試，或者試試其他城市？`;
        return client.replyMessage(event.replyToken, createSimpleResponse(errorText, ['台北', '高雄', '主選單']));
      }
    }

    if (intent.intent === 'subscription' && entities.cities.length > 0) {
      const city = entities.cities[0];
      const success = addSubscription(userId, city.english);
      const confirmText = success
        ? `🎉 太好了！我已經為你訂閱${city.name}的空氣品質提醒。\n\n✅ 每天早上8點收到空氣品質報告\n🚨 空氣品質惡化時立即通知\n💡 個人化健康建議`
        : `📋 你已經訂閱了${city.name}的空氣品質提醒囉！`;
      return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['管理訂閱', `查詢${city.name}`, '主選單']));
    }

    if (intent.intent === 'unsubscription') {
      if (entities.cities.length > 0) {
        const city = entities.cities[0];
        const success = removeSubscription(userId, city.english);
        const confirmText = success
          ? `✅ 已取消訂閱 ${city.name} 的空氣品質提醒`
          : `❌ 您沒有訂閱 ${city.name} 的提醒`;
        return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['管理訂閱', '主選單']));
      }
      return client.replyMessage(event.replyToken, createSubscriptionManagementFlexMessage(userId));
    }

    if (intent.intent === 'comparison' && entities.cities.length >= 2) {
      const cities = entities.cities.map(c => ({ chinese: c.name, english: c.english }));
      try {
        const citiesData = await getMultipleCitiesAirQuality(cities);
        if (citiesData.length >= 2) {
          const compMsg = createCityComparisonFlexMessage(citiesData);
          return client.replyMessage(event.replyToken, compMsg);
        }
      } catch {
        return client.replyMessage(event.replyToken,
          createSimpleResponse('比較查詢時發生了問題，請檢查城市名稱或稍後再試。', ['重新比較', '主選單'])
        );
      }
    }

    if (entities.cities.length > 0) {
      const city = entities.cities[0];
      const respText = `我找到了${city.name}，是要查詢空氣品質嗎？`;
      return client.replyMessage(event.replyToken, createSimpleResponse(respText, [`查詢${city.name}`, `訂閱${city.name}`, '主選單']));
    }

  } catch (aiError) {
    // AI failure fallback - continue
  }

  // Traditional fallback parsing by basic query
  const queryResult = parseQuery(userMessage);
  if (queryResult) {
    try {
      switch (queryResult.type) {
        case 'single': {
          const airQualityData = await getAirQuality(queryResult.city);
          return client.replyMessage(event.replyToken, createAirQualityFlexMessage(airQualityData));
        }
        case 'subscribe': {
          const success = addSubscription(userId, queryResult.city);
          const confirmText = success
            ? `✅ 已成功訂閱 ${queryResult.cityName} 的空氣品質提醒！`
            : `📋 您已經訂閱了 ${queryResult.cityName} 的空氣品質提醒`;
          return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['管理訂閱', '主選單']));
        }
        case 'unsubscribe': {
          const success = removeSubscription(userId, queryResult.city);
          const confirmText = success
            ? `✅ 已取消訂閱 ${queryResult.cityName} 的空氣品質提醒`
            : `❌ 您沒有訂閱 ${queryResult.cityName} 的提醒`;
          return client.replyMessage(event.replyToken, createSimpleResponse(confirmText, ['管理訂閱', '主選單']));
        }
        case 'compare': {
          const citiesData = await getMultipleCitiesAirQuality(queryResult.cities);
          if (citiesData.length >= 2) {
            return client.replyMessage(event.replyToken, createCityComparisonFlexMessage(citiesData));
          }
          throw new Error('Insufficient city data');
        }
      }
    } catch {
      return client.replyMessage(event.replyToken,
        createErrorFlexMessage('api_error', '查詢時發生錯誤，請稍後再試。')
      );
    }
  }

  // Unknown / fallback message
  const defaultText = `🤔 我無法完全理解「${userMessage}」的意思，但我很樂意幫助您！\n\n您可以：\n• 直接說城市名稱，如「台北」\n• 使用「查詢台中」這樣的說法\n• 使用「訂閱高雄」來訂閱提醒\n• 點選下方選單功能\n• 說「主選單」查看所有功能`;
  return client.replyMessage(event.replyToken, createSimpleResponse(defaultText, ['台北', '查詢台中', '主選單']));
}

// Webhook endpoint
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error('Webhook error:', err);
      res.status(500).end();
    });
});

// The rest of the router, cron jobs, health check, error handlers remain unchanged but ensure async/await practices and proper error catching are used.

// Exports
module.exports = {
  app,
  AIConversationEngine,
  handleEvent,
  handleStatefulMessage,
  createMainMenuFlexMessage,
  createAirQualityFlexMessage,
  createCityComparisonFlexMessage,
  getAirQuality,
  parseQuery
};

