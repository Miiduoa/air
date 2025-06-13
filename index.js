const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');

const app = express();

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// WAQI API 設定
const WAQI_TOKEN = 'b144682944ddd13da46203e66fed4fd6be745619';
const WAQI_BASE_URL = 'https://api.waqi.info';

// LINE Bot 客戶端
const client = new line.Client(config);

// 資料儲存
const subscriptions = new Map(); // userId -> {cities, settings}
const userStates = new Map(); // userId -> {state, context, timestamp}

// 城市對照表
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

// AQI 等級判斷
function getAQILevel(aqi) {
  if (aqi <= 50) return { level: '良好', color: '#00e400', emoji: '😊' };
  if (aqi <= 100) return { level: '普通', color: '#ffff00', emoji: '😐' };
  if (aqi <= 150) return { level: '對敏感族群不健康', color: '#ff7e00', emoji: '😷' };
  if (aqi <= 200) return { level: '不健康', color: '#ff0000', emoji: '😰' };
  if (aqi <= 300) return { level: '非常不健康', color: '#8f3f97', emoji: '🤢' };
  return { level: '危險', color: '#7e0023', emoji: '☠️' };
}

// 健康建議
function getHealthAdvice(aqi) {
  if (aqi <= 50) {
    return {
      general: '空氣品質極佳！適合所有戶外活動',
      sensitive: '敏感族群也可正常戶外活動',
      exercise: '🏃‍♂️ 極適合：跑步、騎車、登山等高強度運動',
      mask: '無需配戴口罩'
    };
  } else if (aqi <= 100) {
    return {
      general: '空氣品質可接受，一般人群可正常活動',
      sensitive: '敏感族群請減少長時間戶外劇烈運動',
      exercise: '適合：散步、瑜伽、輕度慢跑',
      mask: '建議配戴一般口罩'
    };
  } else if (aqi <= 150) {
    return {
      general: '對敏感族群不健康，一般人群減少戶外活動',
      sensitive: '敏感族群應避免戶外活動',
      exercise: '建議室內運動：瑜伽、伸展、重訓',
      mask: '必須配戴N95或醫用口罩'
    };
  } else if (aqi <= 200) {
    return {
      general: '所有人群都應減少戶外活動',
      sensitive: '敏感族群請留在室內',
      exercise: '僅建議室內輕度活動',
      mask: '外出必須配戴N95口罩'
    };
  } else {
    return {
      general: '緊急狀況！所有人應留在室內',
      sensitive: '立即尋求室內避難場所',
      exercise: '禁止所有戶外活動',
      mask: '外出必須配戴專業防護口罩'
    };
  }
}

// 查詢空氣品質
async function getAirQuality(city) {
  try {
    const url = `${WAQI_BASE_URL}/feed/${city}/?token=${WAQI_TOKEN}`;
    const response = await axios.get(url);
    if (response.data.status === 'ok') {
      return response.data.data;
    }
    throw new Error(`API error: ${response.data.status}`);
  } catch (error) {
    console.error(`Error fetching AQI for ${city}:`, error);
    throw error;
  }
}

// 使用者狀態管理
function setUserState(userId, state, context = {}) {
  userStates.set(userId, { state, context, timestamp: Date.now() });
}

function getUserState(userId) {
  const userState = userStates.get(userId);
  if (userState && Date.now() - userState.timestamp < 300000) { // 5分鐘超時
    return userState;
  }
  userStates.delete(userId);
  return null;
}

function clearUserState(userId) {
  userStates.delete(userId);
}

// 訂閱管理
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
    return true;
  }
  return false;
}

function removeSubscription(userId, city) {
  if (subscriptions.has(userId)) {
    const userSub = subscriptions.get(userId);
    const idx = userSub.cities.indexOf(city);
    if (idx !== -1) {
      userSub.cities.splice(idx, 1);
      return true;
    }
  }
  return false;
}

function getUserSubscriptions(userId) {
  return subscriptions.get(userId) || { cities: [], settings: {} };
}

// 建立主選單
function createMainMenuFlexMessage() {
  return {
    type: 'flex',
    altText: '主選單',
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: 'https://images.unsplash.com/photo-1534088568595-a066f410bcda?w=800',
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '智慧空氣品質助手',
            weight: 'bold',
            size: 'xl',
            color: '#1f76d2'
          },
          {
            type: 'text',
            text: '即時查詢、訂閱提醒、健康建議',
            size: 'sm',
            color: '#999999',
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
            height: 'sm',
            action: {
              type: 'message',
              label: '🔍 查詢空氣品質',
              text: '查詢空氣品質'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '🔔 訂閱管理',
              text: '訂閱管理'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '📊 城市比較',
              text: '比較城市'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '❓ 使用說明',
              text: '使用說明'
            }
          }
        ]
      }
    }
  };
}

