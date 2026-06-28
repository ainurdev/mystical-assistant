"""Host vitals (CPU / memory / network / load / processes) for the dashboard's
WORKSPACE panel. Uses psutil when available and degrades to a static-ish sample
otherwise so the HUD never blanks out. Network throughput is a rate computed
between successive polls, cached at module scope (the dashboard polls ~2s)."""

import os
import socket
import time

try:
    import psutil  # type: ignore
    _HAVE = True
except Exception:  # noqa: BLE001 — psutil optional
    psutil = None  # type: ignore
    _HAVE = False

# Last (timestamp, bytes_sent, bytes_recv) sample for rate calculation.
_net: tuple[float, int, int] | None = None
_host = socket.gethostname().split(".")[0] or "host"
_cpu_primed = False


def _cpu_percent() -> float:
    """System-wide CPU utilization (%) read from the OS's own counters via psutil
    (/proc/stat on Linux/WSL, the equivalent elsewhere). `interval=None` reports
    usage since the previous call, so it's accurate for our ~2s polling — but its
    very first call returns a misleading 0, so we take one short blocking sample to
    seed it. The result is whole-machine load: one fully-busy core of N reads ~100/N%."""
    global _cpu_primed
    try:
        if not _cpu_primed:
            _cpu_primed = True
            return float(psutil.cpu_percent(interval=0.1))
        return float(psutil.cpu_percent(interval=None))
    except Exception:  # noqa: BLE001
        return 0.0


def _net_rates() -> tuple[float, float]:
    """Up/down throughput in KB/s since the previous call (0 on first call)."""
    global _net
    if not _HAVE:
        return 0.0, 0.0
    try:
        io = psutil.net_io_counters()
    except Exception:  # noqa: BLE001
        return 0.0, 0.0
    now = time.time()
    up = down = 0.0
    if _net is not None:
        dt = max(0.001, now - _net[0])
        up = max(0.0, (io.bytes_sent - _net[1]) / dt / 1024.0)
        down = max(0.0, (io.bytes_recv - _net[2]) / dt / 1024.0)
    _net = (now, io.bytes_sent, io.bytes_recv)
    return up, down


def host_stats() -> dict:
    if not _HAVE:
        return {"available": False, "host": _host, "cpu": 0, "mem_used": 0.0,
                "mem_total": 0.0, "mem_pct": 0, "net_up": 0.0, "net_down": 0.0,
                "load": 0.0, "procs": 0, "state": "NOMINAL"}
    cpu = _cpu_percent()
    try:
        vm = psutil.virtual_memory()
        mem_used = round(vm.used / 1024 ** 3, 1)
        mem_total = round(vm.total / 1024 ** 3, 1)
        mem_pct = int(vm.percent)
    except Exception:  # noqa: BLE001
        mem_used = mem_total = 0.0
        mem_pct = 0
    up, down = _net_rates()
    try:
        load = round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        load = round(cpu / 100.0 * (os.cpu_count() or 1), 2)
    try:
        procs = len(psutil.pids())
    except Exception:  # noqa: BLE001
        procs = 0
    busy = cpu > 85
    return {"available": True, "host": _host, "cpu": int(round(cpu)),
            "mem_used": mem_used, "mem_total": mem_total, "mem_pct": mem_pct,
            "net_up": round(up, 1), "net_down": round(down, 1), "load": load,
            "procs": procs, "state": "BUSY" if busy else "NOMINAL"}
