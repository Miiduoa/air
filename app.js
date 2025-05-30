const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

// LINE Bot 設定
const config = {
  channelAccessToken: 'YOUR_CHANNEL_ACCESS_TOKEN', // 請替換為你的 Channel Access Token
  channelSecret: 'YOUR_CHANNEL_SECRET' // 請替換為你的 Channel Secret
};

const client = new line.Client(config);

// API Keys
const WEATHER_API_KEY = 'YOUR_OPENWEATHERMAP_API_KEY'; // OpenWeatherMap API Key
const AIR_QUALITY_API_KEY = 'YOUR_AQICN_API_KEY'; // AQI API Key

// 主選單模板
const mainMenuTemplate = {
  type: 'template',
  altText: '主選單',
  template: {
    type: 'carousel',
    columns: [
      {
        thumbnailImageUrl: 'https://via.placeholder.com/1024x1024/87CEEB/FFFFFF?text=天氣',
        title: '天氣查詢',
        text: '查詢即時天氣資訊',
        actions: [
          {
            type: 'message',
            label: '查詢天氣',
            text: '天氣查詢'
          }
        ]
      },
      {
        thumbnailImageUrl: 'https://via.placeholder.com/1024x1024/90EE90/FFFFFF?text=空氣',
        title: '空氣品質',
        text: '查詢空氣品質指數',
        actions: [
          {
            type: 'message',
            label: '查詢空氣品質',
            text: '空氣品質查詢'
          }
        ]
      }
    ]
  }
};

// 城市選擇模板
const citySelectionTemplate = (type) => ({
  type: 'template',
  altText: `選擇城市 - ${type}`,
  template: {
    type: 'carousel',
    columns: [
      {
        thumbnailImageUrl: 'https://via.placeholder.com/1024x1024/FFB6C1/FFFFFF?text=台北',
        title: '台北市',
        text: `查詢台北市${type}`,
        actions: [
          {
            type: 'message',
            label: `台北${type}`,
            text: `${type === '天氣' ? 'weather' : 'air'}_taipei`
          }
        ]
      },
      {
        thumbnailImageUrl: 'https://via.placeholder.com/1024x1024/DDA0DD/FFFFFF?text=台中',
        title: '台中市',
        text: `查詢台中市${type}`,
        actions: [
          {
            type: 'message',
            label: `台中${type}`,
            text: `${type === '天氣' ? 'weather' : 'air'}_taichung`
          }
        ]
      },
      {
        thumbnailImageUrl: 'https://via.placeholder.com/1024x1024/F0E68C/FFFFFF?text=高雄',
        title: '高雄市',
        text: `查詢高雄市${type}`,
        actions: [
          {
            type: 'message',
            label: `高雄${type}`,
            text: `${type === '天氣' ? 'weather' : 'air'}_kaohsiung`
          }
        ]
      }
    ]
  }
});

// 天氣資訊模板
const weatherTemplate = (weatherData, city) => {
  const temp = Math.round(weatherData.main.temp);
  const feelsLike = Math.round(weatherData.main.feels_like);
  const humidity = weatherData.main.humidity;
  const description = weatherData.weather[0].description;
  const icon = weatherData.weather[0].icon;
  
  return {
    type: 'flex',
    altText: `${city}天氣資訊`,
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: `https://openweathermap.org/img/wn/${icon}@2x.png`,
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
            text: `${city} 天氣`,
            weight: 'bold',
            size: 'xl',
            color: '#1DB446'
          },
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
                    text: '溫度',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: `${temp}°C`,
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
                    text: '體感溫度',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: `${feelsLike}°C`,
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
                    text: '濕度',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: `${humidity}%`,
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
                    text: '天氣狀況',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: description,
                    wrap: true,
                    color: '#666666',
                    size: 'sm',
                    flex: 5
                  }
                ]
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
            type: 'button',
            style: 'primary',
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
};

// 空氣品質模板
const airQualityTemplate = (airData, city) => {
  const aqi = airData.data.aqi;
  const dominant = airData.data.dominentpol;
  
  let status, color;
  if (aqi <= 50) {
    status = '良好';
    color = '#00E400';
  } else if (aqi <= 100) {
    status = '普通';
    color = '#FFFF00';
  } else if (aqi <= 150) {
    status = '對敏感族群不健康';
    color = '#FF7E00';
  } else if (aqi <= 200) {
    status = '對所有族群不健康';
    color = '#FF0000';
  } else if (aqi <= 300) {
    status = '非常不健康';
    color = '#8F3F97';
  } else {
    status = '危險';
    color = '#7E0023';
  }

  return {
    type: 'flex',
    altText: `${city}空氣品質`,
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: aqi.toString(),
            align: 'center',
            size: '4xl',
            weight: 'bold',
            color: '#FFFFFF'
          },
          {
            type: 'text',
            text: 'AQI',
            align: 'center',
            size: 'md',
            color: '#FFFFFF'
          }
        ],
        paddingAll: 'lg',
        backgroundColor: color
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `${city} 空氣品質`,
            weight: 'bold',
            size: 'xl',
            color: '#1DB446'
          },
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
                    text: 'AQI指數',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: aqi.toString(),
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
                    text: '空氣品質',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: status,
                    wrap: true,
                    color: color,
                    size: 'sm',
                    flex: 5,
                    weight: 'bold'
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
                    text: '主要污染物',
                    color: '#aaaaaa',
                    size: 'sm',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: dominant || '無',
                    wrap: true,
                    color: '#666666',
                    size: 'sm',
                    flex: 5
                  }
                ]
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
            type: 'button',
            style: 'primary',
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
};

