from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .model import SensorReading
from .quality import duplicate_keys, parse_time, validate_reading


@dataclass(frozen=True)
class QuarantineRecord:
    line_number: int
    station_id: str | None
    reason: str
    raw_sha256: str

    def to_dict(self) -> dict:
        return {
            "line_number": self.line_number,
            "station_id": self.station_id,
            "reason": self.reason,
            "raw_sha256": self.raw_sha256,
        }


@dataclass(frozen=True)
class PipelineOutcome:
    accepted: tuple[SensorReading, ...]
    quarantine: tuple[QuarantineRecord, ...]
    metrics: dict
    health: str

    def report(self) -> dict:
        return {
            "health": self.health,
            "metrics": self.metrics,
            "quarantine": [
                item.to_dict()
                for item in self.quarantine
            ],
        }


def _raw_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _health(
    *,
    accepted_total: int,
    input_lines: int,
    latest_lag_minutes: float | None,
    min_accepted_ratio: float,
    max_latest_lag_minutes: float,
) -> str:
    if input_lines <= 0 or accepted_total <= 0:
        return "unhealthy"

    accepted_ratio = accepted_total / input_lines
    if accepted_ratio < 0.5:
        return "unhealthy"

    if accepted_ratio < min_accepted_ratio:
        return "degraded"

    if (
        latest_lag_minutes is None
        or latest_lag_minutes > max_latest_lag_minutes
    ):
        return "degraded"

    return "healthy"


def run_jsonl_pipeline(
    path: str | Path,
    *,
    now: datetime,
    max_age_minutes: int = 60,
    min_accepted_ratio: float = 0.90,
    max_latest_lag_minutes: float = 30,
) -> PipelineOutcome:
    if now.tzinfo is None:
        raise ValueError("now must include timezone")
    if not 0 < min_accepted_ratio <= 1:
        raise ValueError("min_accepted_ratio must be between 0 and 1")
    if max_age_minutes <= 0 or max_latest_lag_minutes <= 0:
        raise ValueError("age thresholds must be positive")

    source = Path(path)
    parsed: list[tuple[int, str, SensorReading]] = []
    quarantine: list[QuarantineRecord] = []
    input_lines = 0
    malformed_total = 0

    with source.open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, start=1):
            if not raw.strip():
                continue

            input_lines += 1
            stripped = raw.rstrip("\n")

            try:
                payload = json.loads(stripped)
                reading = SensorReading(**payload)
            except (json.JSONDecodeError, TypeError) as exc:
                malformed_total += 1
                quarantine.append(
                    QuarantineRecord(
                        line_number=line_number,
                        station_id=None,
                        reason=f"parse error: {exc.__class__.__name__}",
                        raw_sha256=_raw_hash(stripped),
                    )
                )
                continue

            parsed.append((line_number, stripped, reading))

    duplicate_set = duplicate_keys(
        [reading for _, _, reading in parsed]
    )

    accepted: list[SensorReading] = []
    stale_total = 0
    duplicate_total = 0
    invalid_coordinate_total = 0
    invalid_pm25_total = 0
    future_total = 0

    for line_number, raw, reading in parsed:
        status = validate_reading(
            reading,
            now=now,
            max_age_minutes=max_age_minutes,
        )
        errors = list(status.errors)

        key = (reading.station_id, reading.observed_at)
        if key in duplicate_set:
            errors.append("duplicate station timestamp")
            duplicate_total += 1

        if "reading is stale" in errors:
            stale_total += 1
        if "timestamp is in the future" in errors:
            future_total += 1
        if (
            "latitude out of range" in errors
            or "longitude out of range" in errors
        ):
            invalid_coordinate_total += 1
        if "pm25 out of sanity range" in errors:
            invalid_pm25_total += 1

        if errors:
            quarantine.append(
                QuarantineRecord(
                    line_number=line_number,
                    station_id=reading.station_id or None,
                    reason="; ".join(errors),
                    raw_sha256=_raw_hash(raw),
                )
            )
        else:
            accepted.append(reading)

    latest_lag_minutes = None
    if accepted:
        latest = max(
            parse_time(reading.observed_at)
            for reading in accepted
        )
        latest_lag_minutes = round(
            max((now - latest).total_seconds() / 60, 0.0),
            3,
        )

    unique_stations = {
        reading.station_id
        for _, _, reading in parsed
        if reading.station_id
    }
    healthy_stations = {
        reading.station_id
        for reading in accepted
        if reading.station_id
    }

    accepted_ratio = (
        accepted_total / input_lines
        if (accepted_total := len(accepted)) and input_lines
        else 0.0
    )
    healthy_station_ratio = (
        len(healthy_stations) / len(unique_stations)
        if unique_stations
        else 0.0
    )

    metrics = {
        "input_lines": input_lines,
        "parsed_total": len(parsed),
        "accepted_total": accepted_total,
        "quarantined_total": len(quarantine),
        "malformed_total": malformed_total,
        "stale_total": stale_total,
        "duplicate_total": duplicate_total,
        "future_total": future_total,
        "invalid_coordinate_total": invalid_coordinate_total,
        "invalid_pm25_total": invalid_pm25_total,
        "accepted_ratio": round(accepted_ratio, 4),
        "unique_station_total": len(unique_stations),
        "healthy_station_total": len(healthy_stations),
        "healthy_station_ratio": round(healthy_station_ratio, 4),
        "latest_lag_minutes": latest_lag_minutes,
    }

    health = _health(
        accepted_total=accepted_total,
        input_lines=input_lines,
        latest_lag_minutes=latest_lag_minutes,
        min_accepted_ratio=min_accepted_ratio,
        max_latest_lag_minutes=max_latest_lag_minutes,
    )

    return PipelineOutcome(
        accepted=tuple(accepted),
        quarantine=tuple(quarantine),
        metrics=metrics,
        health=health,
    )


def write_quarantine(
    outcome: PipelineOutcome,
    path: str | Path,
) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    with target.open("w", encoding="utf-8") as handle:
        for item in outcome.quarantine:
            handle.write(
                json.dumps(
                    item.to_dict(),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
