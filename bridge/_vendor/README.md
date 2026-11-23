# Vendored: Sentry's Python SDK

Third-party code, pure Python, put on `sys.path` only by `bridge/reports.py`
on a team install (ADR 0005). Every other install never imports it.

| package    | version    |
|------------|------------|
| sentry-sdk | 3.0.0      |
| urllib3    | 2.8.0      |
| certifi    | 2026.11.20 |

All three import on Python 3.10 (`tests/test_reports.py` sends through them
under 3.10 when one is installed: `uv python install 3.10`).

## Refresh

From the repo root:

```sh
rm -rf bridge/_vendor/{sentry_sdk,urllib3,certifi}*
uv pip install --python-version 3.10 --no-deps --target bridge/_vendor sentry-sdk urllib3 certifi
find bridge/_vendor -name __pycache__ -prune -exec rm -rf {} +
```

Then update the table above and run `python3 -m pytest tests/test_reports.py -q`.
Check no `.so` came in (`find bridge/_vendor -name '*.so'`): the folder must stay
pure Python to run on every platform the bridge does.
