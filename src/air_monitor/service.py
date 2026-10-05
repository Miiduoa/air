from datetime import datetime
from statistics import median

from .geo import haversine_km
from .model import NearbyStation, ReadingStatus, SensorReading
from .quality import duplicate_keys, validate_reading


def assess(
    readings: list[SensorReading],
    now: datetime,
    max_age_minutes: int = 60,
) -> list[ReadingStatus]:
    duplicates = duplicate_keys(readings)
    statuses = []

    for reading in readings:
        status = validate_reading(
            reading,
            now=now,
            max_age_minutes=max_age_minutes,
        )
        errors = list(status.errors)

        if (reading.station_id, reading.observed_at) in duplicates:
            errors.append("duplicate station timestamp")

        statuses.append(
            ReadingStatus(
                reading=reading,
                ok=not errors,
                errors=tuple(errors),
            )
        )

    return statuses


def nearest_healthy_station(
    statuses: list[ReadingStatus],
    lat: float,
    lon: float,
) -> NearbyStation | None:
    candidates = []

    for status in statuses:
        if not status.ok:
            continue

        reading = status.reading
        distance = haversine_km(
            lat,
            lon,
            reading.lat,
            reading.lon,
        )
        candidates.append(
            NearbyStation(
                station_id=reading.station_id,
                distance_km=distance,
                pm25=reading.pm25,
                observed_at=reading.observed_at,
            )
        )

    if not candidates:
        return None

    return min(candidates, key=lambda item: item.distance_km)


def median_pm25(statuses: list[ReadingStatus]) -> float | None:
    values = [
        status.reading.pm25
        for status in statuses
        if status.ok
    ]

    if not values:
        return None

    return float(median(values))


def build_summary(
    readings: list[SensorReading],
    now: datetime,
    lat: float,
    lon: float,
    max_age_minutes: int = 60,
) -> dict:
    statuses = assess(
        readings,
        now=now,
        max_age_minutes=max_age_minutes,
    )
    nearest = nearest_healthy_station(statuses, lat=lat, lon=lon)

    return {
        "total": len(statuses),
        "healthy": sum(status.ok for status in statuses),
        "invalid": sum(not status.ok for status in statuses),
        "median_pm25": median_pm25(statuses),
        "nearest": None if nearest is None else {
            "station_id": nearest.station_id,
            "distance_km": round(nearest.distance_km, 3),
            "pm25": nearest.pm25,
            "observed_at": nearest.observed_at,
        },
        "errors": [
            {
                "station_id": status.reading.station_id,
                "errors": list(status.errors),
            }
            for status in statuses
            if not status.ok
        ],
    }
