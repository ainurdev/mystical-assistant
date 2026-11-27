"""A session started in your home folder lists on the dashboard: the sidebar files
it under Outside projects (web lib/outside), so it no longer opens a phantom "~"
project. Home itself is still no project (browser.project_exists).
Run: python -m pytest tests/test_session_list_home_folder.py -q"""

from bridge import browser, config, store
from bridge.dashboard import server as dash

store.init()
CHAT = config.DASH_CHAT_ID


def test_a_session_started_in_your_home_folder_is_listed():
    sid = store.create_session(CHAT, "~", origin="terminal")["id"]
    assert sid in [b["id"] for b in dash._sessions_payload(CHAT, "~")["sessions"]]


def test_home_is_still_no_project():
    assert not browser.project_exists("~")
