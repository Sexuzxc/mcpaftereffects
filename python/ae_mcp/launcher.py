"""Locate After Effects, manage the bridge runtime directory, and push the
resident bridge into a running (or freshly started) AE instance."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Optional

BRIDGE_FILENAME = "ae_bridge.jsx"
HEARTBEAT_MAX_AGE_S = 6.0
AE_VERSIONS = [2026, 2025, 2024, 2023, 2022, 2021]


class LaunchError(RuntimeError):
    pass


def runtime_dir() -> Path:
    """Bridge mailbox root. Both sides must agree on this path."""
    custom = os.environ.get("AE_MCP_RUNTIME_DIR")
    if custom:
        return Path(custom)
    return Path(tempfile.gettempdir()) / "ae-mcp-bridge"


def bridge_js_path() -> Optional[Path]:
    """Find ae_bridge.jsx: env override -> repo layout -> cwd walk-up."""
    env = os.environ.get("AE_MCP_BRIDGE_JS")
    if env and Path(env).is_file():
        return Path(env)
    here = Path(__file__).resolve()
    for base in [here.parent.parent.parent,  # python/ae_mcp/x.py -> repo root
                 Path.cwd(), *Path.cwd().parents[:3]]:
        cand = base / "bridge" / BRIDGE_FILENAME
        try:
            if cand.is_file():
                return cand
        except OSError:
            continue
    return None


def find_afterfx_exe() -> Optional[Path]:
    """Locate AfterFX.exe (Windows). Env override wins, then standard paths."""
    env = os.environ.get("AE_MCP_EXE")
    if env:
        p = Path(env)
        if p.is_file():
            return p
    candidates = []
    for ver in AE_VERSIONS:
        candidates.append(Path(f"C:/Program Files/Adobe/Adobe After Effects {ver}/Support Files/AfterFX.exe"))
        candidates.append(Path(f"C:/Program Files/Adobe/Adobe After Effects {ver}/AfterFX.exe"))
    for cand in candidates:
        if cand.is_file():
            return cand
    return None


def find_aerender_exe() -> Optional[Path]:
    env = os.environ.get("AE_AERENDER")
    if env and Path(env).is_file():
        return Path(env)
    exe = find_afterfx_exe()
    if exe:
        aer = exe.parent / "aerender.exe"
        if aer.is_file():
            return aer
    for ver in AE_VERSIONS:
        cand = Path(f"C:/Program Files/Adobe/Adobe After Effects {ver}/Support Files/aerender.exe")
        if cand.is_file():
            return cand
    return None


def read_heartbeat(max_age_s: float = HEARTBEAT_MAX_AGE_S) -> Optional[dict]:
    """Return the parsed heartbeat if the bridge looks alive, else None."""
    hb = runtime_dir() / "heartbeat.json"
    try:
        if not hb.is_file():
            return None
        age = time.time() - hb.stat().st_mtime
        if age > max_age_s:
            return None
        data = json.loads(hb.read_text(encoding="utf-8", errors="replace"))
        if not isinstance(data, dict) or data.get("kind") != "ae_mcp_bridge_heartbeat":
            return None
        data["_age_s"] = round(age, 2)
        return data
    except (OSError, ValueError):
        return None


def bridge_log_tail(lines: int = 15) -> str:
    log = runtime_dir() / "bridge.log"
    try:
        if not log.is_file():
            return ""
        text = log.read_text(encoding="utf-8", errors="replace")
        return "\n".join(text.splitlines()[-lines:])
    except OSError:
        return ""


def push_bridge(wait_s: float = 25.0) -> dict:
    """Start/refresh the resident bridge by launching AfterFX.exe -r ae_bridge.jsx.

    If AE is already running, -r is forwarded to it (single instance); if it is
    not, AE starts and runs the script. Raises LaunchError on failure with a
    remediation hint.
    """
    js = bridge_js_path()
    if js is None:
        raise LaunchError(
            "ae_bridge.jsx not found. Set AE_MCP_BRIDGE_JS to its path, or run "
            "the installer (install.py) so the bridge lives in the repo."
        )
    exe = find_afterfx_exe()
    if exe is None:
        raise LaunchError(
            "AfterFX.exe not found. Set AE_MCP_EXE to the full path of "
            "'C:/Program Files/Adobe/Adobe After Effects <ver>/Support Files/AfterFX.exe'."
        )
    # fresh id so the pushed bridge instance is distinguishable in logs
    env = dict(os.environ)
    env["AE_MCP_RUNTIME_DIR"] = str(runtime_dir())
    try:
        subprocess.Popen(
            [str(exe), "-r", str(js)],
            cwd=str(exe.parent),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True,
        )
    except OSError as exc:
        raise LaunchError(f"Failed to launch AfterFX.exe: {exc}") from exc

    deadline = time.time() + wait_s
    while time.time() < deadline:
        hb = read_heartbeat(max_age_s=3600)
        if hb and hb.get("ts", 0) > time.time() * 1000 - 5000:
            return {"started": True, "heartbeat": hb}
        time.sleep(0.5)
    return {
        "started": False,
        "note": ("AfterFX.exe was launched but no heartbeat appeared in %.0fs. "
                 "If AE just cold-started it can take longer; if AE is stuck on a "
                 "dialog, dismiss it; check that 'Allow Scripts to Write Files and "
                 "Access Network' is ON in AE preferences." % wait_s),
        "log_tail": bridge_log_tail(10),
    }


def ensure_bridge_alive(auto_start: bool = True, wait_s: float = 25.0) -> dict:
    """Heartbeat present -> info dict. Otherwise try to push the bridge."""
    hb = read_heartbeat()
    if hb:
        return {"alive": True, "heartbeat": hb}
    if auto_start:
        pushed = push_bridge(wait_s=wait_s)
        hb2 = read_heartbeat()
        if hb2:
            return {"alive": True, "heartbeat": hb2, "auto_started": True}
        return {"alive": False, "push_attempt": pushed}
    return {"alive": False, "push_attempt": None}


def new_request_id() -> str:
    return f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"


def status_report() -> dict:
    rt = runtime_dir()
    hb_all = None
    hb = rt / "heartbeat.json"
    try:
        if hb.is_file():
            hb_all = json.loads(hb.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        pass
    return {
        "runtime_dir": str(rt),
        "runtime_exists": rt.is_dir(),
        "heartbeat_file_exists": hb.is_file(),
        "heartbeat_age_s": (round(time.time() - hb.stat().st_mtime, 1) if hb.is_file() else None),
        "heartbeat": hb_all,
        "bridge_js": str(bridge_js_path()) if bridge_js_path() else None,
        "afterfx_exe": str(find_afterfx_exe()) if find_afterfx_exe() else None,
        "aerender_exe": str(find_aerender_exe()) if find_aerender_exe() else None,
        "python": sys.version.split()[0],
    }
