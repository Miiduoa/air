import unittest
from datetime import datetime, timezone

from src.air_monitor import (
    SensorReading,
    assess,
    build_summary,
    haversine_km,
    median_pm25,
    nearest_healthy_station,
    validate_reading,
)


NOW = datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc)


def reading(
    station_id="A",
    lat=24.15,
    lon=120.67,
    pm25=20.0,
    observed_at="2026-10-05T07:30:00+00:00",
):
    return SensorReading(
        station_id=station_id,
        lat=lat,
        lon=lon,
        pm25=pm25,
        observed_at=observed_at,
    )


class AirMonitorTests(unittest.TestCase):
    def test_same_coordinate_has_zero_distance(self):
        self.assertAlmostEqual(
            haversine_km(24.15, 120.67, 24.15, 120.67),
            0.0,
        )

    def test_fresh_reading_passes(self):
        status = validate_reading(reading(), now=NOW)
        self.assertTrue(status.ok)

    def test_stale_reading_fails(self):
        status = validate_reading(
            reading(observed_at="2026-10-05T05:00:00+00:00"),
            now=NOW,
        )
        self.assertFalse(status.ok)
        self.assertIn("reading is stale", status.errors)

    def test_bad_coordinate_fails(self):
        status = validate_reading(reading(lat=95), now=NOW)
        self.assertFalse(status.ok)

    def test_duplicate_station_timestamp_fails_both_rows(self):
        rows = [
            reading(station_id="A"),
            reading(station_id="A", pm25=22),
        ]
        statuses = assess(rows, now=NOW)

        self.assertFalse(statuses[0].ok)
        self.assertFalse(statuses[1].ok)

    def test_nearest_station_ignores_invalid_readings(self):
        rows = [
            reading(
                station_id="bad",
                lat=24.1501,
                pm25=-1,
            ),
            reading(
                station_id="good",
                lat=24.16,
                lon=120.68,
                pm25=20,
            ),
        ]
        statuses = assess(rows, now=NOW)
        nearest = nearest_healthy_station(
            statuses,
            lat=24.15,
            lon=120.67,
        )

        self.assertEqual(nearest.station_id, "good")

    def test_median_is_robust_to_station_order(self):
        statuses = assess(
            [
                reading(station_id="A", pm25=10),
                reading(station_id="B", pm25=30),
                reading(station_id="C", pm25=20),
            ],
            now=NOW,
        )

        self.assertEqual(median_pm25(statuses), 20)

    def test_summary_counts_health(self):
        rows = [
            reading(station_id="A", pm25=10),
            reading(
                station_id="B",
                pm25=20,
                observed_at="2026-10-05T04:00:00+00:00",
            ),
        ]
        summary = build_summary(
            rows,
            now=NOW,
            lat=24.15,
            lon=120.67,
        )

        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["healthy"], 1)
        self.assertEqual(summary["invalid"], 1)
        self.assertEqual(summary["nearest"]["station_id"], "A")


if __name__ == "__main__":
    unittest.main()
