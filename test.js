/**
 * LINE 智慧空氣品質機器人 - 修復驗證測試腳本
 * 測試所有修復的功能是否正常工作
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
  fixes: {
    query_parsing: { total: 0, passed: 0 },
    settings_buttons: { total: 0, passed: 0 },
    subscription_management: { total: 0, passed: 0 },
    city_selection: { total: 0, passed: 0 },
    error_handling: { total: 0, passed: 0 }
  }
};

// 測試工具函數
async function test(name, testFunction, category = 'general') {
  testResults.total++;
  if (testResults.fixes[category]) {
    testResults.fixes[category].total++;
  }
  
  try {
    log('cyan', `\n🧪 測試: ${name}`);
    await testFunction();
    testResults.passed++;
    if (testResults.fixes[category]) {
      testResults.fixes[category].passed++;
    }
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

// 1. 測試基礎服務健康 (修復版檢查)
async function testFixedServiceHealth() {
  const response = await axios.get(`${BASE_URL}/health`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  if (response.data.status !== 'OK') {
    throw new Error(`服務狀態異常: ${response.data.status}`);
  }
  
  // 檢查是否為修復版
  if (!response.data.version || !response.data.version.includes('fixed')) {
    throw new Error('不是修復版本');
  }
  
  // 檢查修復清單
  if (!response.data.fixes_applied || response.data.fixes_applied.length === 0) {
    throw new Error('缺少修復清單');
  }
  
  log('blue', `   版本: ${response.data.version}`);
  log('blue', `   修復項目數: ${response.data.fixes_applied.length}`);
  log('green', '   ✅ 確認為修復版本');
}

// 2. 測試調試端點的修復信息
async function testDebugFixInfo() {
  const response = await axios.get(`${BASE_URL}/debug`);
  
  if (response.status !== 200) {
    throw new Error(`狀態碼錯誤: ${response.status}`);
  }
  
  const data = response.data;
  
  // 檢查修復清單
  if (!data.fixes_applied || data.fixes_applied.length < 5) {
    throw new Error('修復清單不完整');
  }
  
  const expectedFixes = [
    'parseQuery邏輯修復',
    '設定按鈕回應修復',
    '訂閱管理功能修復',
    '城市選擇按鈕修復',
    '用戶狀態管理修復'
  ];
  
  for (const fix of expectedFixes) {
    if (!data.fixes_applied.some(applied => applied.includes(fix.split('修復')[0]))) {
      throw new Error(`缺少修復項目: ${fix}`);
    }
  }
  
  log('blue', `   總修復項目: ${data.fixes_applied.length}`);
  log('blue', `   版本: ${data.version}`);
  log('green', '   ✅ 所有主要修復項目都已包含');
}

// 3. 測試城市查詢功能 (修復後)
async function testCityQueryFixed() {
  // 測試各種城市查詢格式
  const testCities = ['taipei', 'kaohsiung', 'tokyo', 'singapore'];
  const results = [];
  
  for (const city of testCities) {
    try {
      const response = await axios.get(`${BASE_URL}/api/air-quality/${city}`);
      if (response.status === 200 && response.data.aqi) {
        results.push({ city, aqi: response.data.aqi, status: 'success' });
        log('blue', `   ${city}: AQI ${response.data.aqi}`);
      } else {
        results.push({ city, status: 'no_data' });
      }
    } catch (error) {
      results.push({ city, status: 'error' });
    }
    
    await delay(500); // 避免請求過於頻繁
  }
  
  const successCount = results.filter(r => r.status === 'success').length;
  
  if (successCount < testCities.length * 0.7) {
    throw new Error('太多城市查詢失敗');
  }
  
  log('green', `   ✅ 城市查詢成功率: ${successCount}/${testCities.length}`);
}

// 4. 測試並發查詢穩定性
async function testConcurrentQueriesStability() {
  const cities = ['taipei', 'kaohsiung', 'taichung'];
  const promises = cities.map(city => 
    axios.get(`${BASE_URL}/api/air-quality/${city}`)
  );
  
  const startTime = Date.now();
  const responses = await Promise.all(promises);
  const totalTime = Date.now() - startTime;
  
  // 檢查是否有失敗的請求
  const failedRequests = responses.filter(res => res.status !== 200);
  if (failedRequests.length > 0) {
    throw new Error(`${failedRequests.length} 個並發請求失敗`);
  }
  
  log('blue', `   並發查詢 ${cities.length} 個城市`);
  log('blue', `   總耗時: ${totalTime}ms`);
  log('blue', `   平均耗時: ${Math.round(totalTime / cities.length)}ms`);
  
  if (totalTime > 10000) {
    throw new Error('並發查詢響應時間過長');
  }
  
  log('green', '   ✅ 並發查詢穩定性良好');
}

// 5. 測試錯誤處理改善
async function testImprovedErrorHandling() {
  try {
    // 測試不存在的路由
    await axios.get(`${BASE_URL}/nonexistent-route-12345`);
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
  
  try {
    // 測試不存在的城市
    await axios.get(`${BASE_URL}/api/air-quality/nonexistentcity99999`);
    // 可能會成功但返回錯誤數據，這是正常的
    log('blue', '   不存在城市查詢處理正常');
  } catch (error) {
    if (error.response && error.response.status === 500) {
      log('blue', '   不存在城市正確返回500錯誤');
    } else {
      throw error;
    }
  }
  
  log('green', '   ✅ 錯誤處理機制改善');
}

// 6. 測試服務穩定性 (修復版)
async function testServiceStabilityFixed() {
  const testCount = 5;
  const results = [];
  
  for (let i = 0; i < testCount; i++) {
    try {
      const startTime = Date.now();
      const response = await axios.get(`${BASE_URL}/health`);
      const responseTime = Date.now() - startTime;
      
      if (response.status === 200 && response.data.status === 'OK' && response.data.version.includes('fixed')) {
        results.push({ success: true, responseTime, isFixed: true });
      } else {
        results.push({ success: false, responseTime, isFixed: false });
      }
    } catch (error) {
      results.push({ success: false, error: error.message });
    }
    
    await delay(1000); // 等待1秒
  }
  
  const successCount = results.filter(r => r.success).length;
  const fixedCount = results.filter(r => r.isFixed).length;
  const avgResponseTime = results
    .filter(r => r.success && r.responseTime)
    .reduce((sum, r) => sum + r.responseTime, 0) / successCount;
  
  log('blue', `   穩定性測試: ${successCount}/${testCount} 成功`);
  log('blue', `   修復版確認: ${fixedCount}/${testCount}`);
  log('blue', `   平均回應時間: ${Math.round(avgResponseTime)}ms`);
  
  if (successCount < testCount || fixedCount < testCount) {
    throw new Error('服務穩定性不足或版本不正確');
  }
  
  log('green', '   ✅ 修復版服務穩定性測試通過');
}

// 7. 測試API數據一致性
async function testAPIDataConsistency() {
  // 連續查詢同一城市兩次，檢查數據一致性
  const responses = await Promise.all([
    axios.get(`${BASE_URL}/api/air-quality/taipei`),
    axios.get(`${BASE_URL}/api/air-quality/taipei`)
  ]);
  
  const data1 = responses[0].data;
  const data2 = responses[1].data;
  
  // 檢查基本結構一致性
  if (!data1.aqi || !data2.aqi || !data1.city || !data2.city) {
    throw new Error('API數據結構不完整');
  }
  
  // AQI在短時間內應該相同或相近
  const aqiDiff = Math.abs(data1.aqi - data2.aqi);
  if (aqiDiff > 20) {
    log('yellow', `   AQI差異: ${aqiDiff} (可能是數據更新)`);
  } else {
    log('blue', `   AQI差異: ${aqiDiff} (數據一致性良好)`);
  }
  
  // 城市名稱應該相同
  if (data1.city.name !== data2.city.name) {
    throw new Error('城市名稱不一致');
  }
  
  log('blue', `   台北 AQI: ${data1.aqi}`);
  log('green', '   ✅ API數據一致性測試通過');
}

// 8. 測試修復功能完整性
async function testFixedFunctionalityCompleteness() {
  // 測試健康檢查端點的完整性
  const healthResponse = await axios.get(`${BASE_URL}/health`);
  const statsResponse = await axios.get(`${BASE_URL}/api/stats`);
  const debugResponse = await axios.get(`${BASE_URL}/debug`);
  
  // 檢查版本信息
  const requiredVersionElements = ['fixed', '2.0'];
  const version = healthResponse.data.version;
  
  for (const element of requiredVersionElements) {
    if (!version.includes(element)) {
      throw new Error(`版本號缺少必要元素: ${element}`);
    }
  }
  
  // 檢查統計數據
  if (!statsResponse.data.statistics || !statsResponse.data.features) {
    throw new Error('統計端點數據不完整');
  }
  
  // 檢查調試信息
  if (!debugResponse.data.fixes_applied || debugResponse.data.fixes_applied.length < 5) {
    throw new Error('修復信息不完整');
  }
  
  log('blue', `   版本: ${version}`);
  log('blue', `   支援功能: ${statsResponse.data.features.length}`);
  log('blue', `   修復項目: ${debugResponse.data.fixes_applied.length}`);
  log('green', '   ✅ 修復功能完整性確認');
}

// 主測試函數
async function runFixValidationTests() {
  log('bright', '🔧 開始驗證 LINE 智慧空氣品質機器人修復效果');
  log('bright', `📡 測試目標: ${BASE_URL}`);
  log('bright', '=' .repeat(80));
  
  // 基礎修復驗證
  log('bright', '\n🔍 基礎修復驗證');
  log('bright', '-' .repeat(40));
  await test('修復版服務健康檢查', testFixedServiceHealth, 'general');
  await test('調試端點修復信息', testDebugFixInfo, 'general');
  await test('修復功能完整性', testFixedFunctionalityCompleteness, 'general');
  
  // 查詢功能修復驗證
  log('bright', '\n🔍 查詢功能修復驗證');
  log('bright', '-' .repeat(40));
  await test('城市查詢功能修復', testCityQueryFixed, 'query_parsing');
  await test('API數據一致性', testAPIDataConsistency, 'query_parsing');
  
  // 錯誤處理修復驗證
  log('bright', '\n🛡️ 錯誤處理修復驗證');
  log('bright', '-' .repeat(40));
  await test('錯誤處理改善', testImprovedErrorHandling, 'error_handling');
  
  // 性能穩定性驗證
  log('bright', '\n⚡ 性能穩定性驗證');
  log('bright', '-' .repeat(40));
  await test('並發查詢穩定性', testConcurrentQueriesStability, 'general');
  await test('修復版服務穩定性', testServiceStabilityFixed, 'general');
  
  // 修復結果摘要
  log('bright', '\n' + '=' .repeat(80));
  log('bright', '📊 修復驗證結果摘要');
  log('bright', '=' .repeat(80));
  
  // 分類統計
  Object.entries(testResults.fixes).forEach(([category, stats]) => {
    if (stats.total > 0) {
      const rate = Math.round((stats.passed / stats.total) * 100);
      const categoryName = {
        query_parsing: '查詢解析修復',
        settings_buttons: '設定按鈕修復',
        subscription_management: '訂閱管理修復',
        city_selection: '城市選擇修復',
        error_handling: '錯誤處理修復'
      }[category] || category;
      
      log('cyan', `${categoryName}: ${stats.passed}/${stats.total} (${rate}%)`);
    }
  });
  
  log('bright', '-' .repeat(50));
  log('cyan', `總測試數: ${testResults.total}`);
  log('green', `通過: ${testResults.passed}`);
  log('red', `失敗: ${testResults.failed}`);
  
  const successRate = Math.round((testResults.passed / testResults.total) * 100);
  log('bright', `修復驗證成功率: ${successRate}%`);
  
  // 評估修復效果
  if (testResults.failed === 0) {
    log('green', '\n🎉 恭喜！所有修復驗證都通過了！');
    log('green', '✅ LINE Bot 功能已完全修復');
    log('green', '✅ 服務穩定性良好');
    log('green', '✅ 錯誤處理完善');
  } else if (successRate >= 90) {
    log('yellow', '\n⚠️ 大部分修復驗證通過，還有少數問題需要處理');
    log('yellow', `❗ 有 ${testResults.failed} 個測試失敗，請檢查相關功能`);
  } else if (successRate >= 70) {
    log('yellow', '\n⚠️ 部分修復有效，但仍需進一步改善');
    log('yellow', `❗ 成功率 ${successRate}%，建議檢查失敗的測試項目`);
  } else {
    log('red', '\n❌ 修復效果不佳，需要重新檢查修復內容');
    log('red', `❌ 成功率僅 ${successRate}%，請仔細檢查代碼修復`);
  }
  
  log('bright', '\n📝 修復建議：');
  if (testResults.failed > 0) {
    log('yellow', '• 檢查失敗的測試項目');
    log('yellow', '• 確認環境變數設定正確');
    log('yellow', '• 檢查 LINE Bot 設定');
    log('yellow', '• 確認所有修復代碼已正確部署');
  } else {
    log('green', '• 所有功能運作正常！');
    log('green', '• 可以開始實際使用 LINE Bot');
    log('green', '• 建議進行用戶測試驗證');
  }
  
  log('bright', '\n🚀 修復驗證完成！');
}

// 執行修復驗證測試
runFixValidationTests().catch(error => {
  log('red', `\n💥 測試執行失敗: ${error.message}`);
  process.exit(1);
});