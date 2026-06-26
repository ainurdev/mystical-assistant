"""Current weather for the WORKSPACE panel via the free open-meteo API (no key).
Location comes from WEATHER_LAT/WEATHER_LON/WEATHER_PLACE env (defaults to San
Francisco). Cached ~10 min; degrades to {available: False} on any failure so the
HUD shows a graceful placeholder instead of breaking."""

import json
import os
import time
import urllib.parse
import urllib.request

LAT = float(os.environ.get("WEATHER_LAT", "37.7749"))
LON = float(os.environ.get("WEATHER_LON", "-122.4194"))
PLACE = os.environ.get("WEATHER_PLACE", "SAN FRANCISCO")
_TTL = 600  # seconds

# WMO weather-code → short condition label.
_CODES = {
    0: "CLEAR", 1: "MAINLY CLEAR", 2: "PARTLY CLOUDY", 3: "OVERCAST",
    45: "FOG", 48: "RIME FOG", 51: "LIGHT DRIZZLE", 53: "DRIZZLE",
    55: "DENSE DRIZZLE", 56: "FREEZING DRIZZLE", 57: "FREEZING DRIZZLE",
    61: "LIGHT RAIN", 63: "RAIN", 65: "HEAVY RAIN", 66: "FREEZING RAIN",
    67: "FREEZING RAIN", 71: "LIGHT SNOW", 73: "SNOW", 75: "HEAVY SNOW",
    77: "SNOW GRAINS", 80: "RAIN SHOWERS", 81: "RAIN SHOWERS",
    82: "HEAVY SHOWERS", 85: "SNOW SHOWERS", 86: "SNOW SHOWERS",
    95: "THUNDERSTORM", 96: "THUNDERSTORM", 99: "HAIL STORM",
}

_cache: dict | None = None
_cache_at = 0.0


def _fetch() -> dict:
    qs = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON,
        "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min",
        "timezone": "auto", "forecast_days": 1,
    })
    url = f"https://api.open-meteo.com/v1/forecast?{qs}"
    with urllib.request.urlopen(url, timeout=8) as r:  # noqa: S310 — fixed host
        data = json.loads(r.read().decode())
    cur = data.get("current", {})
    daily = data.get("daily", {})
    code = int(cur.get("weather_code", 0))
    hi = (daily.get("temperature_2m_max") or [None])[0]
    lo = (daily.get("temperature_2m_min") or [None])[0]
    return {
        "available": True,
        "temp": round(cur.get("temperature_2m", 0)),
        "cond": _CODES.get(code, "—"),
        "hi": round(hi) if hi is not None else None,
        "lo": round(lo) if lo is not None else None,
        "wind": f"{round(cur.get('wind_speed_10m', 0))} km/h",
        "hum": f"{round(cur.get('relative_humidity_2m', 0))}%",
        "loc": PLACE,
    }


def current() -> dict:
    global _cache, _cache_at
    now = time.time()
    if _cache is not None and now - _cache_at < _TTL:
        return _cache
    try:
        _cache = _fetch()
        _cache_at = now
    except Exception:  # noqa: BLE001 — network/parse: serve stale or empty
        if _cache is None:
            _cache = {"available": False, "temp": None, "cond": "OFFLINE",
                      "hi": None, "lo": None, "wind": "—", "hum": "—",
                      "loc": PLACE}
        _cache_at = now
    return _cache
