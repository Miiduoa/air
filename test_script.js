/**
 * LINE 智慧空氣品質機器人 - 測試腳本
 * 用於測試部署後的服務是否正常運行
 */

const axios = require('axios');

// 設定你的服務URL
const BASE_URL = process.env.TEST_URL || 'https://your-app.onrender.com';

// 顏色輸出工具
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 測試結果統計
let testResults = {
  total: 0,
  passed: 0,
  failed: 0
};

// 測試工具函數
async function test(name, testFunction) {
  testResults.total++;
  
  try {
    log('cyan', `\n🧪 測試: ${name}`);
    await testFunction();
    testResults.passed++;
    log('green', `✅ 通過: ${name}`);
  } catch (error) {
    testResults.failed++;
    log('red', `❌ 失敗: ${name}`);
    log('red', `   錯誤: ${error.message}`);
  }
}

// 延遲函數
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. 測試健康檢查
async function testHealth() {
  const response = await axios.get(`${BASE_URL}/health`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  if (response.data.status !== 'OK') {
    throw new Error(`服務狀態異常: ${response.data.status}`);
  }
  
  log('blue', `   服務狀態: ${response.data.status}`);
  log('blue', `   運行時間: ${response.data.uptime || '未知'}`);
}

// 2. 測試介紹網頁
async function testHomePage() {
  const response = await axios.get(BASE_URL);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  if (!response.data.includes('智慧空氣品質機器人')) {
    throw new Error('網頁內容不正確');
  }
  
  log('blue', '   介紹網頁載入正常');
}

// 3. 測試空氣品質API - 台北
async function testAirQualityTaipei() {
  const response = await axios.get(`${BASE_URL}/api/air-quality/taipei`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  const data = response.data;
  
  if (!data.aqi || typeof data.aqi !== 'number') {
    throw new Error('AQI數據格式錯誤');
  }
  
  if (!data.city || !data.city.name) {
    throw new Error('城市資訊缺失');
  }
  
  log('blue', `   台北 AQI: ${data.aqi}`);
  log('blue', `   城市名稱: ${data.city.name}`);
  log('blue', `   主要污染物: ${data.dominentpol || '未知'}`);
}

// 4. 測試空氣品質API - 高雄
async function testAirQualityKaohsiung() {
  const response = await axios.get(`${BASE_URL}/api/air-quality/kaohsiung`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  const data = response.data;
  
  if (!data.aqi || typeof data.aqi !== 'number') {
    throw new Error('AQI數據格式錯誤');
  }
  
  log('blue', `   高雄 AQI: ${data.aqi}`);
  log('blue', `   更新時間: ${data.time?.s || '未知'}`);
}

// 5. 測試不存在的城市
async function testNonExistentCity() {
  try {
    await axios.get(`${BASE_URL}/api/air-quality/nonexistentcity`);
    throw new Error('應該返回錯誤，但沒有');
  } catch (error) {
    if (error.response && error.response.status === 500) {
      log('blue', '   正確處理不存在的城市查詢');
      return;
    }
    throw error;
  }
}

// 6. 測試服務統計API
async function testStats() {
  try {
    const response = await axios.get(`${BASE_URL}/api/stats`);
    
    if (response.status === 200) {
      const data = response.data;
      log('blue', `   服務名稱: ${data.service?.name || '未知'}`);
      log('blue', `   支援城市: ${data.statistics?.supportedCities || '未知'}`);
    }
  } catch (error) {
    // Stats API可能還沒實現，不算錯誤
    log('yellow', '   統計API尚未實現（可選功能）');
  }
}

// 7. 測試回應時間
async function testResponseTime() {
  const startTime = Date.now();
  await axios.get(`${BASE_URL}/api/air-quality/taipei`);
  const responseTime = Date.now() - startTime;
  
  if (responseTime > 5000) {
    throw new Error(`回應時間過長: ${responseTime}ms`);
  }
  
  log('blue', `   回應時間: ${responseTime}ms`);
  
  if (responseTime < 2000) {
    log('green', '   ⚡ 回應速度優秀！');
  } else if (responseTime < 3000) {
    log('yellow', '   ⏱️ 回應速度良好');
  } else {
    log('yellow', '   🐌 回應速度較慢，可考慮優化');
  }
}

// 8. 測試多個連續請求（壓力測試）
async function testMultipleRequests() {
  const cities = ['taipei', 'kaohsiung', 'taichung'];
  const promises = cities.map(city => 
    axios.get(`${BASE_URL}/api/air-quality/${city}`)
  );
  
  const startTime = Date.now();
  const responses = await Promise.all(promises);
  const totalTime = Date.now() - startTime;
  
  if (responses.some(res => res.status !== 200)) {
    throw new Error('部分請求失敗');
  }
  
  log('blue', `   並發查詢 ${cities.length} 個城市`);
  log('blue', `   總耗時: ${totalTime}ms`);
  log('blue', `   平均耗時: ${Math.round(totalTime / cities.length)}ms`);
}

// 主測試函數
async function runTests() {
  log('bright', '🚀 開始測試 LINE 智慧空氣品質機器人服務');
  log('bright', `📡 測試目標: ${BASE_URL}`);
  log('bright', '=' .repeat(60));
  
  // 基礎服務測試
  await test('健康檢查', testHealth);
  await test('介紹網頁', testHomePage);
  
  // API功能測試
  await test('台北空氣品質查詢', testAirQualityTaipei);
  await test('高雄空氣品質查詢', testAirQualityKaohsiung);
  await test('錯誤處理機制', testNonExistentCity);
  
  // 性能測試
  await test('回應時間測試', testResponseTime);
  await test('並發請求測試', testMultipleRequests);
  
  // 可選功能測試
  await test('服務統計查詢', testStats);
  
  // 測試結果摘要
  log('bright', '\n' + '=' .repeat(60));
  log('bright', '📊 測試結果摘要');
  log('bright', '=' .repeat(60));
  
  log('cyan', `總測試數: ${testResults.total}`);
  log('green', `通過: ${testResults.passed}`);
  log('red', `失敗: ${testResults.failed}`);
  
  const successRate = Math.round((testResults.passed / testResults.total) * 100);
  log('bright', `成功率: ${successRate}%`);
  
  if (testResults.failed === 0) {
    log('green', '\n🎉 所有測試通過！你的服務運行完美！');
    log('green', '✅ 可以開始使用 LINE 機器人了');
  } else if (successRate >= 80) {
    log('yellow', '\n⚠️ 大部分測試通過，但有一些問題需要修復');
    log('yellow', '💡 請檢查失敗的測試項目');
  } else {
    log('red', '\n❌ 多個測試失敗，服務可能有嚴重問題');
    log('red', '🔧 請檢查部署配置和環境變數');
  }
  
  // 提供後續步驟建議
  log('bright', '\n📋 後續步驟:');
  log('cyan', '1. 在 LINE Developers Console 設定 Webhook URL');
  log('cyan', '2. 測試 LINE Bot 功能');
  log('cyan', '3. 設定定時任務監控');
  log('cyan', '4. 準備正式發布');
  
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// 錯誤處理
process.on('unhandledRejection', (reason, promise) => {
  log('red', '未處理的Promise拒絕:');
  log('red', reason);
  process.exit(1);
});

// 執行測試
if (require.main === module) {
  runTests().catch(error => {
    log('red', '測試執行失敗:');
    log('red', error.message);
    process.exit(1);
  });
}

module.exports = {
  runTests,
  test
};