// 建立城市選擇選單
function createCitySelectionFlexMessage() {
  return {
    type: 'flex',
    altText: '選擇城市',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🇹🇼 台灣北部',
                weight: 'bold',
                size: 'lg',
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
                height: 'sm',
                action: {
                  type: 'message',
                  label: '台北',
                  text: '查詢台北'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '新北',
                  text: '查詢新北'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '桃園',
                  text: '查詢桃園'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '基隆',
                  text: '查詢基隆'
                }
              }
            ]
          }
        },
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🇹🇼 台灣中南部',
                weight: 'bold',
                size: 'lg',
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
                height: 'sm',
                action: {
                  type: 'message',
                  label: '台中',
                  text: '查詢台中'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '台南',
                  text: '查詢台南'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '高雄',
                  text: '查詢高雄'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '屏東',
                  text: '查詢屏東'
                }
              }
            ]
          }
        },
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: '🌏 國際城市',
                weight: 'bold',
                size: 'lg',
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
                height: 'sm',
                action: {
                  type: 'message',
                  label: '東京',
                  text: '查詢東京'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '首爾',
                  text: '查詢首爾'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '新加坡',
                  text: '查詢新加坡'
                }
              },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'message',
                  label: '香港',
                  text: '查詢香港'
                }
              }
            ]
          }
        }
      ]
    }
  };
}

