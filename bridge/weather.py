"""Current weather for the dashboard's Clock and its Almanac via the free open-meteo
API (no key).

Location defaults to WEATHER_LAT/WEATHER_LON/WEATHER_PLACE env (San Francisco) but
can be changed at runtime from SETTINGS ▸ CLOCK & WEATHER: search() lists the
places a typed name matches and set_place() switches to the one picked, by its
coordinates, so the place you clicked is the place you get (no second geocode).
It persists to ~/.mystical/weather.json. Cached ~10 min; degrades to
{available: False} on any failure so the HUD shows a graceful placeholder."""

import json
import os
import time
import urllib.parse
import urllib.request

from bridge import reports

_CFG = os.path.expanduser("~/.mystical/weather.json")
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


def _norm_unit(u: str) -> str:
    u = (u or "").strip().lower()
    if u in ("f", "fahrenheit", "imperial"):
        return "fahrenheit"
    return "celsius"


def _load() -> dict:
    """Saved location overrides the env defaults."""
    loc = {
        "lat": float(os.environ.get("WEATHER_LAT", "37.7749")),
        "lon": float(os.environ.get("WEATHER_LON", "-122.4194")),
        "place": os.environ.get("WEATHER_PLACE", "SAN FRANCISCO"),
        "unit": _norm_unit(os.environ.get("WEATHER_UNIT", "celsius")),
    }
    try:
        with open(_CFG) as f:
            saved = json.load(f)
        loc.update({k: saved[k] for k in ("lat", "lon", "place", "unit") if k in saved})
    except (OSError, ValueError, KeyError):
        pass
    loc["unit"] = _norm_unit(loc["unit"])
    return loc


_loc = _load()
_cache: dict | None = None
_cache_at = 0.0


def _save() -> None:
    try:
        os.makedirs(os.path.dirname(_CFG), exist_ok=True)
        with open(_CFG, "w") as f:
            json.dump(_loc, f)
    except OSError:
        pass


def _get_json(url: str, timeout: int = 8):
    with reports.outside(), urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 — fixed host
        return json.loads(r.read().decode())


def _fetch() -> dict:
    imperial = _loc.get("unit") == "fahrenheit"
    qs = urllib.parse.urlencode({
        "latitude": _loc["lat"], "longitude": _loc["lon"],
        "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,sunrise,sunset",
        "timezone": "auto", "forecast_days": 1,
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
    })
    data = _get_json(f"https://api.open-meteo.com/v1/forecast?{qs}")
    cur = data.get("current", {})
    daily = data.get("daily", {})
    code = int(cur.get("weather_code", 0))
    hi = (daily.get("temperature_2m_max") or [None])[0]
    lo = (daily.get("temperature_2m_min") or [None])[0]
    # "2026-11-06T07:12", in the place's own time (timezone=auto) -> "07:12"
    sun = {k: ((daily.get(k) or [None])[0] or "")[11:16] or None for k in ("sunrise", "sunset")}
    return {
        "available": True,
        "temp": round(cur.get("temperature_2m", 0)),
        "cond": _CODES.get(code, "—"),
        "hi": round(hi) if hi is not None else None,
        "lo": round(lo) if lo is not None else None,
        "wind": f"{round(cur.get('wind_speed_10m', 0))} {'mph' if imperial else 'km/h'}",
        "hum": f"{round(cur.get('relative_humidity_2m', 0))}%",
        "unit": "F" if imperial else "C",
        "loc": _loc["place"],
        **sun,
        "tz": data.get("timezone"),  # the place's IANA zone: sunrise/sunset are on its clock
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
                      "sunrise": None, "sunset": None, "tz": None,
                      "unit": "F" if _loc.get("unit") == "fahrenheit" else "C",
                      "loc": _loc["place"]}
        _cache_at = now
    return _cache


def _label(r: dict) -> str:
    """A geocoder match as people read it: "Amsterdam, North Holland, NL"."""
    return ", ".join(x for x in (r.get("name"), r.get("admin1"), r.get("country_code")) if x)


def search(name: str, count: int = 6) -> dict:
    """Places matching a typed name, best first, for the dashboard's city picker:
    {results: [{name, lat, lon}]}, or {error} when the geocoder can't be reached."""
    name = (name or "").strip()
    if not name:
        return {"results": []}
    try:
        data = _get_json("https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode(
            {"name": name, "count": count, "language": "en", "format": "json"}))
        return {"results": [{"name": _label(r), "lat": float(r["latitude"]), "lon": float(r["longitude"])}
                            for r in data.get("results") or []]}
    except Exception as e:  # noqa: BLE001 — network/parse: the picker says so
        return {"error": f"geocoding failed: {e}"}


def set_place(lat, lon, name) -> dict:
    """Switch the weather to a place the picker offered (search's {name, lat, lon}),
    without geocoding again, so the place you clicked is the place you get."""
    global _cache, _cache_at
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return {"error": "not a place"}
    label = str(name or "").strip()[:120]
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or not label:
        return {"error": "not a place"}
    _loc.update({"lat": lat, "lon": lon, "place": label})  # its own case: "McAllen" isn't "MCALLEN"
    _save()
    _cache = None
    _cache_at = 0.0
    return current()


def set_unit(unit: str) -> dict:
    """Switch the temperature/wind units ('celsius'|'metric' or 'fahrenheit'|
    'imperial') and refetch. Persists to ~/.mystical/weather.json."""
    global _cache, _cache_at
    _loc["unit"] = _norm_unit(unit)
    _save()
    _cache = None
    _cache_at = 0.0
    return current()
