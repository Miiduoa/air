# air｜IoT sensor data pipeline

[![test](https://github.com/Miiduoa/air/actions/workflows/test.yml/badge.svg)](https://github.com/Miiduoa/air/actions/workflows/test.yml)

感測器 API 有回資料，不代表資料可以直接拿來算。

這個 repo 把原本的空氣品質展示程式整理成一個小型 IoT data pipeline：先逐筆 ingest、驗證、quarantine，再根據健康資料做地理選站與摘要；同時輸出 pipeline health 指標，讓「資料現在到底能不能用」可以被監控。

## Pipeline

```text
JSONL input
   ↓
row-level parse
   ├─ malformed → quarantine
   ↓
schema / range / timestamp checks
   ├─ invalid → quarantine
   ↓
duplicate detection
   ├─ duplicate → quarantine
   ↓
accepted readings
   ├─ nearest healthy station
   ├─ median PM2.5
   └─ pipeline metrics / health
```

## Row-level quarantine

以前 `load_jsonl` 遇到一筆壞 JSON 會 fail fast。這在小工具很合理，但實際 ingestion pipeline 通常不希望第 351 筆壞資料讓前 350 筆與後面所有資料一起消失。

`run_jsonl_pipeline` 會把壞資料隔離，其他可用 row 繼續處理。

目前 quarantine 原因包含：

- JSON / schema parse error
- station id 缺失
- latitude / longitude 不合法
- PM2.5 超出 sanity range
- timestamp 沒 timezone
- timestamp 在未來
- reading stale
- station + timestamp 重複

## Observability

每次 pipeline 會輸出：

- `input_lines`
- `parsed_total`
- `accepted_total`
- `quarantined_total`
- `malformed_total`
- `stale_total`
- `duplicate_total`
- `future_total`
- `invalid_coordinate_total`
- `invalid_pm25_total`
- `accepted_ratio`
- `healthy_station_ratio`
- `latest_lag_minutes`

並依門檻標成：

- `healthy`
- `degraded`
- `unhealthy`

這些是 pipeline health，不是空氣品質健康建議。

## Privacy / data minimization

Quarantine 檔不複製原始 JSON row，只保存：

```json
{
  "line_number": 4,
  "station_id": null,
  "reason": "parse error: JSONDecodeError",
  "raw_sha256": "..."
}
```

這樣可以確認同一筆壞資料是否重複出現，又不必額外複製整份原始 payload。

## Run

原本的 network summary：

```bash
python cli.py sample/readings.jsonl \
  --lat 24.1477 \
  --lon 120.6736 \
  --now 2026-10-05T08:00:00+00:00
```

Pipeline mode：

```bash
python pipeline_cli.py sample/pipeline_readings.jsonl \
  --now 2026-10-05T08:00:00+00:00 \
  --quarantine-out tmp/quarantine.jsonl
```

Exit code：

- `0`：healthy
- `1`：degraded
- `2`：unhealthy

因此可以直接拿來做 scheduled data-quality check 或 CI fixture。

## Existing network checks

健康資料仍可用來：

- 找指定位置最近的可用站點（Haversine）
- 計算健康站點 PM2.5 median
- 排除 stale / duplicate / invalid reading

PM2.5 的 `0–1000 µg/m³` 只是資料 sanity range，不是健康分級。

## Tests

```bash
python -m unittest discover -s tests -v
```

測試包含：

- 座標與 freshness
- duplicate detection
- nearest healthy station
- median
- malformed row 不拖垮整批
- duplicate rows quarantine
- degraded / unhealthy health classification
- freshness lag
- quarantine 不保存 raw payload

## Scope

這是 ingestion / data quality / observability 練習，不宣稱接了政府即時資料，也不提供醫療或空氣品質健康建議。

目前是單檔 JSONL pipeline。真的進入 streaming / high-volume 場景時，才值得加入 object storage、stream broker、warehouse 與 metrics backend。

## License

MIT
