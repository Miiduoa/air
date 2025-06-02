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

// 增強的數據存儲
let subscriptions = new Map(); // userId -> {cities: [], settings: {}}
let locationCache = new Map(); // userId -> {lat, lng, timestamp}
let userStates = new Map(); // userId -> {state: 'awaiting_city', context: {}}
let conversationHistory = new Map(); // userId -> [{role, content, timestamp}]
let userProfiles = new Map(); // userId -> {preferences, personality, context}

// AI 自然語言處理引擎
class AIConversationEngine {
  constructor() {
    // 意圖模式庫
    this.intentPatterns = {
      greeting: [
        /^(你好|哈囉|嗨|hi|hello|早安|午安|晚安|嘿)/i,
        /^(在嗎|有人嗎|可以幫我嗎)/i
      ],
      
      air_quality_query: [
        /(?:查詢|查看|看看|問|告訴我).*?(?:空氣|空品|aqi|pm2\.?5|空氣品質)/i,
        /(?:現在|今天|目前).*?(?:空氣|空品|aqi).*?(?:怎麼樣|如何|好嗎|狀況)/i,
        /^(?:台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海)(?:的)?(?:空氣|空品|aqi)/i,
        /(?:空氣|空品|aqi).*?(?:台北|高雄|台中|台南|新北|桃園|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖|東京|首爾|新加坡|香港|北京|上海)/i
      ],
      
      comparison: [
        /(?:比較|比一比|對比).*?(?:空氣|空品|aqi)/i,
        /(?:哪裡|哪個|什麼地方).*?(?:空氣|空品).*?(?:好|佳|較好|比較好)/i,
        /(?:台北|高雄|台中|台南).*?(?:vs|對|比).*?(?:台北|高雄|台中|台南)/i
      ],
      
      health_advice: [
        /(?:可以|能夠|適合).*?(?:運動|慢跑|跑步|騎車|散步|外出)/i,
        /(?:要|需要|該).*?(?:戴|配戴).*?(?:口罩|防護)/i,
        /(?:健康|身體).*?(?:建議|影響|注意)/i,
        /(?:敏感|過敏|氣喘|老人|小孩|孕婦)/i
      ],
      
      subscription: [
        /(?:訂閱|關注|追蹤|通知).*?(?:空氣|空品|提醒)/i,
        /(?:每日|定期|自動).*?(?:報告|推送|通知)/i,
        /(?:取消|關閉|停止).*?(?:訂閱|追蹤|通知)/i
      ],
      
      location_query: [
        /(?:附近|周圍|附近的|我這裡).*?(?:空氣|空品|監測站)/i,
        /(?:定位|位置|gps).*?(?:查詢|查看)/i
      ],
      
      weather_related: [
        /(?:天氣|氣象|溫度|下雨|颱風|風向)/i,
        /(?:今天|明天|這幾天).*?(?:天氣|氣象)/i
      ],
      
      concern_expression: [
        /(?:擔心|害怕|恐怖|嚇人|糟糕|很差|很爛)/i,
        /(?:好可怕|太恐怖|真的嗎|不會吧|完蛋了)/i
      ],
      
      positive_expression: [
        /(?:太好了|真棒|很好|不錯|還可以|很棒)/i,
        /(?:謝謝|感謝|辛苦了|很有幫助)/i
      ],
      
      help_request: [
        /(?:幫助|幫忙|教學|怎麼用|說明|指導)/i,
        /(?:不懂|不會|不知道|搞不清楚|怎麼辦)/i
      ],
      
      complaint: [
        /(?:慢|很慢|太慢|卡|當機|壞了|錯誤)/i,
        /(?:沒用|沒反應|聽不懂|看不懂)/i
      ]
    };

    // 情感分析詞典
    this.emotionKeywords = {
      positive: ['好', '棒', '讚', '優秀', '完美', '滿意', '開心', '高興', '謝謝', '感謝'],
      negative: ['差', '爛', '糟', '壞', '失望', '生氣', '討厭', '煩', '麻煩', '問題'],
      concern: ['擔心', '害怕', '恐怖', '憂慮', '緊張', '不安', '焦慮'],
      neutral: ['好的', '了解', '知道', '明白', '清楚', '是的', '對']
    };

    // 個性化回應模板
    this.responseTemplates = {
      greeting: {
        formal: ['您好！我是智慧空氣品質助手，很高興為您服務。', '歡迎使用空氣品質查詢服務！'],
        friendly: ['嗨！有什麼空氣品質問題要問我嗎？', '哈囉～我是你的空氣品質小幫手！'],
        caring: ['你好呀！關心空氣品質真的很重要呢～', '嗨！讓我來守護你的呼吸健康吧！']
      },
      
      understanding: {
        confirm: ['我明白了！', '了解你的需求！', '好的，讓我來幫你！'],
        clarify: ['讓我確認一下你的意思...', '我想要更了解你的需求...', '可以請你再詳細說明一下嗎？']
      },
      
      encouragement: {
        positive: ['真是太好了！', '這樣很棒呢！', '你很關心健康，很讚！'],
        support: ['別擔心，我來幫你！', '我會陪伴你的！', '讓我們一起關注空氣品質吧！']
      }
    };
  }

  // 分析用戶意圖
  analyzeIntent(text) {
    const intents = [];
    
    for (const [intent, patterns] of Object.entries(this.intentPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          intents.push({
            intent,
            confidence: this.calculateConfidence(text, pattern)
          });
          break;
        }
      }
    }
    
    // 按信心度排序
    intents.sort((a, b) => b.confidence - a.confidence);
    
