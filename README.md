# air｜IoT Sensor Network Monitor

一個用來檢查環境感測站資料品質與可用性的輕量工具。

這個 repo 原本是一個展示型空氣品質聊天機器人，包含模擬 AQI 對話與大量前端展示。現在把重點改成更實際的問題：

**感測站資料到底能不能用？**

目前會檢查：

- 座標是否合法
- PM2.5 數值是否落在合理資料範圍
- 資料是否過期
- 同一站同一時間是否重複上報
- 指定位置附近，哪一個可用站點最近
- 可用站點 PM2.5 的 median summary

## 為什麼這樣做

IoT 系統不是「API 回到資料」就算完成。實際使用前至少要先回答：

- 這筆資料多久以前的？
- 感測值是不是明顯錯誤？
- 同一筆是不是重複送進來？
- 使用者附近最近的站有沒有健康資料？
- 單一站點異常時，整體摘要會不會被拉歪？

所以這個版本刻意不做假即時資訊，也不直接給健康建議。

## 快速執行

不需要第三方套件。

```bash
python -m unittest discover -s tests -v
python cli.py sample/readings.jsonl --lat 24.1477 --lon 120.6736 --now 2026-10-05T08:00:00+00:00
```

輸出會包含：

- 總筆數
- 可用／不可用筆數
- 資料錯誤
- 最近可用站點
- 距離
- median PM2.5

## 資料格式

```json
{"station_id":"TC001","lat":24.1477,"lon":120.6736,"pm25":18.2,"observed_at":"2026-10-05T07:40:00+00:00"}
```

## 規則

目前示範規則：

- latitude：-90 ～ 90
- longitude：-180 ～ 180
- PM2.5：0 ～ 1000 µg/m³
- 預設資料有效期限：60 分鐘

這裡的 PM2.5 上限是資料 sanity check，不是健康分級標準。

## 專案結構

```text
src/air_monitor/
  model.py
  geo.py
  quality.py
  service.py
cli.py
sample/
tests/
.github/workflows/test.yml
```

## 限制

- 範例資料是合成資料
- 沒有連接政府即時資料源
- 沒有 AQI 換算與健康建議
- 沒有處理感測器校正與漂移模型
- nearest station 只用球面距離，不考慮實際道路或地形

這個作品要展示的是 IoT 資料品質與地理選站邏輯，不是把 demo 包裝成即時監測服務。
