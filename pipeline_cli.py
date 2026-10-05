import argparse
import json
from datetime import datetime

from src.air_monitor import run_jsonl_pipeline, write_quarantine


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Ingest sensor JSONL with row-level quarantine and pipeline health"
    )
    parser.add_argument("path")
    parser.add_argument("--now", required=True)
    parser.add_argument("--max-age-minutes", type=int, default=60)
    parser.add_argument("--min-accepted-ratio", type=float, default=0.90)
    parser.add_argument("--max-latest-lag-minutes", type=float, default=30)
    parser.add_argument("--quarantine-out")
    args = parser.parse_args()

    now = datetime.fromisoformat(args.now)
    if now.tzinfo is None:
        raise SystemExit("--now must include timezone")

    outcome = run_jsonl_pipeline(
        args.path,
        now=now,
        max_age_minutes=args.max_age_minutes,
        min_accepted_ratio=args.min_accepted_ratio,
        max_latest_lag_minutes=args.max_latest_lag_minutes,
    )

    if args.quarantine_out:
        write_quarantine(outcome, args.quarantine_out)

    print(json.dumps(outcome.report(), ensure_ascii=False, indent=2))

    if outcome.health == "unhealthy":
        return 2
    if outcome.health == "degraded":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