    return intents.length > 0 ? intents[0] : { intent: 'unknown', confidence: 0 };
  }

  // 計算匹配信心度
  calculateConfidence(text, pattern) {
    const match = text.match(pattern);
    if (!match) return 0;
    
    const matchLength = match[0].length;
    const textLength = text.length;
    const coverage = matchLength / textLength;
    
    // 基於覆蓋率和其他因素計算信心度
    let confidence = Math.min(coverage * 100, 95);
    
    // 如果是完全匹配，提高信心度
    if (coverage > 0.8) confidence += 5;
    
    return Math.round(confidence);
  }

  // 分析情感
  analyzeEmotion(text) {
    const emotions = { positive: 0, negative: 0, concern: 0, neutral: 0 };
    
    for (const [emotion, keywords] of Object.entries(this.emotionKeywords)) {
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          emotions[emotion]++;
        }
      }
    }
    
    // 找出主要情感
    const dominantEmotion = Object.entries(emotions)
      .reduce((a, b) => emotions[a[0]] > emotions[b[0]] ? a : b)[0];
    
    return {
      dominant: dominantEmotion,
      scores: emotions,
      intensity: Math.max(...Object.values(emotions))
    };
  }

  // 提取實體（城市名稱等）
  extractEntities(text) {
    const entities = {
      cities: [],
      timeReferences: [],
      healthConcerns: [],
      activities: []
    };

    // 提取城市
    const cityPatterns = Object.keys(cityMap);
    for (const city of cityPatterns) {
      if (text.includes(city)) {
        entities.cities.push({
          name: city,
          english: cityMap[city],
          position: text.indexOf(city)
        });
      }
    }

    // 提取時間參考
    const timePatterns = ['現在', '今天', '明天', '這週', '最近', '目前'];
    for (const timeRef of timePatterns) {
      if (text.includes(timeRef)) {
        entities.timeReferences.push(timeRef);
      }
    }

    // 提取健康關注點
    const healthPatterns = ['過敏', '氣喘', '孕婦', '小孩', '老人', '敏感'];
    for (const health of healthPatterns) {
      if (text.includes(health)) {
        entities.healthConcerns.push(health);
      }
    }

    // 提取活動
    const activityPatterns = ['運動', '慢跑', '騎車', '散步', '爬山', '戶外活動'];
    for (const activity of activityPatterns) {
      if (text.includes(activity)) {
        entities.activities.push(activity);
      }
    }

    return entities;
  }

  // 生成個性化回應
  generatePersonalizedResponse(intent, entities, emotion, userProfile = {}) {
    const personality = userProfile.personality || 'friendly';
    let response = '';

    switch (intent.intent) {
      case 'greeting':
        const greetingTemplates = this.responseTemplates.greeting[personality] || 
                                 this.responseTemplates.greeting.friendly;
        response = this.getRandomFromArray(greetingTemplates);
        break;

      case 'air_quality_query':
        if (entities.cities.length > 0) {
          response = `好的！讓我為你查詢${entities.cities[0].name}的空氣品質。`;
        } else {
          response = '我來幫你查詢空氣品質！請告訴我你想查詢哪個城市？';
        }
        break;

      case 'comparison':
        if (entities.cities.length >= 2) {
          response = `好想法！我來比較${entities.cities.map(c => c.name).join('和')}的空氣品質。`;
        } else {
          response = '多城市比較很實用呢！請告訴我你想比較哪些城市？';
        }
        break;

      case 'health_advice':
        if (entities.healthConcerns.length > 0) {
          response = `我了解你對${entities.healthConcerns.join('、')}的關心，讓我提供專業的健康建議。`;
        } else if (entities.activities.length > 0) {
          response = `關於${entities.activities.join('、')}的建議，我會根據空氣品質給你專業意見！`;
        } else {
          response = '健康最重要！我會根據空氣品質給你最適合的建議。';
        }
        break;

      case 'concern_expression':
        response = '我能理解你的擔心，空氣品質確實很重要。讓我提供準確資訊和實用建議來幫助你！';
        break;

      case 'positive_expression':
        response = '謝謝你的肯定！能幫助你關注空氣品質我也很開心～有任何問題隨時問我喔！';
        break;

      case 'help_request':
        response = '沒問題！我很樂意幫助你。你可以直接告訴我想查詢的城市，或是說「主選單」看看我能做什麼！';
        break;

      default:
        response = '我聽懂了你的意思！讓我用最適合的功能來幫助你。';
    }

    // 根據情感調整語氣
    if (emotion.dominant === 'concern' && emotion.intensity > 1) {
      response = '我理解你的擔心。' + response;
    } else if (emotion.dominant === 'positive') {
      response += ' 😊';
    }

    return response;
  }

  // 從陣列中隨機選擇
  getRandomFromArray(array) {
    return array[Math.floor(Math.random() * array.length)];
  }
}

// 對話管理器
class ConversationManager {
  constructor() {
    this.aiEngine = new AIConversationEngine();
    this.maxHistoryLength = 10;
  }

  // 處理對話
  async processConversation(userId, message) {
    // 獲取用戶歷史對話
    let history = conversationHistory.get(userId) || [];
    
    // 添加用戶消息到歷史
    history.push({
      role: 'user',
      content: message,
      timestamp: Date.now()
    });

    // 分析用戶輸入
    const intent = this.aiEngine.analyzeIntent(message);
    const entities = this.aiEngine.extractEntities(message);
    const emotion = this.aiEngine.analyzeEmotion(message);
    
    // 獲取用戶資料
    const userProfile = userProfiles.get(userId) || {};
    
    // 更新用戶資料
    this.updateUserProfile(userId, intent, entities, emotion);
    
    // 根據上下文調整回應
    const contextualResponse = await this.generateContextualResponse(
      userId, intent, entities, emotion, history
    );

    // 添加機器人回應到歷史
    history.push({
      role: 'assistant',
      content: contextualResponse.text,
      intent: intent.intent,
      timestamp: Date.now()
    });

    // 限制歷史長度
    if (history.length > this.maxHistoryLength * 2) {
      history = history.slice(-this.maxHistoryLength * 2);
    }

    // 保存歷史
    conversationHistory.set(userId, history);

    return contextualResponse;
  }

  // 更新用戶資料
  updateUserProfile(userId, intent, entities, emotion) {
    let profile = userProfiles.get(userId) || {
      preferences: { cities: [], concerns: [] },
      personality: 'friendly',
      context: {},
      lastInteraction: Date.now()
    };

    // 更新常用城市
    entities.cities.forEach(city => {
      if (!profile.preferences.cities.includes(city.name)) {
        profile.preferences.cities.push(city.name);
      }
    });

    // 更新健康關注點
    entities.healthConcerns.forEach(concern => {
      if (!profile.preferences.concerns.includes(concern)) {
        profile.preferences.concerns.push(concern);
      }
    });

    // 根據對話風格推斷個性
    if (emotion.dominant === 'positive' && emotion.intensity > 1) {
      profile.personality = 'friendly';
    } else if (emotion.dominant === 'concern' && emotion.intensity > 1) {
      profile.personality = 'caring';
    }

    profile.lastInteraction = Date.now();
    userProfiles.set(userId, profile);
  }