// 建立空氣品質報告
function createAirQualityFlexMessage(data) {
  const aqi = data.aqi;
  const aqiInfo = getAQILevel(aqi);
  const advice = getHealthAdvice(aqi);
  
  return {
    type: 'flex',
    altText: `${data.city.name} AQI: ${aqi}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: aqiInfo.color,
        contents: [
          {
            type: 'text',
            text: `${aqiInfo.emoji} ${data.city.name}`,
            color: '#ffffff',
            size: 'xl',
            weight: 'bold'
          },
          {
            type: 'text',
            text: aqiInfo.level,
            color: '#ffffff',
            size: 'lg'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: 'AQI',
                size: 'xxl',
                weight: 'bold',
                color: aqiInfo.color
              },
              {
                type: 'text',
                text: aqi.toString(),
                size: 'xxl',
                weight: 'bold',
                align: 'end',
                color: aqiInfo.color
              }
            ]
          },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'text',
            text: '🏃 運動建議',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: advice.exercise,
            size: 'sm',
            wrap: true,
            margin: 'sm'
          },
          {
            type: 'text',
            text: '😷 口罩建議',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: advice.mask,
            size: 'sm',
            wrap: true,
            margin: 'sm'
          },
          {
            type: 'text',
            text: '💡 一般建議',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: advice.general,
            size: 'sm',
            wrap: true,
            margin: 'sm'
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
            height: 'sm',
            action: {
              type: 'message',
              label: '訂閱此城市',
              text: `訂閱${data.city.name}`
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '查詢其他城市',
              text: '查詢空氣品質'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '返回主選單',
              text: '主選單'
            }
          }
        ]
      }
    }
  };
}

// 建立簡單回應訊息
function createSimpleResponse(text, quickReplies = []) {
  const message = {
    type: 'text',
    text: text
  };
  
  if (quickReplies.length > 0) {
    message.quickReply = {
      items: quickReplies.map(reply => ({
        type: 'action',
        action: {
          type: 'message',
          label: reply,
          text: reply
        }
      }))
    };
  }
  
  return message;
}

// 建立訂閱管理選單
function createSubscriptionManagementFlexMessage(userId) {
  const userSub = getUserSubscriptions(userId);
  const subscribedCities = userSub.cities.map(city => {
    const chineseName = Object.keys(cityMap).find(key => cityMap[key] === city);
    return chineseName || city;
  });
  
  return {
    type: 'flex',
    altText: '訂閱管理',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🔔 訂閱管理',
            weight: 'bold',
            size: 'xl',
            color: '#1f76d2'
          },
          {
            type: 'text',
            text: subscribedCities.length > 0 
              ? `已訂閱城市：${subscribedCities.join('、')}`
              : '您還沒有訂閱任何城市',
            size: 'sm',
            color: '#666666',
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
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'message',
              label: '➕ 新增訂閱',
              text: '新增訂閱'
            }
          },
          ...(subscribedCities.length > 0 ? [
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: {
                type: 'message',
                label: '❌ 取消訂閱',
                text: '取消訂閱'
              }
            }
          ] : []),
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '返回主選單',
              text: '主選單'
            }
          }
        ]
      }
    }
  };
}

// 解析使用者輸入
function parseUserInput(text) {
  const normalizedText = text.trim().toLowerCase();
  
  // 直接命令對應
  const commands = {
    '主選單': { action: 'main_menu' },
    'menu': { action: 'main_menu' },
    '查詢空氣品質': { action: 'city_selection' },
    '訂閱管理': { action: 'subscription_management' },
    '比較城市': { action: 'compare_cities' },
    '使用說明': { action: 'help' },
    '新增訂閱': { action: 'add_subscription' },
    '取消訂閱': { action: 'remove_subscription' },
    '取消': { action: 'cancel' }
  };
  
  if (commands[text]) {
    return commands[text];
  }
  
  // 查詢城市
  if (text.includes('查詢')) {
    for (const [chinese, english] of Object.entries(cityMap)) {
      if (text.includes(chinese)) {
        return { action: 'query_city', city: english, cityName: chinese };
      }
    }
  }
  
  // 訂閱城市
  if (text.includes('訂閱')) {
    for (const [chinese, english] of Object.entries(cityMap)) {
      if (text.includes(chinese)) {
        return { action: 'subscribe_city', city: english, cityName: chinese };
      }
    }
  }
  
  // 單獨城市名稱
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text === chinese || normalizedText === english) {
      return { action: 'query_city', city: english, cityName: chinese };
    }
  }
  
  return null;
}

// 處理有狀態的對話
async function handleStatefulMessage(event, userState) {
  const userId = event.source.userId;
  const userMessage = event.message.text.trim();
  
  try {
    // 處理等待輸入城市名稱的狀態
    if (userState.state === 'awaiting_city_for_subscription') {
      clearUserState(userId);
      
      for (const [chinese, english] of Object.entries(cityMap)) {
        if (userMessage.includes(chinese)) {
          const success = addSubscription(userId, english);
          const message = success
            ? `✅ 已成功訂閱 ${chinese} 的空氣品質提醒！`
            : `您已經訂閱了 ${chinese} 的空氣品質提醒。`;
          return client.replyMessage(event.replyToken, 
            createSimpleResponse(message, ['訂閱管理', '主選單'])
          );
        }
      }
      
      return client.replyMessage(event.replyToken,
        createSimpleResponse('找不到該城市，請重新輸入城市名稱。', ['台北', '高雄', '主選單'])
      );
    }
    
    // 處理比較城市
    if (userState.state === 'awaiting_cities_for_comparison') {
      clearUserState(userId);
      
      const cities = [];
      for (const [chinese, english] of Object.entries(cityMap)) {
        if (userMessage.includes(chinese)) {
          cities.push({ chinese, english });
        }
      }
      
      if (cities.length < 2) {
        return client.replyMessage(event.replyToken,
          createSimpleResponse('請輸入至少兩個城市名稱進行比較。', ['台北 高雄', '主選單'])
        );
      }
      
      // 這裡應該實作城市比較功能
      const cityNames = cities.map(c => c.chinese).join('、');
      return client.replyMessage(event.replyToken,
        createSimpleResponse(`正在比較 ${cityNames} 的空氣品質...`, ['主選單'])
      );
    }
    
  } catch (error) {
    console.error('Stateful message error:', error);
    clearUserState(userId);
    return client.replyMessage(event.replyToken,
      createSimpleResponse('處理時發生錯誤，請重試。', ['主選單'])
    );
  }
}

// 主要事件處理器
async function handleEvent(event) {
  if (event.type !== 'message' || !event.message) {
    return null;
  }
  
  const userId = event.source.userId;
  
  // 處理位置訊息
  if (event.message.type === 'location') {
    return client.replyMessage(event.replyToken,
      createSimpleResponse('📍 收到您的位置！目前位置查詢功能開發中，請先使用城市名稱查詢。', ['查詢空氣品質', '主選單'])
    );
  }
  
  // 只處理文字訊息
  if (event.message.type !== 'text') {
    return null;
  }
  
  const userMessage = event.message.text.trim();
  
  // 檢查是否有等待中的狀態
  const userState = getUserState(userId);
  if (userState) {
    return handleStatefulMessage(event, userState);
  }
  
  // 解析使用者輸入
  const parsed = parseUserInput(userMessage);
  
  if (!parsed) {
    return client.replyMessage(event.replyToken,
      createSimpleResponse(
        `我不太理解「${userMessage}」的意思。\n\n您可以：\n• 直接輸入城市名稱（如：台北）\n• 點選下方選單功能`,
        ['主選單', '查詢空氣品質', '使用說明']
      )
    );
  }
  
  // 根據解析結果執行動作
  try {
    switch (parsed.action) {
      case 'main_menu':
        return client.replyMessage(event.replyToken, createMainMenuFlexMessage());
        
      case 'city_selection':
        return client.replyMessage(event.replyToken, createCitySelectionFlexMessage());
        
      case 'subscription_management':
        return client.replyMessage(event.replyToken, createSubscriptionManagementFlexMessage(userId));
        
      case 'help':
        return client.replyMessage(event.replyToken,
          createSimpleResponse(
            '📖 使用說明\n\n' +
            '1️⃣ 查詢空氣品質：直接輸入城市名稱或點選「查詢空氣品質」\n' +
            '2️⃣ 訂閱提醒：在查詢結果中點選「訂閱此城市」\n' +
            '3️⃣ 管理訂閱：點選「訂閱管理」查看已訂閱城市\n' +
            '4️⃣ 城市比較：可同時比較多個城市的空氣品質\n\n' +
            '💡 小技巧：直接輸入城市名稱最快速！',
            ['台北', '查詢空氣品質', '主選單']
          )
        );
        
      case 'add_subscription':
        setUserState(userId, 'awaiting_city_for_subscription');
        return client.replyMessage(event.replyToken,
          createSimpleResponse('請輸入要訂閱的城市名稱：', ['台北', '高雄', '取消'])
        );
        
      case 'remove_subscription': {
        const userSub = getUserSubscriptions(userId);
        if (userSub.cities.length === 0) {
          return client.replyMessage(event.replyToken,
            createSimpleResponse('您還沒有訂閱任何城市。', ['新增訂閱', '主選單'])
          );
        }
        // 這裡應該顯示已訂閱城市列表供選擇
        return client.replyMessage(event.replyToken,
          createSimpleResponse('取消訂閱功能開發中...', ['主選單'])
        );
      }
        
      case 'compare_cities':
        setUserState(userId, 'awaiting_cities_for_comparison');
        return client.replyMessage(event.replyToken,
          createSimpleResponse('請輸入要比較的城市（至少兩個），用空格分隔：', ['台北 高雄', '取消'])
        );
        
      case 'query_city': {
        const data = await getAirQuality(parsed.city);
        return client.replyMessage(event.replyToken, createAirQualityFlexMessage(data));
      }
        
      case 'subscribe_city': {
        const success = addSubscription(userId, parsed.city);
        const message = success
          ? `✅ 已成功訂閱 ${parsed.cityName} 的空氣品質提醒！`
          : `您已經訂閱了 ${parsed.cityName} 的空氣品質提醒。`;
        return client.replyMessage(event.replyToken,
          createSimpleResponse(message, ['訂閱管理', '主選單'])
        );
      }
        
      case 'cancel':
        clearUserState(userId);
        return client.replyMessage(event.replyToken,
          createSimpleResponse('已取消操作。', ['主選單'])
        );
        
      default:
        return client.replyMessage(event.replyToken,
          createSimpleResponse('請選擇功能或輸入城市名稱。', ['主選單', '查詢空氣品質'])
        );
    }
  } catch (error) {
    console.error('Error:', error);
    return client.replyMessage(event.replyToken,
      createSimpleResponse('查詢時發生錯誤，請稍後再試。', ['主選單'])
    );
  }
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

// 健康檢查
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

// 每日報告定時任務 (早上8點)
cron.schedule('0 8 * * *', async () => {
  console.log('📅 Running daily report task...');
  
  for (const [userId, userSub] of subscriptions) {
    if (!userSub.settings.dailyReport) continue;
    
    try {
      const reports = [];
      for (const city of userSub.cities) {
        const data = await getAirQuality(city);
        const chineseName = Object.keys(cityMap).find(key => cityMap[key] === city);
        reports.push(`${chineseName}: AQI ${data.aqi}`);
      }
      
      if (reports.length > 0) {
        const message = `🌅 早安！今日空氣品質報告：\n\n${reports.join('\n')}`;
        await client.pushMessage(userId, createSimpleResponse(message, ['查看詳情', '主選單']));
      }
    } catch (error) {
      console.error(`Daily report error for ${userId}:`, error);
    }
  }
});

// 匯出模組
module.exports = {
  app,
  handleEvent,
  getAirQuality,
  parseUserInput
};