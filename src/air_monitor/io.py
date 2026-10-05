import json
from pathlib import Path

from .model import SensorReading


def load_jsonl(path: str | Path) -> list[SensorReading]:
    readings = []
    source = Path(path)

    with source.open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, start=1):
            if not raw.strip():
                continue

            try:
                payload = json.loads(raw)
                readings.append(SensorReading(**payload))
            except (json.JSONDecodeError, TypeError) as exc:
                raise ValueError(
                    f"{source}:{line_number}: invalid reading: {exc}"
                ) from exc

    return readings
