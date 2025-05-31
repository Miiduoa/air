const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

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

function getUserSubscriptions(userId) {
  return subscriptions.get(userId) || { cities: [], settings: {} };
}

// 創建附近監測站Flex Message
function createNearbyStationsFlexMessage(stations, userLat, userLng) {
  if (stations.length === 0) {
    return {
      type: 'text',
      text: '😔 抱歉，找不到您附近的空氣品質監測站。\n請嘗試查詢特定城市的空氣品質。'
    };
  }

  const flexMessage = {
    type: 'flex',
    altText: `附近監測站 - 找到 ${stations.length} 個站點`,
    contents: {
      type: 'bubble',
      styles: {
        header: {
          backgroundColor: '#4CAF50'
        }
      },
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
          }
        ]
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
        margin: index > 0 ? 'md' : 'none',
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
                text: `距離: ${distanceText}`,
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
            const alertMessage = createEmergencyAlertMessage(airQualityData);
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
    return { type: 'unsubscribe', content: text };
  }
  
  // 檢查是否為查看訂閱
  if (text.includes('我的訂閱') || text.includes('訂閱清單')) {
    return { type: 'list_subscriptions' };
  }
  
  // 檢查是否為比較查詢
  if (text.includes('比較') || text.includes('vs') || text.includes('對比')) {
    return parseCompareQuery(text);
  }
  
  // 檢查是否包含城市名稱
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese) || cleanText.includes(english)) {
      return { type: 'single', city: english };
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
            size: 'lg'
          }
        ],
        paddingAll: '20px',
        backgroundColor: '#4CAF50',
        spacing: 'md',
        height: '60px'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: citiesData.map(city => {
          const aqiInfo = getAQILevel(city.aqi);
          return {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: city.chineseName,
                weight: 'bold',
                size: 'sm',
                color: '#333333'
              },
              {
                type: 'text',
                text: `AQI ${city.aqi}`,
                weight: 'bold',
                size: 'sm',
                color: aqiInfo.color,
                align: 'end'
              }
            ],
            margin: 'md'
          };
        })
      }
    }
  };
}

// 創建緊急警報訊息
function createEmergencyAlertMessage(airQualityData) {
  const aqiInfo = getAQILevel(airQualityData.aqi);
  
  return {
    type: 'text',
    text: `🚨 空氣品質警報！\n\n` +
          `📍 ${airQualityData.city.name}\n` +
          `💨 AQI: ${airQualityData.aqi} (${aqiInfo.level})\n\n` +
          `⚠️ 建議立即採取防護措施：\n` +
          `• 避免戶外活動\n` +
          `• 配戴N95口罩\n` +
          `• 關閉門窗\n` +
          `• 使用空氣清淨機`
  };
}

// 創建Flex Message
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
      styles: {
        header: {
          backgroundColor: aqiInfo.color
        }
      },
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
        ]
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
                    text: '城市',
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
                    text: 'AQI',
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
                    text: '等級',
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

  // 添加更新時間
  flexMessage.contents.footer = {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      {
        type: 'separator'
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
  };

  return flexMessage;
}

