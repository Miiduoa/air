from datetime import datetime, timedelta

from .model import ReadingStatus, SensorReading


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include timezone")
    return parsed


def validate_reading(
    reading: SensorReading,
    now: datetime,
    max_age_minutes: int = 60,
) -> ReadingStatus:
    errors = []

    if not reading.station_id.strip():
        errors.append("station_id is required")

    if not -90 <= reading.lat <= 90:
        errors.append("latitude out of range")

    if not -180 <= reading.lon <= 180:
        errors.append("longitude out of range")

    if not 0 <= reading.pm25 <= 1000:
        errors.append("pm25 out of sanity range")

    try:
        observed_at = parse_time(reading.observed_at)
    except ValueError as exc:
        errors.append(str(exc))
    else:
        if observed_at > now + timedelta(minutes=5):
            errors.append("timestamp is in the future")
        elif now - observed_at > timedelta(minutes=max_age_minutes):
            errors.append("reading is stale")

    return ReadingStatus(
        reading=reading,
        ok=not errors,
        errors=tuple(errors),
    )


def duplicate_keys(readings: list[SensorReading]) -> set[tuple[str, str]]:
    seen = set()
    duplicates = set()

    for reading in readings:
        key = (reading.station_id, reading.observed_at)
        if key in seen:
            duplicates.add(key)
        seen.add(key)

    return duplicates
