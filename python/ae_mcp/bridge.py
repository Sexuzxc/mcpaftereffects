"""File-based mailbox client for the resident ExtendScript bridge.

Protocol (see bridge/ae_bridge.jsx header):
  write  <runtime>/commands/request-<ts>-<id>.json   {tool, args, undo_group, ...}
  poll   <runtime>/results/response-<id>.json        {ok, result|error, meta}
The AE side consumes the request before running it and writes exactly one
response per id, so calls are correlated and nothing is lost or replayed.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Optional

from . import launcher


class BridgeError(RuntimeError):
    def __init__(self, message: str, code: str = "BRIDGE_ERROR", hint: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


class BridgeClient:
    """Synchronous client; the MCP server wraps calls in a worker thread."""

    def __init__(self, default_timeout_s: float = 30.0, auto_start: bool = True):
        self.default_timeout_s = default_timeout_s
        self.auto_start = auto_start
        self._lock = threading.Lock()  # AE executes one script at a time

    # ------------------------------------------------------------------ io

    def _write_request(self, tool: str, args: dict, undo_group: bool = True,
                       suppress_dialogs: bool = True) -> tuple[str, float]:
        rt = launcher.runtime_dir()
        commands = rt / "commands"
        results = rt / "results"
        commands.mkdir(parents=True, exist_ok=True)
        results.mkdir(parents=True, exist_ok=True)
        rid = launcher.new_request_id()
        body = {
            "tool": tool,
            "args": args,
            "ts": time.time(),
            "undo_group": undo_group,
            "suppress_dialogs": suppress_dialogs,
        }
        path = commands / f"request-{rid}.json"  # ts prefix => lexicographic age
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        return rid, time.monotonic()

    def _read_response(self, rid: str) -> Optional[dict]:
        path = launcher.runtime_dir() / "results" / f"response-{rid}.json"
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        if not text.strip():
            return None  # atomic write still in progress
        try:
            data = json.loads(text)
        except ValueError:
            return None  # writer mid-write despite the .tmp dance
        try:
            path.unlink()
        except OSError:
            pass
        return data

    # ---------------------------------------------------------------- call

    def call(self, tool: str, args: Optional[dict] = None,
             timeout_s: Optional[float] = None,
             undo_group: bool = True, suppress_dialogs: bool = True) -> dict:
        args = dict(args or {})
        timeout = float(timeout_s or self.default_timeout_s)
        # per-tool arg override
        if isinstance(args.get("timeout_s"), (int, float)) and args["timeout_s"] > 0:
            timeout = float(args["timeout_s"])

        with self._lock:
            alive = launcher.ensure_bridge_alive(auto_start=self.auto_start)
            if not alive.get("alive") and tool not in ("help_bridge",):
                push = alive.get("push_attempt") or {}
                note = push.get("note") or ""
                hint = ("1) Is After Effects running? 2) Preferences > Scripting & "
                        "Expressions > 'Allow Scripts to Write Files and Access Network' "
                        "must be ON. 3) Install the bridge (install.py) or rely on "
                        "auto-start. 4) Dismiss any modal dialog blocking AE.")
                detail = push.get("log_tail")
                raise BridgeError(
                    f"After Effects bridge is not responding. {note}".strip(),
                    code="BRIDGE_NOT_ALIVE",
                    hint=hint + (f"\nbridge.log tail:\n{detail}" if detail else ""),
                )

            rid, started = self._write_request(tool, args, undo_group, suppress_dialogs)
            deadline = started + timeout
            delay = 0.05
            while time.monotonic() < deadline:
                resp = self._read_response(rid)
                if resp is not None:
                    break
                time.sleep(delay)
                delay = min(delay * 1.3, 0.25)
            else:
                raise BridgeError(
                    f"Timed out after {timeout:.0f}s waiting for '{tool}'. AE may be "
                    "busy (long render), blocked by a modal dialog, or the bridge is "
                    "not loaded.",
                    code="TIMEOUT",
                    hint="Try again with a larger timeout_s; check bridge.log in the "
                         "runtime dir; use render_queue_control action=stop to abort a "
                         "stuck render.",
                )

        if resp.get("ok"):
            return resp.get("result")
        err = resp.get("error") or {}
        raise BridgeError(
            str(err.get("message", "Unknown bridge error")),
            code=str(err.get("code", "TOOL_ERROR")),
        )

    # ------------------------------------------------------- local tools

    def call_local(self, tool: str, args: dict) -> dict:
        """Tools served by the MCP server itself (no AE round-trip)."""
        if tool == "help_bridge":
            from .server import BRIDGE_HELP  # avoid cycle
            return BRIDGE_HELP
        raise BridgeError(f"Tool '{tool}' is not served locally", code="UNKNOWN_TOOL")

    def aerender_render(self, args: dict) -> dict:
        """aerender_render runs OUTSIDE AE as a subprocess."""
        exe = launcher.find_aerender_exe()
        if exe is None:
            raise BridgeError(
                "aerender.exe not found. Set AE_AERENDER or AE_MCP_EXE.",
                code="AERENDER_NOT_FOUND",
            )
        project = args.get("project_path")
        if not project:
            hb = launcher.read_heartbeat(max_age_s=3600)
            if hb and hb.get("project"):
                project = hb["project"]
            else:
                raise BridgeError("No project_path given and no open project known.",
                                  code="BAD_ARGS")
        cmd = [str(exe), "-project", str(project)]
        comp = args.get("comp")
        if comp not in (None, ""):
            cmd += ["-comp", str(comp)]
        if args.get("output_template"):
            cmd += ["-OMtemplate", str(args["output_template"])]
        if args.get("render_settings_template"):
            cmd += ["-RStemplate", str(args["render_settings_template"])]
        output = args.get("output_path")
        if output:
            cmd += ["-output", str(output)]
        if args.get("start_frame") is not None:
            cmd += ["-s", str(int(args["start_frame"]))]
        if args.get("end_frame") is not None:
            cmd += ["-e", str(int(args["end_frame"]))]
        timeout = float(args.get("timeout_s") or 3600)
        started = time.time()
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=timeout, cwd=str(exe.parent))
            code, out, err = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as exc:
            raise BridgeError(f"aerender timed out after {timeout:.0f}s",
                              code="TIMEOUT") from exc
        tail = "\n".join((out or "").splitlines()[-25:])
        return {
            "exit_code": code,
            "duration_s": round(time.time() - started, 1),
            "command": cmd,
            "stdout_tail": tail,
            "stderr_tail": "\n".join((err or "").splitlines()[-10:]),
            "success": code == 0,
        }
