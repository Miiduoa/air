import argparse
import json
from datetime import datetime

from src.air_monitor import build_summary, load_jsonl


parser = argparse.ArgumentParser(description="Check IoT sensor readings and find the nearest healthy station")
parser.add_argument("path")
parser.add_argument("--lat", type=float, required=True)
parser.add_argument("--lon", type=float, required=True)
parser.add_argument("--now", required=True)
parser.add_argument("--max-age-minutes", type=int, default=60)
args = parser.parse_args()

now = datetime.fromisoformat(args.now)
if now.tzinfo is None:
    raise SystemExit("--now must include timezone")

summary = build_summary(
    load_jsonl(args.path),
    now=now,
    lat=args.lat,
    lon=args.lon,
    max_age_minutes=args.max_age_minutes,
)

print(json.dumps(summary, ensure_ascii=False, indent=2))
raise SystemExit(1 if summary["invalid"] else 0)
