"""bin/bridge-snapshot: a probe's copy of the live data comes with its settings."""
import os
import sqlite3
import stat
import subprocess
import sys

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "bin", "bridge-snapshot")


def _run(live_db, out):
    env = dict(os.environ, BRIDGE_DB=str(live_db))
    return subprocess.run([sys.executable, SCRIPT, str(out)], env=env,
                          capture_output=True, text=True)


def _live(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    db = state / "bridge.db"
    con = sqlite3.connect(db)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE t (x)")
    con.execute("INSERT INTO t VALUES (42)")
    con.commit()  # left open: the row sits in the WAL, as on a running bridge
    for name in ("experimental.json", "env_settings.json", "rivendell_instances.json",
                 "run-api.json", "sessions_list.json"):
        (state / name).write_text("{}")
    os.chmod(state / "env_settings.json", 0o600)
    return db, con


def test_a_snapshot_copies_the_db_and_settings_but_not_live_handles(tmp_path):
    db, con = _live(tmp_path)
    out = tmp_path / "snap"
    r = _run(db, out)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == f"BRIDGE_DB={out / 'bridge.db'}"
    assert sqlite3.connect(out / "bridge.db").execute("SELECT x FROM t").fetchall() == [(42,)]
    assert sorted(p.name for p in out.glob("*.json")) == ["env_settings.json", "experimental.json"]
    assert stat.S_IMODE(os.stat(out / "env_settings.json").st_mode) == 0o600
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o700
    # a second run over the same DIR overwrites
    assert _run(db, out).returncode == 0
    con.close()


def test_it_refuses_to_write_over_the_live_state_folder(tmp_path):
    db, con = _live(tmp_path)
    r = _run(db, db.parent)
    assert r.returncode != 0 and "live" in r.stderr
    assert sqlite3.connect(db).execute("SELECT x FROM t").fetchall() == [(42,)]
    con.close()


def test_a_missing_source_leaves_the_old_snapshot_alone(tmp_path):
    db, con = _live(tmp_path)
    out = tmp_path / "snap"
    assert _run(db, out).returncode == 0
    r = _run(tmp_path / "gone" / "bridge.db", out)
    assert r.returncode != 0 and "no database" in r.stderr
    assert (out / "bridge.db").exists()
    con.close()


def test_an_existing_dir_keeps_its_mode(tmp_path):
    db, con = _live(tmp_path)
    out = tmp_path / "mine"
    out.mkdir(mode=0o755)
    assert _run(db, out).returncode == 0
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o755
    con.close()
