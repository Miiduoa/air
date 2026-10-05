import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from src.air_monitor import run_jsonl_pipeline, write_quarantine


NOW = datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc)


def row(
    station_id,
    pm25=20,
    observed_at="2026-10-05T07:50:00+00:00",
    lat=24.15,
    lon=120.67,
):
    return json.dumps(
        {
            "station_id": station_id,
            "lat": lat,
            "lon": lon,
            "pm25": pm25,
            "observed_at": observed_at,
        }
    )


class PipelineTests(unittest.TestCase):
    def write_lines(self, root, lines):
        path = Path(root) / "readings.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def test_malformed_row_is_quarantined_without_losing_good_rows(self):
        with tempfile.TemporaryDirectory() as td:
            path = self.write_lines(
                td,
                [
                    row("A"),
                    '{"station_id":',
                    row("B"),
                ],
            )

            outcome = run_jsonl_pipeline(
                path,
                now=NOW,
                min_accepted_ratio=0.60,
            )

            self.assertEqual(outcome.metrics["accepted_total"], 2)
            self.assertEqual(outcome.metrics["malformed_total"], 1)
            self.assertEqual(outcome.metrics["quarantined_total"], 1)
            self.assertEqual(outcome.health, "healthy")

    def test_duplicate_rows_are_both_quarantined(self):
        with tempfile.TemporaryDirectory() as td:
            duplicate = row("A")
            path = self.write_lines(td, [duplicate, duplicate])

            outcome = run_jsonl_pipeline(path, now=NOW)

            self.assertEqual(outcome.metrics["duplicate_total"], 2)
            self.assertEqual(outcome.metrics["accepted_total"], 0)
            self.assertEqual(outcome.health, "unhealthy")

    def test_partial_quality_failure_is_degraded(self):
        with tempfile.TemporaryDirectory() as td:
            path = self.write_lines(
                td,
                [
                    row("A"),
                    row("B"),
                    row("C"),
                    row("D", pm25=-1),
                ],
            )

            outcome = run_jsonl_pipeline(
                path,
                now=NOW,
                min_accepted_ratio=0.90,
            )

            self.assertEqual(outcome.metrics["accepted_ratio"], 0.75)
            self.assertEqual(outcome.health, "degraded")

    def test_lag_can_degrade_otherwise_valid_pipeline(self):
        with tempfile.TemporaryDirectory() as td:
            path = self.write_lines(
                td,
                [
                    row(
                        "A",
                        observed_at="2026-10-05T07:35:00+00:00",
                    )
                ],
            )

            outcome = run_jsonl_pipeline(
                path,
                now=NOW,
                max_age_minutes=60,
                max_latest_lag_minutes=15,
            )

            self.assertEqual(outcome.metrics["accepted_total"], 1)
            self.assertEqual(outcome.health, "degraded")

    def test_quarantine_file_contains_hash_not_raw_payload(self):
        with tempfile.TemporaryDirectory() as td:
            secret_value = "private-sensor-payload"
            path = self.write_lines(
                td,
                [secret_value],
            )
            outcome = run_jsonl_pipeline(path, now=NOW)
            target = Path(td) / "quarantine.jsonl"

            write_quarantine(outcome, target)
            content = target.read_text(encoding="utf-8")

            self.assertNotIn(secret_value, content)
            record = json.loads(content)
            self.assertEqual(record["line_number"], 1)
            self.assertEqual(len(record["raw_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