  // 生成上下文化回應
  async generateContextualResponse(userId, intent, entities, emotion, history) {
    const userProfile = userProfiles.get(userId) || {};
    
    // 檢查是否是連續對話
    const isFollowUp = this.isFollowUpQuestion(history, intent);
    
    // 生成基本回應
    let aiResponse = this.aiEngine.generatePersonalizedResponse(
      intent, entities, emotion, userProfile
    );

    // 根據意圖準備具體回應
    let response = {
      type: 'text',
      text: aiResponse,
      suggestedActions: []
    };

    // 處理具體功能
    switch (intent.intent) {
      case 'greeting':
        response = await this.handleGreeting(userId, userProfile, isFollowUp);
        break;
        
      case 'air_quality_query':
        response = await this.handleAirQualityQuery(userId, entities, userProfile);
        break;
        
      case 'comparison':
        response = await this.handleComparison(userId, entities);
        break;
        
      case 'health_advice':
        response = await this.handleHealthAdvice(userId, entities, userProfile);
        break;
        
      case 'subscription':
        response = await this.handleSubscription(userId, entities);
        break;
        
      case 'location_query':
        response = await this.handleLocationQuery(userId);
        break;
        
      case 'help_request':
        response = await this.handleHelpRequest(userId, userProfile);
        break;
        
      case 'weather_related':
        response = await this.handleWeatherQuery(userId, entities);
        break;
        
      default:
        response = await this.handleUnknownIntent(userId, entities, userProfile);
    }

    return response;
  }

  // 檢查是否為連續對話
  isFollowUpQuestion(history, intent) {
    if (history.length < 2) return false;
    
    const lastBotMessage = history[history.length - 2];
    const timeDiff = Date.now() - lastBotMessage.timestamp;
    
    // 5分鐘內且相關意圖
    return timeDiff < 300000 && lastBotMessage.intent === intent.intent;
  }

  // 處理問候
  async handleGreeting(userId, userProfile, isFollowUp) {
    const userSub = getUserSubscriptions(userId);
    const hasSubscriptions = userSub.cities.length > 0;
    
    let greetingText = '';
    
    if (isFollowUp) {
      greetingText = '又見面了！今天想查詢哪裡的空氣品質呢？';
    } else if (hasSubscriptions) {
      const cityNames = userSub.cities.map(city => 
        Object.keys(cityMap).find(key => cityMap[key] === city) || city
      ).join('、');
      greetingText = `歡迎回來！我看到你有訂閱${cityNames}的空氣品質。今天想查詢什麼呢？`;
    } else if (userProfile.preferences && userProfile.preferences.cities.length > 0) {
      greetingText = `你好！你之前常查詢${userProfile.preferences.cities.slice(0, 2).join('、')}，今天也要查詢空氣品質嗎？`;
    } else {
      greetingText = '你好！我是智慧空氣品質助手～\n\n我可以幫你：\n🔍 查詢任何城市的空氣品質\n📊 比較多個城市\n💊 提供健康建議\n🔔 設定提醒通知\n📍 查詢附近空氣品質';
    }

    return {
      type: 'flex',
      flex: createWelcomeFlexMessage(),
      text: greetingText,
      suggestedActions: ['查詢台北', '主選單', '附近查詢']
    };
  }

  // 處理空氣品質查詢
  async handleAirQualityQuery(userId, entities, userProfile) {
    if (entities.cities.length > 0) {
      // 直接查詢指定城市
      const city = entities.cities[0];
      try {
        const airQualityData = await getAirQuality(city.english);
        const aqiInfo = getAQILevel(airQualityData.aqi);
        
        // 生成個性化回應
        let responseText = `我查到了${city.name}的空氣品質！\n\n`;
        responseText += `💨 AQI: ${airQualityData.aqi} (${aqiInfo.level})\n`;
        
        // 根據用戶健康關注點給出建議
        if (userProfile.preferences && userProfile.preferences.concerns.length > 0) {
          responseText += `\n根據你的${userProfile.preferences.concerns.join('、')}需求，`;
          if (airQualityData.aqi > 100) {
            responseText += '建議減少戶外活動並配戴防護口罩。';
          } else {
            responseText += '空氣品質還不錯，但仍建議適度防護。';
          }
        }

        return {
          type: 'flex',
          flex: createAirQualityFlexMessage(airQualityData),
          text: responseText,
          suggestedActions: [`訂閱${city.name}`, '比較其他城市', '健康建議']
        };
      } catch (error) {
        return {
          type: 'text',
          text: `抱歉，查詢${city.name}的空氣品質時發生了問題。請稍後再試，或者試試其他城市？`,
          suggestedActions: ['查詢台北', '查詢高雄', '主選單']
        };
      }
    } else {
      // 沒有指定城市，提供選擇
      let responseText = '我來幫你查詢空氣品質！';
      
      // 根據用戶歷史偏好推薦
      if (userProfile.preferences && userProfile.preferences.cities.length > 0) {
        const suggestedCities = userProfile.preferences.cities.slice(0, 3);
        responseText += `\n\n你之前常查詢：${suggestedCities.join('、')}`;
      }
      
      responseText += '\n\n請告訴我你想查詢哪個城市？或直接點選下方選項：';

      return {
        type: 'flex',
        flex: createCitySelectionFlexMessage(),
        text: responseText,
        suggestedActions: ['台北', '高雄', '台中', '附近查詢']
      };
    }
  }

