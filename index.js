const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

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

// 城市名稱對照表（中英文）
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

// AQI等級判斷
function getAQILevel(aqi) {
  if (aqi <= 50) return { level: '良好', color: '#00e400', emoji: '😊' };
  if (aqi <= 100) return { level: '普通', color: '#ffff00', emoji: '😐' };
  if (aqi <= 150) return { level: '對敏感族群不健康', color: '#ff7e00', emoji: '😷' };
  if (aqi <= 200) return { level: '不健康', color: '#ff0000', emoji: '😰' };
  if (aqi <= 300) return { level: '非常不健康', color: '#8f3f97', emoji: '🤢' };
  return { level: '危險', color: '#7e0023', emoji: '☠️' };
}

// 解析自然語言查詢
function parseQuery(text) {
  const cleanText = text.toLowerCase().replace(/[空氣品質|空氣|空品|pm2.5|aqi|查詢|怎麼樣|如何]/g, '');
  
  // 檢查是否包含城市名稱
  for (const [chinese, english] of Object.entries(cityMap)) {
    if (text.includes(chinese) || cleanText.includes(english)) {
      return english;
    }
  }
  
  // 如果沒有找到特定城市，返回null
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

// 創建Flex Message
function createAirQualityFlexMessage(data) {
  const aqiInfo = getAQILevel(data.aqi);
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
                text: '詳細數據',
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
    text: '請選擇要查詢的城市，或直接輸入城市名稱：',
    quickReply: {
      items: popularCities.map(city => ({
        type: 'action',
        action: {
          type: 'message',
          label: city,
          text: `查詢${city}空氣品質`
        }
      }))
    }
  };
}

// 處理LINE訊息
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  
  try {
    // 檢查是否為問候語或幫助指令
    if (userMessage.match(/^(你好|哈囉|hello|hi|幫助|help|使用說明)/i)) {
      const helpMessage = {
        type: 'text',
        text: '🌟 歡迎使用空氣品質查詢機器人！\n\n' +
              '📋 使用方式：\n' +
              '• 直接輸入城市名稱\n' +
              '• 例如：「台北空氣品質」\n' +
              '• 例如：「查詢高雄PM2.5」\n' +
              '• 例如：「台中空氣如何」\n\n' +
              '🌍 支援台灣各縣市及國際主要城市\n' +
              '📊 提供即時AQI指數及詳細污染物數據'
      };
      
      return client.replyMessage(event.replyToken, [helpMessage, createCityQuickReply()]);
    }

    // 解析查詢的城市
    const city = parseQuery(userMessage);
    
    if (!city) {
      const notFoundMessage = {
        type: 'text',
        text: '🤔 抱歉，我無法識別您要查詢的城市。\n請嘗試輸入完整的城市名稱。'
      };
      
      return client.replyMessage(event.replyToken, [notFoundMessage, createCityQuickReply()]);
    }

    // 獲取空氣品質數據
    const airQualityData = await getAirQuality(city);
    const flexMessage = createAirQualityFlexMessage(airQualityData);
    
    return client.replyMessage(event.replyToken, flexMessage);
    
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

// 健康檢查端點
app.get('/', (req, res) => {
  res.send('LINE空氣品質機器人正常運行中！');
});

// 啟動服務器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE空氣品質機器人在端口 ${port} 上運行`);
});