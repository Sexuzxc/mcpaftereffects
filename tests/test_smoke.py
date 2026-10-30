"""End-to-end smoke test for the Python MCP server - no After Effects needed.

A fake bridge thread emulates the AE side of the mailbox protocol, the MCP
server is spawned as a real subprocess, and an MCP client drives it over
stdio. Run:  python tests/test_smoke.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = str(Path(REPO) / "python")

sys.path.insert(0, PY)


class FakeBridge:
    """Emulates ae_bridge.jsx: consumes requests, writes responses."""

    def __init__(self, runtime: Path, delay_s: float = 0.0):
        self.runtime = runtime
        self.delay_s = delay_s
        self.fail_tools: set[str] = set()
        self.stop = threading.Event()
        self.served = 0
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        (self.runtime / "commands").mkdir(parents=True, exist_ok=True)
        (self.runtime / "results").mkdir(parents=True, exist_ok=True)
        hb = {
            "kind": "ae_mcp_bridge_heartbeat", "id": "fake-bridge", "version": 1,
            "ae_version": "99.0 (fake)", "project": None, "project_name": None,
            "dirty": False, "num_items": 0, "started_at": time.time() * 1000,
            "uptime_s": 0, "ticks": 0, "served": 0, "busy": False,
            "busy_since": None, "last_error": None, "security_pref": True,
            "runtime_dir": str(self.runtime), "ts": time.time() * 1000,
        }
        (self.runtime / "heartbeat.json").write_text(json.dumps(hb), encoding="utf-8")
        self.thread.start()

    def _loop(self):
        while not self.stop.is_set():
            folder = self.runtime / "commands"
            files = sorted(folder.glob("request-*.json"))
            for f in files:
                time.sleep(self.delay_s)
                body = json.loads(f.read_text(encoding="utf-8"))
                f.unlink()
                if body.get("tool") in self.fail_tools:
                    resp = {"ok": False, "id": f.name, "error": {"code": "TOOL_ERROR", "message": "emulated failure"}}
                else:
                    resp = {"ok": True, "id": f.name,
                            "result": {"tool": body.get("tool"), "args": body.get("args"), "fake": True}}
                out = self.runtime / "results" / f.name.replace("request-", "response-")
                tmp = out.with_suffix(".tmp")
                tmp.write_text(json.dumps(resp), encoding="utf-8")
                tmp.replace(out)
                self.served += 1
            time.sleep(0.05)


async def run_client(fake):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "ae_mcp", "--no-auto-start"],
        cwd=str(PY),
        env={**os.environ},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {t.name for t in tools.tools}
            print(f"[test] listed {len(names)} tools")

            assert "comp_create" in names, "comp_create must be listed"
            assert "aerender_render" in names, "aerender_render must be listed"
            assert "run_script" not in names, "run_script must be hidden without AE_MCP_ENABLE_EVAL"

            res = await session.call_tool("ping", {})
            data = json.loads(res.content[0].text)
            assert data["ok"] and data["result"]["tool"] == "ping", data
            print("[test] ping OK")

            res = await session.call_tool("comp_create", {"name": "Intro", "width": 1920, "height": 1080})
            data = json.loads(res.content[0].text)
            assert data["ok"] and data["result"]["args"]["name"] == "Intro", data
            print("[test] comp_create OK")

            res = await session.call_tool("run_script", {"code": "return 1;"})
            data = json.loads(res.content[0].text)
            assert not data["ok"] and data["error"]["code"] == "EVAL_DISABLED", data
            print("[test] run_script correctly gated ->", data["error"]["code"])

            fake.fail_tools.add("comp_info")
            res = await session.call_tool("comp_info", {})
            data = json.loads(res.content[0].text)
            assert not data["ok"] and data["error"]["code"] == "TOOL_ERROR", data
            fake.fail_tools.discard("comp_info")
            print("[test] tool error propagated ->", data["error"]["message"])

            res = await session.call_tool("nonexistent_tool", {})
            data = json.loads(res.content[0].text)
            assert not data["ok"] and data["error"]["code"] == "UNKNOWN_TOOL", data
            print("[test] unknown tool handled")


async def run_readonly_check():
    """Second server instance with AE_MCP_READONLY=1: mutating tools hidden."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    env = {**os.environ, "AE_MCP_READONLY": "1"}
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "ae_mcp", "--no-auto-start"],
        cwd=str(PY), env=env,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = {t.name for t in tools.tools}
            assert "comp_create" not in names, "read-only must hide comp_create"
            assert "ping" in names and "help_bridge" in names
            print(f"[test] read-only mode lists {len(names)} tools (mutating hidden)")


async def main():
    with tempfile.TemporaryDirectory(prefix="ae-mcp-test-") as tmp:
        runtime = Path(tmp)
        os.environ["AE_MCP_RUNTIME_DIR"] = str(runtime)
        fake = FakeBridge(runtime)
        fake.start()
        try:
            await run_client(fake)
        finally:
            fake.stop.set()
    await run_readonly_check()
    print("[test] ALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