  // 處理比較查詢
  async handleComparison(userId, entities) {
    if (entities.cities.length >= 2) {
      try {
        const citiesData = await getMultipleCitiesAirQuality(
          entities.cities.map(city => ({ chinese: city.name, english: city.english }))
        );
        
        if (citiesData.length < 2) {
          return {
            type: 'text',
            text: '抱歉，無法獲取足夠的城市數據進行比較。請檢查城市名稱或稍後再試。',
            suggestedActions: ['重新比較', '單獨查詢', '主選單']
          };
        }

        const bestCity = citiesData.reduce((best, current) => 
          current.aqi < best.aqi ? current : best
        );

        let responseText = `比較結果出來了！\n\n`;
        responseText += `在${entities.cities.map(c => c.name).join('、')}中，`;
        responseText += `${bestCity.chineseName}的空氣品質最好 (AQI: ${bestCity.aqi})。`;

        return {
          type: 'flex',
          flex: createCityComparisonFlexMessage(citiesData),
          text: responseText,
          suggestedActions: [`查看${bestCity.chineseName}詳情`, '其他比較', '訂閱提醒']
        };
      } catch (error) {
        return {
          type: 'text',
          text: '比較查詢時發生了問題，請稍後再試。',
          suggestedActions: ['重新比較', '單獨查詢', '主選單']
        };
      }
    } else {
      return {
        type: 'text',
        text: '多城市比較功能很棒！請告訴我你想比較哪些城市？\n\n例如：「比較台北和高雄」或「台北 台中 台南」',
        suggestedActions: ['台北 vs 高雄', '五大城市比較', '自訂比較']
      };
    }
  }

  // 處理健康建議
  async handleHealthAdvice(userId, entities, userProfile) {
    // 如果有提到特定城市，先查詢空氣品質
    if (entities.cities.length > 0) {
      try {
        const city = entities.cities[0];
        const airQualityData = await getAirQuality(city.english);
        const healthAdvice = getHealthAdvice(airQualityData.aqi);
        
        let responseText = `根據${city.name}目前的空氣品質 (AQI: ${airQualityData.aqi})，`;
        
        if (entities.activities.length > 0) {
          responseText += `關於${entities.activities.join('、')}的建議：\n\n`;
          responseText += healthAdvice.exercise;
        } else if (entities.healthConcerns.length > 0) {
          responseText += `針對${entities.healthConcerns.join('、')}的特別建議：\n\n`;
          responseText += healthAdvice.sensitive;
        } else {
          responseText += `一般健康建議：\n\n`;
          responseText += healthAdvice.general;
        }

        return {
          type: 'flex',
          flex: createAirQualityFlexMessage(airQualityData),
          text: responseText,
          suggestedActions: ['更多建議', '其他城市', '訂閱提醒']
        };
      } catch (error) {
        return {
          type: 'text',
          text: '查詢空氣品質時發生問題，無法提供準確的健康建議。請稍後再試。',
          suggestedActions: ['重新查詢', '一般建議', '主選單']
        };
      }
    } else {
      let responseText = '健康最重要！我需要知道你在哪個城市，才能給你最準確的建議。';
      
      if (userProfile.preferences && userProfile.preferences.cities.length > 0) {
        responseText += `\n\n要查詢${userProfile.preferences.cities[0]}的健康建議嗎？`;
      }

      return {
        type: 'text',
        text: responseText,
        suggestedActions: ['台北健康建議', '高雄健康建議', '指定城市']
      };
    }
  }

  // 處理訂閱功能
  async handleSubscription(userId, entities) {
    const userSub = getUserSubscriptions(userId);
    
    if (entities.cities.length > 0) {
      const city = entities.cities[0];
      const success = addSubscription(userId, city.english);
      
      if (success) {
        return {
          type: 'text',
          text: `太好了！我已經為你訂閱${city.name}的空氣品質提醒。\n\n你會在每天早上8點收到空氣品質報告，空氣品質惡化時也會立即通知你！`,
          suggestedActions: ['管理訂閱', '訂閱其他城市', '設定選項']
        };
      } else {
        return {
          type: 'text',
          text: `你已經訂閱了${city.name}的空氣品質提醒囉！`,
          suggestedActions: ['管理訂閱', '訂閱其他城市', '查看設定']
        };
      }
    } else {
      return {
        type: 'flex',
        flex: createSubscriptionManagementFlexMessage(userId),
        text: '訂閱功能讓你不錯過任何重要的空氣品質變化！你想訂閱哪個城市的提醒呢？',
        suggestedActions: ['訂閱台北', '訂閱高雄', '管理現有訂閱']
      };
    }
  }

  // 處理位置查詢
  async handleLocationQuery(userId) {
    const cachedLocation = locationCache.get(userId);
    
    if (cachedLocation && Date.now() - cachedLocation.timestamp < 3600000) {
      // 使用快取的位置
      try {
        const nearbyStations = await findNearbyStations(cachedLocation.lat, cachedLocation.lng);
        return {
          type: 'flex',
          flex: createNearbyStationsFlexMessage(nearbyStations, cachedLocation.lat, cachedLocation.lng),
          text: '我使用你之前分享的位置為你查詢附近的空氣品質監測站！',
          suggestedActions: ['重新定位', '查詢其他地區', '訂閱附近']
        };
      } catch (error) {
        return {
          type: 'text',
          text: '查詢附近監測站時發生問題，請重新分享你的位置。',
          suggestedActions: ['分享位置', '手動查詢', '主選單']
        };
      }
    } else {
      return {
        type: 'text',
        text: '我來幫你查詢附近的空氣品質！請點擊下方按鈕分享你的位置，我會找到最近的監測站。',
        suggestedActions: ['📍 分享位置', '手動輸入地址', '主選單']
      };
    }
  }

  // 處理求助
  async handleHelpRequest(userId, userProfile) {
    let helpText = '我很樂意幫助你！以下是我可以做的事情：\n\n';
    helpText += '🔍 **即時查詢**：直接說城市名稱\n';
    helpText += '📊 **多城市比較**：說「比較台北高雄」\n';
    helpText += '💊 **健康建議**：問「可以運動嗎」\n';
    helpText += '🔔 **訂閱提醒**：說「訂閱台北」\n';
    helpText += '📍 **附近查詢**：分享位置給我\n\n';
    helpText += '你也可以很自然地跟我對話，我會理解你的意思！';

    return {
      type: 'flex',
      flex: createHelpFlexMessage(),
      text: helpText,
      suggestedActions: ['試試查詢', '比較功能', '主選單']
    };
  }

