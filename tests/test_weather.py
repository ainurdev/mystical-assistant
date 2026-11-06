"""bridge/weather.py through its public calls, against a fake open-meteo.

The fake answers like the real service: daily fields only when the URL asks for
them, geocoding matches up to the requested count. _CFG points at a temp file so
nothing here touches ~/.mystical/weather.json."""

import json
import urllib.parse

import pytest

from bridge import weather

FORECAST = {
    "timezone": "Asia/Yerevan",
    "current": {"temperature_2m": 11.3, "relative_humidity_2m": 80, "weather_code": 3, "wind_speed_10m": 12.4},
    "daily": {
        "time": ["2026-11-06"],
        "temperature_2m_max": [14.2],
        "temperature_2m_min": [6.8],
        "sunrise": ["2026-11-06T07:12"],
        "sunset": ["2026-11-06T17:21"],
    },
}

PLACES = [
    {"name": "Amsterdam", "admin1": "North Holland", "country_code": "NL", "latitude": 52.374, "longitude": 4.889},
    {"name": "Amsterdam", "admin1": "New York", "country_code": "US", "latitude": 42.938, "longitude": -74.188},
    {"name": "Amstetten", "admin1": "Lower Austria", "country_code": "AT", "latitude": 48.122, "longitude": 14.872},
]


def _service(url: str) -> dict:
    u = urllib.parse.urlparse(url)
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    if u.netloc.startswith("geocoding-api"):
        hits = [p for p in PLACES if p["name"].lower().startswith(q["name"].lower())]
        return {"results": hits[: int(q["count"])]} if hits else {"generationtime_ms": 0.3}
    asked = q["daily"].split(",")
    daily = {k: v for k, v in FORECAST["daily"].items() if k == "time" or k in asked}
    return {**FORECAST, "daily": daily}


@pytest.fixture
def wx(tmp_path, monkeypatch):
    monkeypatch.setattr(weather, "_CFG", str(tmp_path / "weather.json"))
    monkeypatch.setattr(weather, "_get_json", lambda url, timeout=8: _service(url))
    monkeypatch.setattr(weather, "_loc", {"lat": 40.18, "lon": 44.51, "place": "YEREVAN, AM", "unit": "celsius"})
    monkeypatch.setattr(weather, "_cache", None)
    monkeypatch.setattr(weather, "_cache_at", 0.0)
    return weather


def test_current_weather_carries_sunrise_and_sunset(wx):
    w = wx.current()
    assert (w["sunrise"], w["sunset"]) == ("07:12", "17:21")
    assert (w["hi"], w["lo"], w["temp"]) == (14, 7, 11)
    # sunrise and sunset are the place's own clock, so the page needs the place's zone to set "now" against them
    assert w["tz"] == "Asia/Yerevan"


def test_search_lists_every_matching_place(wx):
    assert wx.search("amster") == {"results": [
        {"name": "Amsterdam, North Holland, NL", "lat": 52.374, "lon": 4.889},
        {"name": "Amsterdam, New York, US", "lat": 42.938, "lon": -74.188},
    ]}


def test_search_says_when_the_geocoder_is_unreachable(wx, monkeypatch):
    def down(url, timeout=8):
        raise OSError("network down")
    monkeypatch.setattr(wx, "_get_json", down)
    assert "network down" in wx.search("amster")["error"]
    assert wx.search("   ") == {"results": []}


def test_a_picked_place_becomes_the_weather_location(wx):
    w = wx.set_place(52.374, 4.889, "Amsterdam, North Holland, NL")
    assert (w["available"], w["loc"]) == (True, "Amsterdam, North Holland, NL")
    with open(wx._CFG) as f:
        assert json.load(f)["lat"] == 52.374


def test_a_place_that_is_not_a_place_is_refused(wx):
    for lat, lon, name in ((95, 4.9, "Nowhere"), ("x", 4.9, "Nowhere"), (52.3, 181, "Nowhere"), (52.3, 4.9, "  ")):
        assert "error" in wx.set_place(lat, lon, name), (lat, lon, name)
    assert wx.current()["loc"] == "YEREVAN, AM"
