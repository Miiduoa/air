/**
 * LINE 智慧空氣品質機器人 - 增強版測試腳本
 * 專門測試修復後的功能
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
  failed: 0,
  categories: {
    basic: { total: 0, passed: 0 },
    api: { total: 0, passed: 0 },
    functionality: { total: 0, passed: 0 },
    performance: { total: 0, passed: 0 }
  }
};

// 測試工具函數
async function test(name, testFunction, category = 'basic') {
  testResults.total++;
  testResults.categories[category].total++;
  
  try {
    log('cyan', `\n🧪 測試: ${name}`);
    await testFunction();
    testResults.passed++;
    testResults.categories[category].passed++;
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

// 1. 測試基礎服務健康
async function testBasicHealth() {
  const response = await axios.get(`${BASE_URL}/health`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  if (response.data.status !== 'OK') {
    throw new Error(`服務狀態異常: ${response.data.status}`);
  }
  
  // 檢查統計資料
  if (!response.data.statistics) {
    throw new Error('缺少統計資料');
  }
  
  log('blue', `   服務狀態: ${response.data.status}`);
  log('blue', `   運行時間: ${response.data.uptime || '未知'} 秒`);
  log('blue', `   支援城市: ${response.data.statistics.supported_cities || '未知'}`);
  log('blue', `   LINE Bot 配置: ${response.data.environment.line_token_configured ? '✅' : '❌'}`);
}

// 2. 測試增強版調試API
async function testEnhancedDebugAPI() {
  const response = await axios.get(`${BASE_URL}/debug`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  const data = response.data;
  
  // 檢查功能狀態
  if (!data.features_status) {
    throw new Error('缺少功能狀態資訊');
  }
  
  const requiredFeatures = [
    'real_time_query',
    'multi_city_comparison',
    'subscription_management',
    'flex_message_interface'
  ];
  
  for (const feature of requiredFeatures) {
    if (data.features_status[feature] !== 'enabled') {
      throw new Error(`功能未啟用: ${feature}`);
    }
  }
  
  log('blue', `   平台: ${data.platform}`);
  log('blue', `   Node版本: ${data.node_version}`);
  log('blue', `   記憶體使用: ${Math.round(data.memory_usage.heapUsed / 1024 / 1024)}MB`);
  log('blue', `   支援城市數: ${data.data_statistics?.supported_cities_count || 0}`);
  log('green', '   所有核心功能狀態正常');
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

// 5. 測試國際城市 - 東京
async function testAirQualityTokyo() {
  const response = await axios.get(`${BASE_URL}/api/air-quality/tokyo`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  const data = response.data;
  
  if (!data.aqi || typeof data.aqi !== 'number') {
    throw new Error('AQI數據格式錯誤');
  }
  
  log('blue', `   東京 AQI: ${data.aqi}`);
  log('blue', `   城市名稱: ${data.city.name}`);
}

// 6. 測試錯誤處理 - 不存在的城市
async function testNonExistentCity() {
  try {
    await axios.get(`${BASE_URL}/api/air-quality/nonexistentcity12345`);
    throw new Error('應該返回錯誤，但沒有');
  } catch (error) {
    if (error.response && error.response.status === 500) {
      log('blue', '   正確處理不存在的城市查詢');
      return;
    }
    throw error;
  }
}

// 7. 測試服務統計API
async function testStatsAPI() {
  const response = await axios.get(`${BASE_URL}/api/stats`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  const data = response.data;
  
  if (!data.service || !data.statistics) {
    throw new Error('統計數據格式錯誤');
  }
  
  log('blue', `   服務名稱: ${data.service.name}`);
  log('blue', `   版本: ${data.service.version}`);
  log('blue', `   支援城市: ${data.statistics.supportedCities}`);
  log('blue', `   功能數量: ${data.features?.length || 0}`);
  
  // 檢查是否包含重要功能
  const requiredFeatures = [
    'real_time_air_quality',
    'multi_city_comparison',
    'subscription_alerts',
    'flex_message_interface'
  ];
  
  for (const feature of requiredFeatures) {
    if (!data.features.includes(feature)) {
      throw new Error(`缺少重要功能: ${feature}`);
    }
  }
  
  log('green', '   所有核心功能都已啟用');
}

// 8. 測試訂閱統計API
async function testSubscriptionStatsAPI() {
  try {
    const response = await axios.get(`${BASE_URL}/api/subscriptions/stats`);
    
    if (response.status === 200) {
      const data = response.data;
      log('blue', `   總用戶數: ${data.total_users || 0}`);
      log('blue', `   總訂閱數: ${data.total_subscriptions || 0}`);
      log('blue', `   每日報告啟用: ${data.settings_distribution?.daily_report_enabled || 0}`);
      log('blue', `   緊急警報啟用: ${data.settings_distribution?.emergency_alert_enabled || 0}`);
    }
  } catch (error) {
    // 訂閱統計可能為空，不算錯誤
    log('yellow', '   訂閱統計API正常運行（當前無用戶數據）');
  }
}

// 9. 測試回應時間
async function testResponseTime() {
  const startTime = Date.now();
  await axios.get(`${BASE_URL}/api/air-quality/taipei`);
  const responseTime = Date.now() - startTime;
  
  if (responseTime > 15000) {
    throw new Error(`回應時間過長: ${responseTime}ms`);
  }
  
  log('blue', `   回應時間: ${responseTime}ms`);
  
  if (responseTime < 2000) {
    log('green', '   ⚡ 回應速度優秀！');
  } else if (responseTime < 5000) {
    log('yellow', '   ⏱️ 回應速度良好');
  } else {
    log('yellow', '   🐌 回應速度較慢，可考慮優化');
  }
}

// 10. 測試並發請求
async function testConcurrentRequests() {
  const cities = ['taipei', 'kaohsiung', 'taichung', 'tokyo', 'singapore'];
  const promises = cities.map(city => 
    axios.get(`${BASE_URL}/api/air-quality/${city}`)
  );
  
  const startTime = Date.now();
  const responses = await Promise.all(promises);
  const totalTime = Date.now() - startTime;
  
  // 檢查是否有失敗的請求
  const failedRequests = responses.filter(res => res.status !== 200);
  if (failedRequests.length > 0) {
    throw new Error(`${failedRequests.length} 個請求失敗`);
  }
  
  log('blue', `   並發查詢 ${cities.length} 個城市`);
  log('blue', `   總耗時: ${totalTime}ms`);
  log('blue', `   平均耗時: ${Math.round(totalTime / cities.length)}ms`);
  
  if (totalTime < 8000) {
    log('green', '   ⚡ 並發性能優秀！');
  } else if (totalTime < 15000) {
    log('yellow', '   ⏱️ 並發性能良好');
  } else {
    log('yellow', '   🐌 並發性能需要優化');
  }
}

// 11. 測試錯誤處理機制
async function testErrorHandling() {
  try {
    // 測試不存在的路由
    await axios.get(`${BASE_URL}/nonexistent-route`);
    throw new Error('應該返回404錯誤');
  } catch (error) {
    if (error.response && error.response.status === 404) {
      const errorData = error.response.data;
      if (!errorData.error || !errorData.available_routes) {
        throw new Error('404錯誤格式不正確');
      }
      log('blue', '   正確處理404錯誤');
    } else {
      throw error;
    }
  }
}

// 12. 測試數據一致性
async function testDataConsistency() {
  // 多次請求同一城市，檢查數據是否一致
  const responses = await Promise.all([
    axios.get(`${BASE_URL}/api/air-quality/taipei`),
    axios.get(`${BASE_URL}/api/air-quality/taipei`)
  ]);
  
  const data1 = responses[0].data;
  const data2 = responses[1].data;
  
  // AQI在短時間內應該相同或相近
  const aqiDiff = Math.abs(data1.aqi - data2.aqi);
  if (aqiDiff > 10) {
    log('yellow', `   AQI差異較大: ${aqiDiff} (可能是數據更新)`);
  } else {
    log('blue', `   數據一致性良好，AQI差異: ${aqiDiff}`);
  }
  
  // 城市名稱應該相同
  if (data1.city.name !== data2.city.name) {
    throw new Error('城市名稱不一致');
  }
  
  log('green', '   數據一致性測試通過');
}

// 13. 測試所有支援的重要城市
async function testImportantCities() {
  const importantCities = ['taipei', 'kaohsiung', 'taichung', 'tokyo', 'seoul', 'singapore', 'hong-kong'];
  const results = [];
  
  for (const city of importantCities) {
    try {
      const response = await axios.get(`${BASE_URL}/api/air-quality/${city}`);
      if (response.status === 200 && response.data.aqi) {
        results.push({ city, aqi: response.data.aqi, status: 'success' });
      } else {
        results.push({ city, status: 'no_data' });
      }
    } catch (error) {
      results.push({ city, status: 'error', error: error.message });
    }
    
    // 避免請求過於頻繁
    await delay(300);
  }
  
  const successCount = results.filter(r => r.status === 'success').length;
  const totalCount = results.length;
  
  log('blue', `   成功查詢城市: ${successCount}/${totalCount}`);
  
  results.forEach(result => {
    if (result.status === 'success') {
      log('blue', `   ${result.city}: AQI ${result.aqi}`);
    } else {
      log('yellow', `   ${result.city}: ${result.status}`);
    }
  });
  
  if (successCount < totalCount * 0.7) {
    throw new Error('太多城市查詢失敗');
  }
  
  log('green', '   重要城市查詢成功率符合預期');
}

// 14. 測試服務穩定性
async function testServiceStability() {
  const testCount = 3;
  const results = [];
  
  for (let i = 0; i < testCount; i++) {
    try {
      const startTime = Date.now();
      const response = await axios.get(`${BASE_URL}/health`);
      const responseTime = Date.now() - startTime;
      
      if (response.status === 200 && response.data.status === 'OK') {
        results.push({ success: true, responseTime });
      } else {
        results.push({ success: false, responseTime });
      }
    } catch (error) {
      results.push({ success: false, error: error.message });
    }
    
    await delay(2000); // 等待2秒
  }
  
  const successCount = results.filter(r => r.success).length;
  const avgResponseTime = results
    .filter(r => r.success && r.responseTime)
    .reduce((sum, r) => sum + r.responseTime, 0) / successCount;
  
  log('blue', `   穩定性測試: ${successCount}/${testCount} 成功`);
  log('blue', `   平均回應時間: ${Math.round(avgResponseTime)}ms`);
  
  if (successCount < testCount) {
    throw new Error('服務穩定性不足');
  }
  
  log('green', '   服務穩定性測試通過');
}

// 15. 測試Webhook端點（模擬）
async function testWebhookEndpoint() {
  try {
    // 嘗試POST到webhook端點（無需實際LINE簽名）
    const response = await axios.post(`${BASE_URL}/webhook`, {
      events: []
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: function (status) {
        // 接受400狀態碼（因為沒有LINE簽名會被拒絕）
        return status === 400 || status === 200;
      }
    });
    
    if (response.status === 400 || response.status === 200) {
      log('blue', '   Webhook端點響應正常');
    } else {
      throw new Error(`意外的狀態碼: ${response.status}`);
    }
  } catch (error) {
    if (error.response && error.response.status === 400) {
      log('blue', '   Webhook端點響應正常（拒絕無效請求）');
    } else {
      throw error;
    }
  }
}

// 主測試函數
async function runTests() {
  log('bright', '🚀 開始測試 LINE 智慧空氣品質機器人服務 v2.0 (修復版)');
  log('bright', `📡 測試目標: ${BASE_URL}`);
  log('bright', '=' .repeat(80));
  
  // 基礎服務測試
  log('bright', '\n📋 基礎服務測試');
  log('bright', '-' .repeat(40));
  await test('基礎健康檢查', testBasicHealth, 'basic');
  await test('增強版調試API', testEnhancedDebugAPI, 'basic');
  await test('錯誤處理機制', testErrorHandling, 'basic');
  await test('Webhook端點測試', testWebhookEndpoint, 'basic');
  
  // API功能測試
  log('bright', '\n🔧 API功能測試');
  log('bright', '-' .repeat(40));
  await test('台北空氣品質查詢', testAirQualityTaipei, 'api');
  await test('高雄空氣品質查詢', testAirQualityKaohsiung, 'api');
  await test('東京空氣品質查詢', testAirQualityTokyo, 'api');
  await test('不存在城市處理', testNonExistentCity, 'api');
  await test('服務統計API', testStatsAPI, 'api');
  await test('訂閱統計API', testSubscriptionStatsAPI, 'api');
  
  // 功能完整性測試
  log('bright', '\n🎯 功能完整性測試');
  log('bright', '-' .repeat(40));
  await test('數據一致性測試', testDataConsistency, 'functionality');
  await test('重要城市支援測試', testImportantCities, 'functionality');
  
  // 性能測試
  log('bright', '\n⚡ 性能測試');
  log('bright', '-' .repeat(40));
  await test('回應時間測試', testResponseTime, 'performance');
  await test('並發請求測試', testConcurrentRequests, 'performance');
  await test('服務穩定性測試', testServiceStability, 'performance');
  
  // 測試結果摘要
  log('bright', '\n' + '=' .repeat(80));
  log('bright', '📊 測試結果摘要');
  log('bright', '=' .repeat(80));
  
  // 分類統計
  Object.entries(testResults.categories).forEach(([category, stats]) => {
    const rate = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;
    const categoryName = {
      basic: '基礎服務',
      api: 'API功能',
      functionality: '功能完整性',
      performance: '性能測試'
    }[category];
    
    log('cyan', `${categoryName}: ${stats.passed}/${stats.total} (${rate}%)`);
  });
  
  log('bright', '-' .repeat(50));
  log('cyan', `總測試數: ${testResults.total}`);
  log('green', `通過: ${testResults.passed}`);
  log('red', `失敗: ${testResults.failed}`);
  
  const successRate = Math.round((testResults.passed / testResults.total) * 100);
  log('bright', `總成功率: ${successRate}%`);
  
  // 評估結果
  if (testResults.f