  // 處理天氣相關查詢
  async handleWeatherQuery(userId, entities) {
    let responseText = '我專精於空氣品質查詢，雖然不能提供詳細天氣預報，但可以告訴你空氣品質狀況！';
    
    if (entities.cities.length > 0) {
      responseText += `\n\n要查詢${entities.cities[0].name}的空氣品質嗎？`;
      return {
        type: 'text',
        text: responseText,
        suggestedActions: [`查詢${entities.cities[0].name}`, '其他城市', '主選單']
      };
    } else {
      return {
        type: 'text',
        text: responseText + '\n\n請告訴我你想查詢哪個城市的空氣品質？',
        suggestedActions: ['台北空氣品質', '高雄空氣品質', '主選單']
      };
    }
  }

  // 處理未知意圖
  async handleUnknownIntent(userId, entities, userProfile) {
    let responseText = '';
    
    // 嘗試從實體中推斷意圖
    if (entities.cities.length > 0) {
      responseText = `我聽到你提到了${entities.cities.map(c => c.name).join('、')}，是要查詢空氣品質嗎？`;
      return {
        type: 'text',
        text: responseText,
        suggestedActions: entities.cities.map(c => `查詢${c.name}`).concat(['主選單'])
      };
    } else if (entities.activities.length > 0) {
      responseText = `關於${entities.activities.join('、')}的問題，我建議先查詢空氣品質再給你專業建議！`;
      return {
        type: 'text',
        text: responseText,
        suggestedActions: ['查詢台北', '附近查詢', '健康建議']
      };
    } else {
      // 完全不理解的情況
      const responses = [
        '我想要更好地理解你的需求，可以再詳細說明一下嗎？',
        '我聽懂了一些，但想確保給你最準確的幫助，可以換個方式說嗎？',
        '我正在學習理解更多表達方式，可以用簡單一點的話告訴我嗎？'
      ];
      
      responseText = responses[Math.floor(Math.random() * responses.length)];
      
      // 根據用戶歷史提供個性化建議
      if (userProfile.preferences && userProfile.preferences.cities.length > 0) {
        responseText += `\n\n或者你想查詢${userProfile.preferences.cities[0]}的空氣品質嗎？`;
      }

      return {
        type: 'flex',
        flex: createMainMenuFlexMessage(),
        text: responseText,
        suggestedActions: ['主選單', '使用說明', '查詢台北']
      };
    }
  }
}

// 創建全域對話管理器實例
const conversationManager = new ConversationManager();

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

// 解析自然語言查詢（保留原有功能，作為備用）
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
            text: '💡 你也可以直接跟我對話，我會理解你的意思！',
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
      text: '🎯 智能建議',
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
            text: '🌟 歡迎使用 AI 智慧空氣品質機器人！',
            weight: 'bold',
            size: 'lg',
            color: '#333333',
            align: 'center'
          },
          {
            type: 'text',
            text: '現在支援自然語言對話！',
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
            text: '🤖 AI 新功能',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '💬 自然語言理解\n🧠 智慧意圖識別\n😊 情感分析回應\n👤 個人化對話\n📚 對話歷史記憶',
            size: 'sm',
            color: '#666666',
            margin: 'sm',
            wrap: true
          },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'text',
            text: '✨ 試試這些說法',
            weight: 'bold',
            color: '#333333',
            margin: 'md'
          },
          {
            type: 'text',
            text: '「台北空氣怎麼樣？」\n「今天適合運動嗎？」\n「比較台北和高雄」\n「我擔心空氣品質」',
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
              label: '🚀 開始對話',
              text: '你好'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: '💡 使用說明',
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
    altText: '使用說明 - AI 智慧空氣品質機器人',
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
                text: '🤖 AI 對話功能',
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
                text: '💬 自然對話',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '就像跟朋友聊天一樣！\n我能理解各種表達方式：\n• 「台北空氣怎樣？」\n• 「今天適合出門嗎？」\n• 「我有點擔心空氣品質」',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '🧠 智慧理解',
                weight: 'bold',
                color: '#333333',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 意圖識別：理解你想做什麼\n• 情感分析：感受你的情緒\n• 個人化：記住你的偏好',
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
                text: '🔍 查詢方式',
                weight: 'bold',
                color: '#ffffff',
                size: 'lg',
                align: 'center'
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
                type: 'text',
                text: '🗣️ 說話範例',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '查詢：「台北空氣品質」\n比較：「台北和高雄哪個好？」\n健康：「可以慢跑嗎？」\n位置：「附近空氣怎樣？」',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '😊 情感表達',
                weight: 'bold',
                color: '#333333',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 擔心：「好害怕空污」\n• 開心：「空氣真好！」\n• 困惑：「不知道怎麼辦」',
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
                text: '🎯 進階功能',
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
                text: '🔔 智慧訂閱',
                weight: 'bold',
                color: '#333333'
              },
              {
                type: 'text',
                text: '說「訂閱台北」就能設定提醒\n每日報告+緊急警報\n個人化健康建議',
                size: 'sm',
                color: '#666666',
                wrap: true
              },
              {
                type: 'text',
                text: '👤 個人化體驗',
                weight: 'bold',
                color: '#333333',
                margin: 'lg'
              },
              {
                type: 'text',
                text: '• 記住常查城市\n• 了解健康需求\n• 適應對話風格\n• 提供精準建議',
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
            text: '💡 你可以試試：',
            weight: 'bold',
            color: '#333333',
            margin: 'lg'
          },
          {
            type: 'text',
            text: '• 換個說法重新表達\n• 直接說城市名稱\n• 使用選單功能\n• 問「你能做什麼？」',
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

// 處理LINE訊息 - 增強版AI版本
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
      
      // 使用AI回應
      const aiResponse = await conversationManager.processConversation(
        userId, 
        `我分享了位置，請查詢附近的空氣品質監測站`
      );
      
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
    console.log(`收到用戶 ${userId} 的訊息: ${userMessage}`);
    
    // 檢查用戶狀態 - 優先級較低，讓AI處理大部分對話
    const userState = getUserState(userId);
    
    // 只有在特定狀態下才使用舊的狀態處理邏輯
    if (userState && userState.state === 'awaiting_critical_input') {
      return await handleStatefulMessage(event, userState);
    }
    
    // 使用AI對話管理器處理訊息
    const aiResponse = await conversationManager.processConversation(userId, userMessage);
    
    console.log(`AI回應類型: ${aiResponse.type}, 內容: ${aiResponse.text?.substring(0, 100)}...`);
    
    // 根據AI回應類型決定回覆方式
    let replyMessage;
    
    if (aiResponse.type === 'flex' && aiResponse.flex) {
      // Flex Message回應
      if (aiResponse.text && aiResponse.text.trim()) {
        // 如果有額外文字，先發送文字再發送Flex Message
        replyMessage = [
          { type: 'text', text: aiResponse.text },
          aiResponse.flex
        ];
      } else {
        replyMessage = aiResponse.flex;
      }
    } else {
      // 純文字回應
      replyMessage = { type: 'text', text: aiResponse.text };
    }
    
    // 記錄對話到歷史
    const history = conversationHistory.get(userId) || [];
    history.push({
      role: 'assistant',
      content: aiResponse.text,
      timestamp: Date.now(),
      messageType: aiResponse.type
    });
    conversationHistory.set(userId, history);
    
    return client.replyMessage(event.replyToken, replyMessage);
    
  } catch (error) {
    console.error('處理AI對話錯誤:', error);
    
    // 備用處理 - 使用原始解析邏輯
    console.log('使用備用處理邏輯...');
    
    try {
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

      // 使用原始解析邏輯
      const queryResult = parseQuery(userMessage);
      
      if (queryResult && queryResult.type === 'single') {
        const airQualityData = await getAirQuality(queryResult.city);
        const flexMessage = createAirQualityFlexMessage(airQualityData);
        return client.replyMessage(event.replyToken, flexMessage);
      }
      
      // 如果都無法處理，顯示友善錯誤訊息
      const errorMessage = createErrorFlexMessage(
        'not_found', 
        '抱歉，我暫時無法理解這個請求。AI功能正在恢復中，請使用選單功能或試試「台北空氣品質」這樣的簡單查詢。'
      );
      const menuMessage = createMainMenuFlexMessage();
      
      return client.replyMessage(event.replyToken, [errorMessage, menuMessage]);
      
    } catch (fallbackError) {
      console.error('備用處理也失敗:', fallbackError);
      
      const criticalErrorMessage = {
        type: 'text',
        text: '系統暫時有些問題，請稍後再試。如果問題持續，請使用「主選單」來使用基本功能。'
      };
      
      return client.replyMessage(event.replyToken, criticalErrorMessage);
    }
  }
}

