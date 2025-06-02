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

// AI 設定 - 支援多種 AI 服務
const AI_CONFIG = {
  // OpenAI 設定 (推薦)
  openai: {
    enabled: !!process.env.OPENAI_API_KEY,
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-3.5-turbo',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  },
  // Anthropic Claude 設定 (備選)
  claude: {
    enabled: !!process.env.ANTHROPIC_API_KEY,
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-3-haiku-20240307',
    endpoint: 'https://api.anthropic.com/v1/messages'
  },
  // Google Gemini 設定 (備選)
  gemini: {
    enabled: !!process.env.GOOGLE_AI_KEY,
    apiKey: process.env.GOOGLE_AI_KEY,
    model: 'gemini-pro',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
  }
};

// 空氣品質API設定
const WAQI_TOKEN = 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// 創建LINE Bot客戶端
const client = new line.Client(config);

// 資料管理（在實際部署中建議使用資料庫）
let subscriptions = new Map(); // userId -> {cities: [], settings: {}}
let locationCache = new Map(); // userId -> {lat, lng, timestamp}
let userStates = new Map(); // userId -> {state: 'awaiting_city', context: {}}
let conversationHistory = new Map(); // userId -> [{role, content, timestamp}]
let userProfiles = new Map(); // userId -> {preferences, personality, context}

// 城市對應表
const cityMap = {
  '台北': 'taipei', '台中': 'taichung', '台南': 'tainan', '高雄': 'kaohsiung',
  '新北': 'new-taipei', '桃園': 'taoyuan', '基隆': 'keelung', '新竹': 'hsinchu',
  '苗栗': 'miaoli', '彰化': 'changhua', '南投': 'nantou', '雲林': 'yunlin',
  '嘉義': 'chiayi', '屏東': 'pingtung', '宜蘭': 'yilan', '花蓮': 'hualien',
  '台東': 'taitung', '澎湖': 'penghu', '金門': 'kinmen', '馬祖': 'matsu',
  '北京': 'beijing', '上海': 'shanghai', '東京': 'tokyo', '首爾': 'seoul',
  '曼谷': 'bangkok', '新加坡': 'singapore', '香港': 'hong-kong', '澳門': 'macau'
};

// ===== AI 自然語言處理模組 =====

// AI 意圖識別系統
class IntentClassifier {
  constructor() {
    this.intents = {
      // 空氣品質查詢意圖
      air_quality_query: {
        patterns: [
          /今天|現在|目前.*空氣.*怎麼樣|如何/,
          /空氣品質|空氣狀況|pm2\.?5|aqi/,
          /.*的空氣.*好嗎|乾淨嗎/,
          /要不要戴口罩/,
          /空污|霧霾|pm值/
        ],
        keywords: ['空氣', 'pm2.5', 'pm10', 'aqi', '空污', '霧霾', '口罩'],
        confidence: 0.8
      },
      
      // 比較查詢意圖
      comparison_query: {
        patterns: [
          /比較.*和.*空氣/,
          /.*vs.*空氣/,
          /哪裡空氣比較好/,
          /.*和.*哪個好/
        ],
        keywords: ['比較', 'vs', '對比', '哪裡好', '哪個好'],
        confidence: 0.7
      },
      
      // 健康建議意圖
      health_advice: {
        patterns: [
          /可以.*運動嗎|跑步嗎|出門嗎/,
          /適合.*戶外|室外/,
          /對.*身體.*影響/,
          /敏感族群|小孩|老人|孕婦/
        ],
        keywords: ['運動', '跑步', '出門', '戶外', '身體', '健康', '影響'],
        confidence: 0.8
      },
      
      // 位置查詢意圖
      location_query: {
        patterns: [
          /附近|周圍.*空氣/,
          /我這裡|我這邊/,
          /定位|gps|位置/
        ],
        keywords: ['附近', '周圍', '這裡', '這邊', '定位', 'gps'],
        confidence: 0.9
      },
      
      // 訂閱意圖
      subscription: {
        patterns: [
          /訂閱|通知|提醒.*空氣/,
          /每天.*報告/,
          /警報|警告/
        ],
        keywords: ['訂閱', '通知', '提醒', '報告', '警報'],
        confidence: 0.7
      },
      
      // 問候和閒聊意圖
      greeting: {
        patterns: [
          /^(你好|哈囉|嗨|hello|hi)$/i,
          /^早安|晚安|午安$/,
          /謝謝|感謝/
        ],
        keywords: ['你好', '哈囉', '嗨', '早安', '謝謝'],
        confidence: 0.9
      },
      
      // 幫助意圖
      help: {
        patterns: [
          /怎麼用|如何使用/,
          /幫助|help|說明/,
          /不知道|不會用/
        ],
        keywords: ['幫助', '說明', '怎麼用', '如何'],
        confidence: 0.8
      }
    };
  }

  // 識別用戶意圖
  classifyIntent(text) {
    const results = [];
    
    for (const [intentName, config] of Object.entries(this.intents)) {
      let score = 0;
      
      // 模式匹配
      for (const pattern of config.patterns) {
        if (pattern.test(text)) {
          score += 0.6;
          break;
        }
      }
      
      // 關鍵字匹配
      const matchedKeywords = config.keywords.filter(keyword => 
        text.includes(keyword)
      );
      score += (matchedKeywords.length / config.keywords.length) * 0.4;
      
      if (score > 0) {
        results.push({
          intent: intentName,
          confidence: Math.min(score * config.confidence, 1.0),
          matchedKeywords
        });
      }
    }
    
    // 排序並返回最可能的意圖
    results.sort((a, b) => b.confidence - a.confidence);
    return results[0] || { intent: 'unknown', confidence: 0.0 };
  }
}

// 實體識別系統
class EntityExtractor {
  constructor() {
    this.entities = {
      cities: Object.keys(cityMap),
      times: ['今天', '明天', '現在', '目前', '早上', '下午', '晚上'],
      activities: ['跑步', '運動', '散步', '騎車', '爬山', '戶外'],
      groups: ['敏感族群', '小孩', '老人', '孕婦', '兒童']
    };
  }

  // 提取實體
  extractEntities(text) {
    const extracted = {
      cities: [],
      times: [],
      activities: [],
      groups: []
    };

    // 提取城市
    for (const city of this.entities.cities) {
      if (text.includes(city)) {
        const englishName = cityMap[city];
        extracted.cities.push({ chinese: city, english: englishName });
      }
    }

    // 提取時間
    for (const time of this.entities.times) {
      if (text.includes(time)) {
        extracted.times.push(time);
      }
    }

    // 提取活動
    for (const activity of this.entities.activities) {
      if (text.includes(activity)) {
        extracted.activities.push(activity);
      }
    }

    // 提取族群
    for (const group of this.entities.groups) {
      if (text.includes(group)) {
        extracted.groups.push(group);
      }
    }

    return extracted;
  }
}

// AI 對話管理器
class ConversationManager {
  constructor() {
    this.intentClassifier = new IntentClassifier();
    this.entityExtractor = new EntityExtractor();
    this.maxHistoryLength = 10;
  }

  // 獲取對話歷史
  getConversationHistory(userId) {
    return conversationHistory.get(userId) || [];
  }

  // 添加對話記錄
  addToHistory(userId, role, content) {
    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    
    const history = conversationHistory.get(userId);
    history.push({
      role,
      content,
      timestamp: new Date().toISOString()
    });

    // 限制歷史長度
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  // 獲取用戶檔案
  getUserProfile(userId) {
    if (!userProfiles.has(userId)) {
      userProfiles.set(userId, {
        preferences: {
          cities: [],
          alertThreshold: 100,
          language: 'zh-TW'
        },
        personality: 'friendly', // friendly, professional, casual
        context: {}
      });
    }
    return userProfiles.get(userId);
  }

  // 更新用戶偏好
  updateUserPreferences(userId, preferences) {
    const profile = this.getUserProfile(userId);
    profile.preferences = { ...profile.preferences, ...preferences };
    
    // 同步到訂閱系統
    if (preferences.cities) {
      preferences.cities.forEach(city => {
        addSubscription(userId, city);
      });
    }
  }

  // 分析用戶訊息
  async analyzeMessage(userId, text) {
    const intent = this.intentClassifier.classifyIntent(text);
    const entities = this.entityExtractor.extractEntities(text);
    const history = this.getConversationHistory(userId);
    const profile = this.getUserProfile(userId);

    return {
      intent,
      entities,
      history,
      profile,
      originalText: text
    };
  }
}

// AI 回應生成器
class ResponseGenerator {
  constructor() {
    this.conversationManager = new ConversationManager();
  }

  // 生成 AI 回應
  async generateResponse(userId, analysis) {
    const { intent, entities, profile, originalText } = analysis;

    // 根據意圖生成基礎回應
    let response = await this.generateIntentResponse(intent, entities, profile);
    
    // 如果有配置 AI API，增強回應
    if (this.hasAIService()) {
      try {
        response = await this.enhanceWithAI(userId, analysis, response);
      } catch (error) {
        console.error('AI 增強失敗，使用基礎回應:', error);
      }
    }

    // 添加到對話歷史
    this.conversationManager.addToHistory(userId, 'user', originalText);
    this.conversationManager.addToHistory(userId, 'assistant', response.text || response);

    return response;
  }

  // 檢查是否有可用的 AI 服務
  hasAIService() {
    return AI_CONFIG.openai.enabled || AI_CONFIG.claude.enabled || AI_CONFIG.gemini.enabled;
  }

  // 使用 AI 增強回應
  async enhanceWithAI(userId, analysis, baseResponse) {
    const { intent, entities, history, profile, originalText } = analysis;
    
    // 建構系統提示
    const systemPrompt = this.buildSystemPrompt(profile);
    
    // 建構對話上下文
    const conversationContext = this.buildConversationContext(history, analysis);
    
    // 選擇可用的 AI 服務
    let aiResponse;
    if (AI_CONFIG.openai.enabled) {
      aiResponse = await this.callOpenAI(systemPrompt, conversationContext, originalText);
    } else if (AI_CONFIG.claude.enabled) {
      aiResponse = await this.callClaude(systemPrompt, conversationContext, originalText);
    } else if (AI_CONFIG.gemini.enabled) {
      aiResponse = await this.callGemini(systemPrompt, conversationContext, originalText);
    }

    // 解析 AI 回應並決定是否需要功能性操作
    return this.parseAIResponse(aiResponse, baseResponse, analysis);
  }

  // 建構系統提示
  buildSystemPrompt(profile) {
    return `你是一個專業的空氣品質機器人助手，名叫「小空」。

你的角色特徵：
- 專精於空氣品質、環境健康、PM2.5、AQI 等相關知識
- 能提供即時的空氣品質查詢和專業健康建議
- 關心用戶健康，語氣${profile.personality === 'professional' ? '專業但親切' : '友善親和'}
- 會根據空氣品質狀況給出具體的行動建議

你的功能包括：
1. 空氣品質即時查詢 (支援全球主要城市)
2. 多城市空氣品質比較
3. 個人化健康建議 (考量不同族群需求)
4. GPS 定位附近監測站查詢
5. 訂閱空氣品質提醒服務

回應原則：
- 保持回應簡潔且實用 (建議200字以內)
- 對於空氣品質查詢，要提供具體的 AQI 數值和健康建議
- 遇到不確定的問題，建議用戶使用具體功能
- 適時使用 emoji 讓對話更親切
- 如果用戶詢問的城市需要查詢，會在回應中說明需要查詢

記住：你是一個專業但親切的空氣品質專家，目標是幫助用戶做出明智的健康決策。`;
  }

  // 建構對話上下文
  buildConversationContext(history, analysis) {
    const { intent, entities } = analysis;
    
    let context = `對話意圖: ${intent.intent} (信心度: ${Math.round(intent.confidence * 100)}%)\n`;
    
    if (entities.cities.length > 0) {
      context += `提到的城市: ${entities.cities.map(c => c.chinese).join(', ')}\n`;
    }
    
    if (entities.activities.length > 0) {
      context += `相關活動: ${entities.activities.join(', ')}\n`;
    }
    
    if (entities.groups.length > 0) {
      context += `目標族群: ${entities.groups.join(', ')}\n`;
    }

    // 添加最近的對話歷史
    if (history.length > 0) {
      context += '\n最近對話:\n';
      history.slice(-3).forEach(msg => {
        context += `${msg.role}: ${msg.content}\n`;
      });
    }

    return context;
  }

  // 呼叫 OpenAI API
  async callOpenAI(systemPrompt, context, userMessage) {
    const response = await axios.post(
      AI_CONFIG.openai.endpoint,
      {
        model: AI_CONFIG.openai.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${context}\n\n用戶訊息: ${userMessage}` }
        ],
        max_tokens: 300,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${AI_CONFIG.openai.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0].message.content;
  }

  // 呼叫 Claude API
  async callClaude(systemPrompt, context, userMessage) {
    const response = await axios.post(
      AI_CONFIG.claude.endpoint,
      {
        model: AI_CONFIG.claude.model,
        max_tokens: 300,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `${context}\n\n${userMessage}` }
        ]
      },
      {
        headers: {
          'x-api-key': AI_CONFIG.claude.apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        }
      }
    );

    return response.data.content[0].text;
  }

  // 呼叫 Gemini API
  async callGemini(systemPrompt, context, userMessage) {
    const response = await axios.post(
      `${AI_CONFIG.gemini.endpoint}?key=${AI_CONFIG.gemini.apiKey}`,
      {
        contents: [{
          parts: [{
            text: `${systemPrompt}\n\n${context}\n\n用戶: ${userMessage}`
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.candidates[0].content.parts[0].text;
  }

  // 解析 AI 回應並決定動作
  parseAIResponse(aiResponse, baseResponse, analysis) {
    const { intent, entities } = analysis;
    
    // 檢查 AI 是否建議執行特定功能
    const actionPatterns = {
      query: /查詢|搜尋|查看.*空氣品質/,
      compare: /比較|對比/,
      location: /定位|附近/,
      subscribe: /訂閱|通知/
    };

    let suggestedAction = null;
    for (const [action, pattern] of Object.entries(actionPatterns)) {
      if (pattern.test(aiResponse)) {
        suggestedAction = action;
        break;
      }
    }

    // 如果有明確的意圖和實體，優先執行功能
    if (intent.confidence > 0.6 && (
      (intent.intent === 'air_quality_query' && entities.cities.length > 0) ||
      (intent.intent === 'comparison_query' && entities.cities.length >= 2) ||
      (intent.intent === 'location_query')
    )) {
      return {
        type: 'functional',
        text: aiResponse,
        action: intent.intent,
        entities: entities,
        shouldExecuteFunction: true
      };
    }

    // 否則返回純對話回應
    return {
      type: 'conversational',
      text: aiResponse,
      suggestedAction,
      entities: entities
    };
  }

  // 生成基於意圖的回應
  async generateIntentResponse(intent, entities, profile) {
    switch (intent.intent) {
      case 'air_quality_query':
        if (entities.cities.length > 0) {
          return {
            type: 'query',
            cities: entities.cities,
            message: `好的！我來幫您查詢 ${entities.cities.map(c => c.chinese).join('、')} 的空氣品質狀況 🌬️`
          };
        }
        return "請告訴我您想查詢哪個城市的空氣品質？我支援台灣各縣市以及國際主要城市喔！🏙️";

      case 'comparison_query':
        if (entities.cities.length >= 2) {
          return {
            type: 'compare',
            cities: entities.cities,
            message: `我來幫您比較 ${entities.cities.map(c => c.chinese).join(' vs ')} 的空氣品質！📊`
          };
        }
        return "比較功能需要至少兩個城市，請告訴我您想比較哪些城市？🆚";

      case 'health_advice':
        return "根據空氣品質狀況，我會提供專業的健康建議。請先告訴我您所在的位置或想了解的城市？💊";

      case 'location_query':
        return {
          type: 'location',
          message: "請分享您的位置，我來查詢附近的空氣品質監測站！📍"
        };

      case 'subscription':
        return {
          type: 'subscribe',
          message: "我可以為您設定空氣品質提醒！包括每日報告和緊急警報 🔔"
        };

      case 'greeting':
        const greetings = [
          "您好！我是您的空氣品質小助手 🌬️ 隨時為您提供最新的空氣品質資訊！",
          "嗨！今天想了解哪裡的空氣品質呢？我來幫您查詢！😊",
          "哈囉！需要空氣品質資訊嗎？我可以幫您查詢、比較，還有健康建議喔！🌟"
        ];
        return greetings[Math.floor(Math.random() * greetings.length)];

      case 'help':
        return "我能幫您：\n🔍 查詢空氣品質\n📊 比較多個城市\n💊 提供健康建議\n📍 附近監測站查詢\n🔔 設定提醒通知\n\n直接跟我說話就行了！";

      default:
        return "我理解您的意思，但可能需要更具體的資訊。您可以直接跟我說您想了解什麼，或使用選單功能喔！😊";
    }
  }
}

// 初始化 AI 系統
const responseGenerator = new ResponseGenerator();

// ===== 修改主要事件處理函數以整合 AI =====

// 【AI增強】主要事件處理函數
async function handleEvent(event) {
  console.log('收到事件:', event.type, event.message?.type || 'non-message');
  
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

  const userMessage = event.message.text.trim();
  console.log(`用戶 ${userId} 發送訊息: "${userMessage}"`);
  
  try {
    // 檢查用戶狀態
    const userState = getUserState(userId);
    
    // 處理有狀態的對話（保持原有邏輯）
    if (userState) {
      console.log(`處理用戶狀態: ${userState.state}`);
      return await handleStatefulMessage(event, userState);
    }
    
    // 【新增】檢查是否為傳統指令格式（保持向後兼容）
    const traditionalResult = await handleTraditionalCommands(userMessage, userId, event);
    if (traditionalResult) {
      return traditionalResult;
    }

    // 【AI核心】分析用戶訊息並生成智慧回應
    const analysis = await responseGenerator.conversationManager.analyzeMessage(userId, userMessage);
    const aiResponse = await responseGenerator.generateResponse(userId, analysis);

    console.log('AI 分析結果:', {
      intent: analysis.intent.intent,
      confidence: analysis.intent.confidence,
      entities: analysis.entities,
      responseType: aiResponse.type
    });

    // 根據 AI 回應類型執行相應動作
    return await executeAIResponse(event, aiResponse, analysis);
    
  } catch (error) {
    console.error('處理訊息錯誤:', error);
    
    // AI 錯誤回覆
    const errorMessage = {
      type: 'text',
      text: '抱歉，我遇到了一些技術問題 😅 不過我的基本功能都還正常！請試試直接告訴我您想查詢的城市，或使用下方選單功能。'
    };
    const menuMessage = createMainMenuFlexMessage();
    
    return client.replyMessage(event.replyToken, [errorMessage, menuMessage]);
  }
}

// 處理傳統指令格式（保持向後兼容）
async function handleTraditionalCommands(userMessage, userId, event) {
  // 處理問候語或主選單
  if (userMessage.match(/^(你好|哈囉|hello|hi|主選單|menu|開始|start)$/i)) {
    const welcomeMessage = createWelcomeFlexMessage();
    const menuMessage = createMainMenuFlexMessage();
    return client.replyMessage(event.replyToken, [welcomeMessage, menuMessage]);
  }

  // 檢查是否為幫助指令
  if (userMessage.match(/^(幫助|help|使用說明|教學|說明)$/i)) {
    const helpMessage = createHelpFlexMessage();
    return client.replyMessage(event.replyToken, helpMessage);
  }

  // 檢查是否為設定相關功能
  if (userMessage.match(/^(我的設定|設定|settings)$/i)) {
    const settingsMessage = createSettingsFlexMessage(userId);
    return client.replyMessage(event.replyToken, settingsMessage);
  }

  // 其他傳統指令...
  return null; // 表示沒有匹配到傳統指令
}

// 執行 AI 回應
async function executeAIResponse(event, aiResponse, analysis) {
  const userId = event.source.userId;

  switch (aiResponse.type) {
    case 'functional':
      // 執行功能性操作
      return await executeFunctionalResponse(event, aiResponse, analysis);
      
    case 'conversational':
      // 純對話回應，可能包含建議動作
      return await executeConversationalResponse(event, aiResponse, analysis);
      
    case 'query':
      // 直接執行查詢
      return await executeQueryResponse(event, aiResponse);
      
    case 'compare':
      // 執行比較
      return await executeCompareResponse(event, aiResponse);
      
    case 'location':
      // 請求位置
      return await executeLocationRequest(event, aiResponse);
      
    case 'subscribe':
      // 處理訂閱
      return await executeSubscribeResponse(event, aiResponse);
      
    default:
      // 預設回應
      const textMessage = {
        type: 'text',
        text: typeof aiResponse === 'string' ? aiResponse : aiResponse.text
      };
      return client.replyMessage(event.replyToken, textMessage);
  }
}

// 執行功能性回應
async function executeFunctionalResponse(event, aiResponse, analysis) {
  const { intent, entities } = analysis;
  
  if (intent.intent === 'air_quality_query' && entities.cities.length > 0) {
    // 執行空氣品質查詢
    const city = entities.cities[0];
    const airQualityData = await getAirQuality(city.english);
    const flexMessage = createAirQualityFlexMessage(airQualityData);
    
    // 結合 AI 回應和功能結果
    const aiTextMessage = {
      type: 'text',
      text: aiResponse.text
    };
    
    return client.replyMessage(event.replyToken, [aiTextMessage, flexMessage]);
  }
  
  if (intent.intent === 'comparison_query' && entities.cities.length >= 2) {
    // 執行城市比較
    const citiesData = await getMultipleCitiesAirQuality(entities.cities);
    const comparisonMessage = createCityComparisonFlexMessage(citiesData);
    
    const aiTextMessage = {
      type: 'text',
      text: aiResponse.text
    };
    
    return client.replyMessage(event.replyToken, [aiTextMessage, comparisonMessage]);
  }
  
  // 其他功能性回應
  const textMessage = {
    type: 'text',
    text: aiResponse.text
  };
  return client.replyMessage(event.replyToken, textMessage);
}

// 執行對話式回應
async function executeConversationalResponse(event, aiResponse, analysis) {
  const textMessage = {
    type: 'text',
    text: aiResponse.text
  };
  
  // 如果有建議動作，提供快速選項
  if (aiResponse.suggestedAction || aiResponse.entities.cities.length > 0) {
    const quickReplyItems = [];
    
    if (aiResponse.entities.cities.length > 0) {
      aiResponse.entities.cities.slice(0, 3).forEach(city => {
        quickReplyItems.push({
          type: 'action',
          action: {
            type: 'message',
            label: `查詢${city.chinese}`,
            text: `${city.chinese}空氣品質`
          }
        });
      });
    }
    
    // 添加常用快速回覆
    if (quickReplyItems.length < 3) {
      const commonActions = [
        { label: '附近查詢', text: '查詢附近空氣品質' },
        { label: '城市比較', text: '比較台北高雄' },
        { label: '主選單', text: '主選單' }
      ];
      
      commonActions.forEach(action => {
        if (quickReplyItems.length < 4) {
          quickReplyItems.push({
            type: 'action',
            action: {
              type: 'message',
              label: action.label,
              text: action.text
            }
          });
        }
      });
    }
    
    if (quickReplyItems.length > 0) {
      textMessage.quickReply = {
        items: quickReplyItems
      };
    }
  }
  
  return client.replyMessage(event.replyToken, textMessage);
}

// 執行查詢回應
async function executeQueryResponse(event, aiResponse) {
  if (aiResponse.cities && aiResponse.cities.length > 0) {
    const city = aiResponse.cities[0];
    const airQualityData = await getAirQuality(city.english);
    const flexMessage = createAirQualityFlexMessage(airQualityData);
    
    const aiTextMessage = {
      type: 'text',
      text: aiResponse.message
    };
    
    return client.replyMessage(event.replyToken, [aiTextMessage, flexMessage]);
  } else {
    const citySelectionMessage = createCitySelectionFlexMessage();
    const textMessage = {
      type: 'text',
      text: aiResponse.message || "請選擇您想查詢的城市："
    };
    return client.replyMessage(event.replyToken, [textMessage, citySelectionMessage]);
  }
}

// 執行比較回應
async function executeCompareResponse(event, aiResponse) {
  if (aiResponse.cities && aiResponse.cities.length >= 2) {
    const citiesData = await getMultipleCitiesAirQuality(aiResponse.cities);
    const comparisonMessage = createCityComparisonFlexMessage(citiesData);
    
    const aiTextMessage = {
      type: 'text',
      text: aiResponse.message
    };
    
    return client.replyMessage(event.replyToken, [aiTextMessage, comparisonMessage]);
  } else {
    const textMessage = {
      type: 'text',
      text: aiResponse.message || "比較功能需要至少兩個城市，請告訴我您想比較哪些城市？"
    };
    
    // 設定狀態等待用戶輸入城市
    setUserState(event.source.userId, 'awaiting_compare_cities');
    
    return client.replyMessage(event.replyToken, textMessage);
  }
}

// 執行位置請求
async function executeLocationRequest(event, aiResponse) {
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
            text: aiResponse.message || '請分享您的位置，我來查詢附近的空氣品質監測站！',
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
            type: 'button',
            style: 'primary',
            color: '#00e400',
            action: {
              type: 'location',
              label: '📍 分享我的位置'
            }
          }
        ]
      }
    }
  };
  
  return client.replyMessage(event.replyToken, locationMessage);
}

// 執行訂閱回應
async function executeSubscribeResponse(event, aiResponse) {
  const subscriptionMessage = createSubscriptionManagementFlexMessage(event.source.userId);
  const textMessage = {
    type: 'text',
    text: aiResponse.message || "我可以為您設定空氣品質提醒！"
  };
  
  return client.replyMessage(event.replyToken, [textMessage, subscriptionMessage]);
}

// ===== 保持原有的其他函數 =====
// (這裡包含所有原來的函數，如 getAirQuality, createFlexMessages 等...)

// [保持所有原有函數不變，這裡為了節省空間省略]
// 包括：
// - setUserState, getUserState, clearUserState
// - addSubscription, removeSubscription 等訂閱管理
// - getAirQuality, getMultipleCitiesAirQuality
// - 所有 createXXXFlexMessage 函數
// - AQI 等級判斷和健康建議函數
// - cron 定時任務
// - 錯誤處理函數

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log('=' .repeat(80));
  console.log(`🤖 AI 增強版 LINE 智慧空氣品質機器人在端口 ${port} 上運行`);
  console.log('=' .repeat(80));
  
  console.log('🧠 AI 功能狀態：');
  console.log(`✅ OpenAI: ${AI_CONFIG.openai.enabled ? '已啟用' : '未配置'}`);
  console.log(`✅ Claude: ${AI_CONFIG.claude.enabled ? '已啟用' : '未配置'}`);
  console.log(`✅ Gemini: ${AI_CONFIG.gemini.enabled ? '已啟用' : '未配置'}`);
  
  if (!responseGenerator.hasAIService()) {
    console.log('\n⚠️ 警告：沒有配置 AI 服務，將使用基礎自然語言處理');
    console.log('建議在 Render Dashboard 設定以下任一環境變數：');
    console.log('- OPENAI_API_KEY (推薦)');
    console.log('- ANTHROPIC_API_KEY');
    console.log('- GOOGLE_AI_KEY');
  } else {
    console.log('\n✨ AI 增強功能已啟用！用戶可以自然對話');
  }
  
  console.log('\n🌟 新增 AI 功能：');
  console.log('✨ 自然語言意圖識別');
  console.log('✨ 智慧實體抽取');
  console.log('✨ 對話上下文記憶');
  console.log('✨ 個人化回應生成');
  console.log('✨ 多重 AI 服務支援');
  console.log('✨ 向後兼容傳統指令');
  
  console.log('\n🎉 用戶現在可以像與人聊天一樣與機器人互動！');
  console.log('📱 支援自然語言：「台北今天空氣怎麼樣？」');
  console.log('🗣️ 智慧對話：「我想要跑步，適合嗎？」');
  console.log('🤝 個人化服務：根據用戶偏好調整回應風格');
  console.log('=' .repeat(80));
});

// ... 原有的其他程式碼保持不變 ...