"""The Mini App's CHATS screen draws projects the way the dashboard's sidebar
does, so /api/projects carries the same names, marks and hidden list as
/local/projects, and a project logo is served (behind init-data) by its hash.
Run: python tests/test_miniapp_projects.py"""

import os
import subprocess

from bridge import config, project_config, projectmarks
from bridge.miniapp import server as mini


def _handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send_bytes = lambda data, code, ctype, cache="no-cache": box.update(data=data, code=code, ctype=ctype)
    return h, box


def test_projects_listing_carries_names_marks_hidden():
    repo = os.path.join(config.BASE_PATH, "tile-repo")
    os.makedirs(repo, exist_ok=True)
    subprocess.run(["git", "init", "-q", repo], check=True)
    h, box = _handler()
    h._api_projects({})
    js = box["obj"]
    assert "/tile-repo" in js["projects"]
    assert js["names"] == project_config.names()
    assert js["hidden"] == project_config.hidden_projects()
    assert js["marks"] == projectmarks.marks(js["projects"])


def test_logo_route_refuses_what_is_not_a_logo_name():
    h, box = _handler()
    h._api_project_logo("../../etc/passwd")
    assert box["code"] == 404
    h, box = _handler()
    h._api_project_logo("0" * 64 + ".png")   # well-formed, never stored
    assert box["code"] == 404


if __name__ == "__main__":
    test_projects_listing_carries_names_marks_hidden()
    test_logo_route_refuses_what_is_not_a_logo_name()
    print("ok")