// 取得天氣資料
async function getWeatherData(city) {
  const cityMap = {
    'taipei': 'Taipei,TW',
    'taichung': 'Taichung,TW',
    'kaohsiung': 'Kaohsiung,TW'
  };
  
  try {
    const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${cityMap[city]}&appid=${WEATHER_API_KEY}&units=metric&lang=zh_tw`);
    return response.data;
  } catch (error) {
    console.error('Weather API Error:', error);
    return null;
  }
}

// 取得空氣品質資料
async function getAirQualityData(city) {
  const cityMap = {
    'taipei': 'taipei',
    'taichung': 'taichung',
    'kaohsiung': 'kaohsiung'
  };
  
  try {
    const response = await axios.get(`https://api.waqi.info/feed/${cityMap[city]}/?token=${AIR_QUALITY_API_KEY}`);
    return response.data;
  } catch (error) {
    console.error('Air Quality API Error:', error);
    return null;
  }
}

// 處理訊息事件
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  let replyMessage;

  try {
    switch (userMessage) {
      case '主選單':
      case '選單':
      case '開始':
        replyMessage = mainMenuTemplate;
        break;

      case '天氣查詢':
        replyMessage = citySelectionTemplate('天氣');
        break;

      case '空氣品質查詢':
        replyMessage = citySelectionTemplate('空氣品質');
        break;

      case 'weather_taipei':
        const taipeiWeather = await getWeatherData('taipei');
        if (taipeiWeather) {
          replyMessage = weatherTemplate(taipeiWeather, '台北市');
        } else {
          replyMessage = { type: 'text', text: '抱歉，無法取得台北天氣資訊' };
        }
        break;

      case 'weather_taichung':
        const taichungWeather = await getWeatherData('taichung');
        if (taichungWeather) {
          replyMessage = weatherTemplate(taichungWeather, '台中市');
        } else {
          replyMessage = { type: 'text', text: '抱歉，無法取得台中天氣資訊' };
        }
        break;

      case 'weather_kaohsiung':
        const kaohsiungWeather = await getWeatherData('kaohsiung');
        if (kaohsiungWeather) {
          replyMessage = weatherTemplate(kaohsiungWeather, '高雄市');
        } else {
          replyMessage = { type: 'text', text: '抱歉，無法取得高雄天氣資訊' };
        }
        break;

      case 'air_taipei':
        const taipeiAir = await getAirQualityData('taipei');
        if (taipeiAir && taipeiAir.status === 'ok') {
          replyMessage = airQualityTemplate(taipeiAir, '台北市');
        } else {
          replyMessage = { type: 'text', text: '抱歉，無法取得台北空氣品質資訊' };
        }
        break;

      case 'air_taichung':
        const taichungAir = await getAirQualityData('taichung');
        if (taichungAir && taichungAir.status === 'ok') {
          replyMessage = airQualityTemplate(taichungAir, '台中市');
        } else {
          replyMessage = { type: 'text', text: '抱歉，無法取得台中空氣品質資訊' };
        }
        break;

      case 'air_kaohsiung':
        const kaohsiungAir = await getAirQualityData('kaohsiung');
        if (kaohsiungAir && kaohsiungAir.status === 'ok') {
          replyMessage = airQualityTemplate(kaohsiungAir, '高雄市');
        } else {
          replyMessage = { type: 'text', text: '抱歉，無法取得高雄空氣品質資訊' };
        }
        break;

      default:
        replyMessage = {
          type: 'flex',
          altText: '歡迎使用天氣空氣品質機器人',
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: '🤖 天氣空氣品質機器人',
                  weight: 'bold',
                  size: 'xl',
                  color: '#1DB446'
                },
                {
                  type: 'text',
                  text: '歡迎使用！我可以幫您查詢：',
                  margin: 'md'
                },
                {
                  type: 'text',
                  text: '• 即時天氣資訊\n• 空氣品質指數',
                  margin: 'md'
                },
                {
                  type: 'text',
                  text: '請點選下方按鈕開始使用',
                  margin: 'md',
                  color: '#666666'
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
                    label: '開始使用',
                    text: '主選單'
                  }
                }
              ]
            }
          }
        };
    }

    return client.replyMessage(event.replyToken, replyMessage);
  } catch (error) {
    console.error('Error handling event:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '抱歉，發生錯誤，請稍後再試'
    });
  }
}

// 設定 webhook
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE Bot 已啟動，監聽 port ${port}`);
});

// Rich Menu 設定（需要單獨設定）
const richMenuObject = {
  size: {
    width: 2500,
    height: 1686
  },
  selected: false,
  name: "天氣空氣品質選單",
  chatBarText: "選單",
  areas: [
    {
      bounds: {
        x: 0,
        y: 0,
        width: 1250,
        height: 843
      },
      action: {
        type: "message",
        text: "天氣查詢"
      }
    },
    {
      bounds: {
        x: 1250,
        y: 0,
        width: 1250,
        height: 843
      },
      action: {
        type: "message",
        text: "空氣品質查詢"
      }
    },
    {
      bounds: {
        x: 0,
        y: 843,
        width: 2500,
        height: 843
      },
      action: {
        type: "message",
        text: "主選單"
      }
    }
  ]
};