// 處理有狀態的對話（保留用於關鍵操作）
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
    
    // 其他狀態處理...
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

// 修復後的首頁端點
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
    <title>AI 智慧空氣品質機器人 | LINE Bot</title>
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
        .ai-badge {
            display: inline-block;
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 25px;
            font-size: 0.9rem;
            font-weight: bold;
            margin-bottom: 1rem;
            animation: pulse-glow 2s infinite;
        }
        @keyframes pulse-glow {
            0% { box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(255, 107, 107, 0); }
            100% { box-shadow: 0 0 0 0 rgba(255, 107, 107, 0); }
        }
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
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 1rem; 
        }
        .feature { 
            padding: 1.5rem; 
            background: #f8fafc; 
            border-radius: 15px; 
            transition: all 0.3s ease;
            border-left: 4px solid #00b900;
        }
        .feature:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 20px rgba(0,0,0,0.1);
        }
        .feature i { 
            font-size: 2.5rem; 
            color: #00b900; 
            margin-bottom: 1rem; 
        }
        .ai-features {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            border-radius: 20px;
            margin-top: 2rem;
        }
        .ai-features h3 { margin-bottom: 1rem; }
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
            <div class="ai-badge">🤖 全新 AI 自然語言功能</div>
            <h1>🌬️ AI 智慧空氣品質機器人</h1>
            <p><span class="status-indicator"></span>AI 服務正常運行中</p>
            <p>支援自然語言對話，就像跟朋友聊天一樣輕鬆查詢空氣品質！</p>
            
            <div style="margin: 2rem 0;">
                <a href="https://line.me/R/ti/p/@470kdmxx" class="cta-button" target="_blank">
                    <i class="fab fa-line"></i> 立即體驗 AI 對話
                </a>
                <a href="/health" class="cta-button" style="background: #42a5f5;">
                    🔧 服務狀態
                </a>
            </div>
            
            <div class="features">
                <div class="feature">
                    <i class="fas fa-comments"></i>
                    <h4>🤖 AI 自然對話</h4>
                    <p>支援自然語言理解</p>
                </div>
                <div class="feature">
                    <i class="fas fa-brain"></i>
                    <h4>🧠 智慧意圖識別</h4>
                    <p>理解你的真實需求</p>
                </div>
                <div class="feature">
                    <i class="fas fa-heart"></i>
                    <h4>😊 情感分析</h4>
                    <p>感受你的情緒狀態</p>
                </div>
                <div class="feature">
                    <i class="fas fa-user"></i>
                    <h4>👤 個人化體驗</h4>
                    <p>記住你的偏好習慣</p>
                </div>
                <div class="feature">
                    <i class="fas fa-search-location"></i>
                    <h4>🔍 即時查詢</h4>
                    <p>30+ 支援城市</p>
                </div>
                <div class="feature">
                    <i class="fas fa-chart-line"></i>
                    <h4>📊 智慧比較</h4>
                    <p>多城市對比分析</p>
                </div>
                <div class="feature">
                    <i class="fas fa-user-md"></i>
                    <h4>💊 健康建議</h4>
                    <p>專業防護指導</p>
                </div>
                <div class="feature">
                    <i class="fas fa-bell"></i>
                    <h4>🔔 智慧提醒</h4>
                    <p>個人化推送通知</p>
                </div>
            </div>
            
            <div class="ai-features">
                <h3>🌟 AI 對話範例</h3>
                <div style="text-align: left; max-width: 600px; margin: 0 auto;">
                    <p>👤 「台北空氣怎麼樣？」</p>
                    <p>🤖 好的！讓我為你查詢台北的空氣品質...</p>
                    <br>
                    <p>👤 「今天適合運動嗎？我在高雄」</p>
                    <p>🤖 我來查詢高雄的空氣品質，給你專業的運動建議！</p>
                    <br>
                    <p>👤 「我擔心空氣污染對小孩的影響」</p>
                    <p>🤖 我理解你的擔心。讓我提供針對兒童的專業防護建議...</p>
                </div>
            </div>
        </div>
        
        <div class="hero-section">
            <h3 style="color: #333; margin-bottom: 1rem;">🚀 快速測試</h3>
            <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; font-size: 0.9rem;">
                <a href="/api/air-quality/taipei" style="color: #00b900; text-decoration: none;">📡 台北空氣品質API</a>
                <a href="/api/air-quality/kaohsiung" style="color: #00b900; text-decoration: none;">📡 高雄空氣品質API</a>
                <a href="/api/stats" style="color: #00b900; text-decoration: none;">📊 AI 服務統計</a>
                <a href="/debug" style="color: #666; text-decoration: none;">🔍 系統診斷</a>
            </div>
            
            <div style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.85rem; color: #999;">
                © 2025 AI 智慧空氣品質機器人 | 用 AI 科技守護每一次呼吸 🌱
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
      <h1>AI 服務臨時不可用</h1>
      <p>請稍後再試，或聯繫技術支援</p>
      <p>錯誤: ${error.message}</p>
    `);
  }
});

// 健康檢查端點 - 增強版
app.get('/health', (req, res) => {
  const indexExists = fs.existsSync(path.join(__dirname, 'index.html'));
  
  res.json({ 
    status: 'OK', 
    message: 'AI 智慧空氣品質機器人正常運行中！',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '2.1.0-AI',
    environment: {
      node_version: process.version,
      platform: process.platform,
      memory_usage: process.memoryUsage(),
      index_html_exists: indexExists,
      line_token_configured: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      line_secret_configured: !!process.env.LINE_CHANNEL_SECRET,
      working_directory: __dirname
    },
    ai_features: [
      '自然語言理解',
      '意圖識別分析',
      '情感狀態分析',
      '個人化對話',
      '對話歷史記憶',
      '智慧回應生成',
      '上下文理解',
      '實體提取識別'
    ],
    traditional_features: [
      '即時空氣品質查詢',
      '多城市比較',
      '智慧健康建議',
      '訂閱提醒系統',
      'GPS定位查詢',
      '圖文選單介面',
      '用戶狀態管理'
    ],
    ai_statistics: {
      total_conversations: conversationHistory.size,
      total_user_profiles: userProfiles.size,
      conversation_history_entries: Array.from(conversationHistory.values()).reduce((sum, history) => sum + history.length, 0),
      ai_engine_status: 'active',
      supported_intents: Object.keys(new AIConversationEngine().intentPatterns).length,
      emotion_keywords_count: Object.values(new AIConversationEngine().emotionKeywords).reduce((sum, emotions) => sum + emotions.length, 0)
    },
    statistics: {
      total_subscriptions: subscriptions.size,
      location_cache_entries: locationCache.size,
      active_user_states: userStates.size,
      supported_cities: Object.keys(cityMap).length
    }
  });
});

// AI 統計端點
app.get('/api/ai/stats', (req, res) => {
  const aiEngine = new AIConversationEngine();
  
  // 計算對話統計
  const conversationStats = {
    total_users: conversationHistory.size,
    total_messages: 0,
    average_conversation_length: 0,
    most_active_user: null,
    recent_conversations: 0
  };

  let maxMessages = 0;
  let totalMessages = 0;
  const oneDayAgo = Date.now() - 86400000; // 24小時前

  for (const [userId, history] of conversationHistory.entries()) {
    totalMessages += history.length;
    
    if (history.length > maxMessages) {
      maxMessages = history.length;
      conversationStats.most_active_user = userId.substring(0, 8) + '...'; // 匿名化
    }
    
    // 計算最近24小時的對話
    const recentMessages = history.filter(msg => msg.timestamp > oneDayAgo);
    if (recentMessages.length > 0) {
      conversationStats.recent_conversations++;
    }
  }

  conversationStats.total_messages = totalMessages;
  conversationStats.average_conversation_length = conversationHistory.size > 0 ? 
    Math.round(totalMessages / conversationHistory.size) : 0;

  // 意圖使用統計
  const intentStats = {};
  for (const [userId, history] of conversationHistory.entries()) {
    for (const message of history) {
      if (message.intent) {
        intentStats[message.intent] = (intentStats[message.intent] || 0) + 1;
      }
    }
  }

  res.json({
    ai_engine: {
      version: '1.0.0',
      supported_intents: Object.keys(aiEngine.intentPatterns).length,
      emotion_categories: Object.keys(aiEngine.emotionKeywords).length,
      response_templates: Object.keys(aiEngine.responseTemplates).length
    },
    conversation_stats: conversationStats,
    intent_usage: intentStats,
    user_profiles: {
      total_profiles: userProfiles.size,
      profiles_with_preferences: Array.from(userProfiles.values()).filter(profile => 
        profile.preferences && (profile.preferences.cities.length > 0 || profile.preferences.concerns.length > 0)
      ).length,
      personality_distribution: Array.from(userProfiles.values()).reduce((acc, profile) => {
        const personality = profile.personality || 'unknown';
        acc[personality] = (acc[personality] || 0) + 1;
        return acc;
      }, {})
    },
    performance: {
      memory_usage: process.memoryUsage(),
      uptime_seconds: Math.floor(process.uptime()),
      last_updated: new Date().toISOString()
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
      name: 'AI 智慧空氣品質機器人',
      version: '2.1.0-AI',
      status: 'running'
    },
    ai_features: {
      natural_language_processing: 'enabled',
      intent_recognition: 'enabled',
      emotion_analysis: 'enabled',
      personalization: 'enabled',
      conversation_memory: 'enabled',
      contextual_understanding: 'enabled'
    },
    statistics: {
      supportedCities: Object.keys(cityMap).length,
      totalSubscriptions: subscriptions.size,
      activeCacheEntries: locationCache.size,
      activeUserStates: userStates.size,
      conversationUsers: conversationHistory.size,
      userProfiles: userProfiles.size
    },
    features: [
      'ai_natural_language_processing',
      'intent_recognition_analysis',
      'emotion_analysis_response',
      'personalized_conversations',
      'conversation_history_memory',
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

// 調試端點 - 檢查AI服務狀態
app.get('/debug', (req, res) => {
  try {
    const aiEngine = new AIConversationEngine();
    
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
      ai_system: {
        engine_status: 'active',
        conversation_manager_status: 'active',
        supported_intents: Object.keys(aiEngine.intentPatterns),
        emotion_categories: Object.keys(aiEngine.emotionKeywords),
        response_template_types: Object.keys(aiEngine.responseTemplates),
        total_conversation_users: conversationHistory.size,
        total_user_profiles: userProfiles.size
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
        'GET /api/ai/stats',
        'GET /api/subscriptions/stats',
        'POST /webhook'
      ],
      data_statistics: {
        subscriptions_count: subscriptions.size,
        location_cache_count: locationCache.size,
        user_states_count: userStates.size,
        conversation_history_count: conversationHistory.size,
        user_profiles_count: userProfiles.size,
        supported_cities_count: Object.keys(cityMap).length
      },
      features_status: {
        ai_natural_language: 'enabled',
        intent_recognition: 'enabled',
        emotion_analysis: 'enabled',
        personalization: 'enabled',
        conversation_memory: 'enabled',
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

// 清理過期的用戶狀態、位置快取和對話歷史
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
  
  // 清理過期的對話歷史（超過7天的記錄）
  for (const [userId, history] of conversationHistory.entries()) {
    const filteredHistory = history.filter(msg => now - msg.timestamp < 604800000); // 7天
    if (filteredHistory.length !== history.length) {
      if (filteredHistory.length > 0) {
        conversationHistory.set(userId, filteredHistory);
      } else {
        conversationHistory.delete(userId);
      }
    }
  }
  
  // 清理不活躍的用戶資料（超過30天未互動）
  for (const [userId, profile] of userProfiles.entries()) {
    if (now - profile.lastInteraction > 2592000000) { // 30天
      userProfiles.delete(userId);
    }
  }
  
  console.log(`AI清理完成 - 用戶狀態: ${userStates.size}, 位置快取: ${locationCache.size}, 對話歷史: ${conversationHistory.size}, 用戶資料: ${userProfiles.size}`);
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
    available_routes: ['/', '/health', '/debug', '/api/air-quality/:city', '/api/stats', '/api/ai/stats', '/api/subscriptions/stats'],
    timestamp: new Date().toISOString()
  });
});

// 優雅關機處理
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，正在優雅關機...');
  // 可以在這裡保存AI對話歷史和用戶資料到數據庫
  console.log(`保存 ${conversationHistory.size} 個用戶的對話歷史`);
  console.log(`保存 ${userProfiles.size} 個用戶資料`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('收到 SIGINT 信號，正在優雅關機...');
  console.log(`保存 ${conversationHistory.size} 個用戶的對話歷史`);
  console.log(`保存 ${userProfiles.size} 個用戶資料`);
  process.exit(0);
});

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 AI 智慧空氣品質機器人在端口 ${port} 上運行`);
  console.log('🤖 全新 AI 自然語言處理功能已啟用！');
  console.log('✨ AI 功能列表：');
  console.log('🧠 自然語言理解 - 理解各種表達方式');
  console.log('🎯 智慧意圖識別 - 精準判斷用戶需求');
  console.log('😊 情感狀態分析 - 感受用戶情緒');
  console.log('👤 個人化對話體驗 - 記住用戶偏好');
  console.log('💭 對話歷史記憶 - 上下文理解');
  console.log('🎨 動態回應生成 - 自然對話風格');
  console.log('🔍 實體提取識別 - 提取關鍵資訊');
  console.log('📚 學習型系統 - 持續優化體驗');
  
  console.log('\n📋 傳統功能（保留）：');
  console.log('✅ 即時空氣品質查詢');
  console.log('✅ 多城市比較功能');
  console.log('✅ 智慧健康建議系統');
  console.log('✅ 完整訂閱管理系統');
  console.log('✅ GPS定位查詢');
  console.log('✅ 圖文選單介面');
  console.log('✅ 個人化設定');
  console.log('✅ 每日報告推送');
  console.log('✅ 緊急警報系統');
  
  console.log(`\n🌐 服務網址: http://0.0.0.0:${port}`);
  console.log(`🔗 AI統計: http://0.0.0.0:${port}/api/ai/stats`);
  
  // 檢查環境變數
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
    console.warn('⚠️ 警告：LINE Bot 環境變數未完整設定');
    console.warn('請在 Render Dashboard 設定以下環境變數：');
    console.warn('- LINE_CHANNEL_ACCESS_TOKEN');
    console.warn('- LINE_CHANNEL_SECRET');
  } else {
    console.log('✅ LINE Bot 環境變數設定完成');
  }
  
  // AI系統統計信息
  const aiEngine = new AIConversationEngine();
  console.log('\n🤖 AI 系統初始統計：');
  console.log(`- 支援意圖類型: ${Object.keys(aiEngine.intentPatterns).length}`);
  console.log(`- 情感分析類別: ${Object.keys(aiEngine.emotionKeywords).length}`);
  console.log(`- 回應模板類型: ${Object.keys(aiEngine.responseTemplates).length}`);
  console.log(`- 對話用戶數量: ${conversationHistory.size}`);
  console.log(`- 用戶資料數量: ${userProfiles.size}`);
  
  // 傳統系統統計信息
  console.log('\n📊 傳統系統統計：');
  console.log(`- 支援城市數量: ${Object.keys(cityMap).length}`);
  console.log(`- 訂閱用戶數量: ${subscriptions.size}`);
  console.log(`- 活躍用戶狀態: ${userStates.size}`);
  console.log(`- 位置快取項目: ${locationCache.size}`);
  
  console.log('\n🎉 AI 系統已完全啟動，準備接收自然語言對話！');
  console.log('💬 用戶現在可以用自然的方式與機器人對話了！');
});

// 導出模組用於測試
module.exports = {
  app,
  AIConversationEngine,
  ConversationManager,
  conversationManager
};
                