// 創建城市選擇快速回覆
function createCityQuickReply() {
  const popularCities = ['台北', '台中', '台南', '高雄', '新北', '桃園'];
  
  return {
    type: 'text',
    text: '請選擇要查詢的城市，或直接輸入城市名稱：\n\n💡 功能提示：\n• 查詢：「台北空氣品質」\n• 比較：「比較台北高雄」\n• 訂閱：「訂閱台北」\n• 定位：直接分享位置',
    quickReply: {
      items: [
        ...popularCities.map(city => ({
          type: 'action',
          action: {
            type: 'message',
            label: city,
            text: `查詢${city}空氣品質`
          }
        })),
        {
          type: 'action',
          action: {
            type: 'message',
            label: '比較城市',
            text: '比較台北台中高雄'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '我的訂閱',
            text: '我的訂閱清單'
          }
        },
        {
          type: 'action',
          action: {
            type: 'location',
            label: '分享位置'
          }
        }
      ]
    }
  };
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
      styles: {
        header: {
          backgroundColor: '#4CAF50'
        }
      },
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
          }
        ]
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

  // 添加更新時間
  const updateTime = new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  flexMessage.contents.footer = {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      {
        type: 'separator'
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
  };

  return flexMessage;
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
      const errorMessage = {
        type: 'text',
        text: '😵 查詢附近空氣品質時發生錯誤，請稍後再試。'
      };
      return client.replyMessage(event.replyToken, errorMessage);
    }
  }

  // 處理文字訊息
  if (event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  
  try {
    // 檢查是否為問候語或幫助指令
    if (userMessage.match(/^(你好|哈囉|hello|hi|幫助|help|使用說明)/i)) {
      const helpMessage = {
        type: 'text',
        text: '🌟 歡迎使用智慧空氣品質機器人！\n\n' +
              '📋 查詢功能：\n' +
              '• 單城市：「台北空氣品質」\n' +
              '• 多城市比較：「比較台北高雄台中」\n' +
              '• 附近查詢：直接分享位置\n\n' +
              '🔔 訂閱功能：\n' +
              '• 訂閱城市：「訂閱台北」\n' +
              '• 查看訂閱：「我的訂閱」\n' +
              '• 取消訂閱：「取消訂閱台北」\n\n' +
              '✨ 智慧功能：\n' +
              '• 📊 專業健康建議\n' +
              '• 🌅 每日定時報告\n' +
              '• 🚨 空氣品質警報\n' +
              '• 📍 GPS定位查詢\n\n' +
              '🌍 支援台灣各縣市及國際主要城市'
      };
      
      return client.replyMessage(event.replyToken, [helpMessage, createCityQuickReply()]);
    }

    // 解析查詢的內容
    const queryResult = parseQuery(userMessage);
    
    // 處理訂閱功能
    if (queryResult && queryResult.type === 'subscribe') {
      if (queryResult.city) {
        const success = addSubscription(userId, queryResult.city);
        const message = success ? 
          `✅ 已成功訂閱 ${queryResult.cityName} 的空氣品質提醒！\n\n📅 每日 08:00 推送空氣品質報告\n🚨 AQI>100 時發送緊急警報\n\n輸入「我的訂閱」查看所有訂閱\n輸入「取消訂閱${queryResult.cityName}」可取消` :
          `📋 您已經訂閱了 ${queryResult.cityName} 的空氣品質提醒`;
          
        return client.replyMessage(event.replyToken, { type: 'text', text: message });
      } else {
        const subscribeHelp = {
          type: 'text',
          text: '🔔 訂閱空氣品質提醒\n\n使用方式：\n• 「訂閱台北」\n• 「訂閱高雄」\n• 「訂閱新加坡」\n\n訂閱後每日會推送空氣品質報告，並在空氣品質惡化時發送警報。'
        };
        return client.replyMessage(event.replyToken, [subscribeHelp, createCityQuickReply()]);
      }
    }

    // 處理取消訂閱
    if (queryResult && queryResult.type === 'unsubscribe') {
      // 檢查是否指定了城市
      let cityToUnsubscribe = null;
      let cityNameToUnsubscribe = null;
      
      for (const [chinese, english] of Object.entries(cityMap)) {
        if (userMessage.includes(chinese)) {
          cityToUnsubscribe = english;
          cityNameToUnsubscribe = chinese;
          break;
        }
      }
      
      if (cityToUnsubscribe) {
        const success = removeSubscription(userId, cityToUnsubscribe);
        const message = success ?
          `✅ 已取消訂閱 ${cityNameToUnsubscribe} 的空氣品質提醒` :
          `❌ 您沒有訂閱 ${cityNameToUnsubscribe} 的提醒`;
        return client.replyMessage(event.replyToken, { type: 'text', text: message });
      } else {
        // 取消所有訂閱
        const userSub = getUserSubscriptions(userId);
        if (userSub.cities.length > 0) {
          subscriptions.delete(userId);
          return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: '✅ 已取消所有空氣品質提醒訂閱' 
          });
        } else {
          return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: '❌ 您目前沒有任何訂閱' 
          });
        }
      }
    }

    // 處理查看訂閱清單
    if (queryResult && queryResult.type === 'list_subscriptions') {
      const userSub = getUserSubscriptions(userId);
      if (userSub.cities.length === 0) {
        const noSubMessage = {
          type: 'text',
          text: '📋 您目前沒有訂閱任何城市\n\n💡 使用「訂閱台北」開始訂閱空氣品質提醒\n\n訂閱後可享受：\n• 🌅 每日空氣品質報告\n• 🚨 空氣品質惡化警報\n• 📊 個人化健康建議'
        };
        return client.replyMessage(event.replyToken, [noSubMessage, createCityQuickReply()]);
      }
      
      const cityNames = userSub.cities.map(city => {
        const chinese = Object.keys(cityMap).find(key => cityMap[key] === city);
        return chinese || city;
      });
      
      const subListMessage = {
        type: 'text',
        text: `📋 您的訂閱清單：\n\n${cityNames.map((city, index) => `${index + 1}. ${city}`).join('\n')}\n\n⚙️ 設定：\n• 📅 每日報告：已開啟\n• 🚨 緊急警報：已開啟\n• ⚠️ 警報閾值：AQI > 100\n\n💡 輸入「取消訂閱[城市名]」可取消特定城市`
      };
      return client.replyMessage(event.replyToken, subListMessage);
    }

    if (!queryResult) {
      const notFoundMessage = {
        type: 'text',
        text: '🤔 抱歉，我無法識別您要查詢的內容。\n\n請嘗試：\n• 查詢：「台北空氣品質」\n• 比較：「比較台北高雄」\n• 訂閱：「訂閱台北」\n• 定位：分享您的位置'
      };
      
      return client.replyMessage(event.replyToken, [notFoundMessage, createCityQuickReply()]);
    }

    // 處理多城市比較
    if (queryResult.type === 'compare') {
      const citiesData = await getMultipleCitiesAirQuality(queryResult.cities);
      
      if (citiesData.length === 0) {
        const errorMessage = {
          type: 'text',
          text: '😵 抱歉，無法獲取這些城市的空氣品質數據。\n請稍後再試，或嘗試其他城市。'
        };
        return client.replyMessage(event.replyToken, [errorMessage, createCityQuickReply()]);
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
    if (queryResult.type === 'single') {
      const airQualityData = await getAirQuality(queryResult.city);
      const flexMessage = createAirQualityFlexMessage(airQualityData);
      
      return client.replyMessage(event.replyToken, flexMessage);
    }
    
  } catch (error) {
    console.error('處理訊息錯誤:', error);
    
    const errorMessage = {
      type: 'text',
      text: '😵 抱歉，查詢空氣品質時發生錯誤。\n請稍後再試，或嘗試查詢其他城市。'
    };
    
    return client.replyMessage(event.replyToken, [errorMessage, createCityQuickReply()]);
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

// 介紹網頁端點
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'LINE空氣品質機器人正常運行中！',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    features: [
      '即時空氣品質查詢',
      '多城市比較',
      '智慧健康建議',
      '訂閱提醒系統',
      'GPS定位查詢'
    ]
  });
});

// API端點 - 獲取城市空氣品質
app.get('/api/air-quality/:city', async (req, res) => {
  try {
    const city = req.params.city;
    const airQualityData = await getAirQuality(city);
    res.json(airQualityData);
  } catch (error) {
    res.status(500).json({ error: '無法獲取空氣品質數據' });
  }
});

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE智慧空氣品質機器人在端口 ${port} 上運行`);
  console.log('功能列表：');
  console.log('✅ 即時空氣品質查詢');
  console.log('✅ 多城市比較功能');
  console.log('✅ 智慧健康建議系統');
  console.log('✅ 訂閱提醒系統');
  console.log('✅ GPS定位查詢');
  console.log('✅ 精美介紹網頁');
});