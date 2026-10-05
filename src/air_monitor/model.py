from dataclasses import dataclass


@dataclass(frozen=True)
class SensorReading:
    station_id: str
    lat: float
    lon: float
    pm25: float
    observed_at: str


@dataclass(frozen=True)
class ReadingStatus:
    reading: SensorReading
    ok: bool
    errors: tuple[str, ...]


@dataclass(frozen=True)
class NearbyStation:
    station_id: str
    distance_km: float
    pm25: float
    observed_at: str
