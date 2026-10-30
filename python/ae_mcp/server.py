"""The MCP server: exposes registry/tools.json as MCP tools and forwards every
call through the mailbox bridge to After Effects.

Transports:
  stdio (default)                 ae-mcp
  streamable HTTP                 ae-mcp --http --host 127.0.0.1 --port 8678

Environment:
  AE_MCP_RUNTIME_DIR   mailbox root (must match the bridge's)
  AE_MCP_EXE           path to AfterFX.exe (auto-start)
  AE_MCP_BRIDGE_JS     path to ae_bridge.jsx (auto-start)
  AE_AERENDER          path to aerender.exe
  AE_MCP_READONLY      1 = hide all mutating tools (audit mode)
  AE_MCP_ENABLE_EVAL   1 = expose run_script (arbitrary ExtendScript)
  AE_MCP_TIMEOUT       default per-call timeout seconds (default 30)
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import json
import os
import sys
from importlib import resources
from pathlib import Path
from typing import Any

import anyio
import anyio.to_thread
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from . import __version__, launcher
from .bridge import BridgeClient, BridgeError

BRIDGE_HELP = {
    "bridge": "ae_bridge.jsx resident ExtendScript bridge",
    "how_it_works": [
        "The MCP server writes commands/request-<id>.json into the mailbox.",
        "The resident bridge inside After Effects consumes them every 250 ms,",
        "runs each tool inside one undo group with dialogs suppressed, and",
        "writes results/response-<id>.json back.",
    ],
    "install_steps": [
        "1. AE Preferences > Scripting & Expressions > enable 'Allow Scripts to "
        "Write Files and Access Network', then restart AE.",
        "2. Run the installer (install.py) to copy the bridge into "
        "%APPDATA%\\Adobe\\After Effects <ver>\\Scripts\\Startup (auto-start).",
        "3. Or call any tool: the server pushes the bridge via AfterFX.exe -r.",
    ],
    "troubleshooting": [
        "ping fails, no heartbeat.json -> AE not running or bridge not loaded.",
        "All tools time out -> security preference OFF, or a modal dialog blocks AE.",
        "Read <runtime>/bridge.log for the AE-side log.",
    ],
    "status": launcher.status_report(),
}

# Tools served by the MCP process itself (no AE round-trip).
LOCAL_TOOLS = {"help_bridge", "aerender_render"}
# Longer timeouts per tool (seconds), overridable per-call via timeout_s arg.
TOOL_TIMEOUTS = {
    "run_script": 120.0,
    "project_open": 180.0,
    "project_import_file": 120.0,
    "project_new": 120.0,
    "render_start": 1800.0,
    "frame_render": 120.0,
}

DEFAULT_REGISTRY = Path(__file__).resolve().parent.parent / "registry" / "tools.json"
if not DEFAULT_REGISTRY.is_file():
    # installed layout fallback
    alt = Path(__file__).resolve().parent.parent.parent / "registry" / "tools.json"
    DEFAULT_REGISTRY = alt


def load_registry(path: str | os.PathLike | None = None) -> list[dict]:
    reg = Path(path) if path else DEFAULT_REGISTRY
    if not reg.is_file():
        raise SystemExit(
            f"registry/tools.json not found at {reg}. Run "
            "`python registry/generate_registry.py` or pass --registry."
        )
    data = json.loads(reg.read_text(encoding="utf-8"))
    return data["tools"]


def tool_timeout(name: str, args: dict) -> float | None:
    if isinstance(args.get("timeout_s"), (int, float)) and args["timeout_s"] > 0:
        return float(args["timeout_s"])
    return TOOL_TIMEOUTS.get(name)


class AeMcpServer:
    def __init__(self, registry_path: str | os.PathLike | None = None,
                 read_only: bool | None = None, enable_eval: bool | None = None,
                 auto_start: bool = True):
        self.tools = load_registry(registry_path)
        self.read_only = read_only if read_only is not None else \
            os.environ.get("AE_MCP_READONLY", "").strip() in ("1", "true", "yes")
        self.enable_eval = enable_eval if enable_eval is not None else \
            os.environ.get("AE_MCP_ENABLE_EVAL", "").strip() in ("1", "true", "yes")
        self.bridge = BridgeClient(
            default_timeout_s=float(os.environ.get("AE_MCP_TIMEOUT", "30") or 30),
            auto_start=auto_start,
        )
        self.server = Server("after-effects-mcp")
        self._register_handlers()

    # ------------------------------------------------------------- toolset

    def visible_tools(self) -> list[dict]:
        out = []
        for t in self.tools:
            name = t["name"]
            if name in LOCAL_TOOLS:
                pass  # always available
            elif name == "run_script" and not self.enable_eval:
                continue
            elif name != "help_bridge" and self.read_only and t.get("mutating", True):
                continue
            out.append(t)
        return out

    def _mcp_tools(self) -> list[Tool]:
        return [
            Tool(
                name=t["name"],
                title=t.get("title"),
                description=t["description"],
                inputSchema=t["inputSchema"],
            )
            for t in self.visible_tools()
        ]

    def _tool_spec(self, name: str) -> dict | None:
        for t in self.tools:
            if t["name"] == name:
                return t
        return None

    # ------------------------------------------------------------ dispatch

    async def _call_tool(self, name: str, args: dict) -> dict:
        spec = self._tool_spec(name)
        if spec is None:
            raise BridgeError(f"Unknown tool '{name}'", code="UNKNOWN_TOOL")
        if name != "help_bridge" and self.read_only and spec.get("mutating", True):
            raise BridgeError(
                f"Server is in read-only mode (AE_MCP_READONLY=1); '{name}' mutates "
                "the project and was not executed.",
                code="READ_ONLY",
            )
        if name == "help_bridge":
            return BRIDGE_HELP
        if name == "run_script" and not self.enable_eval:
            raise BridgeError(
                "run_script (arbitrary ExtendScript) is disabled. Start the server "
                "with AE_MCP_ENABLE_EVAL=1 (or --enable-eval) to allow it.",
                code="EVAL_DISABLED",
            )
        if name == "aerender_render":
            return await anyio.to_thread.run_sync(
                functools.partial(self.bridge.aerender_render, args))
        timeout = tool_timeout(name, args)
        return await anyio.to_thread.run_sync(
            functools.partial(self.bridge.call, name, args, timeout))

    # ------------------------------------------------------------ handlers

    def _register_handlers(self) -> None:
        server = self.server

        @server.list_tools()
        async def list_tools() -> list[Tool]:
            return self._mcp_tools()

        @server.call_tool()
        async def call_tool(name: str, arguments: dict) -> list[TextContent]:
            try:
                result = await self._call_tool(name, arguments or {})
                payload = {"ok": True, "tool": name, "result": result}
                text = json.dumps(payload, ensure_ascii=False, default=str)
                return [TextContent(type="text", text=text)]
            except BridgeError as exc:
                payload = {
                    "ok": False, "tool": name,
                    "error": {"code": exc.code, "message": str(exc)},
                }
                if exc.hint:
                    payload["error"]["hint"] = exc.hint
                return [TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))]

    # -------------------------------------------------------------- run

    async def run_stdio(self) -> None:
        async with stdio_server() as (read_stream, write_stream):
            init = self.server.create_initialization_options()
            await self.server.run(read_stream, write_stream, init,
                                  raise_exceptions=False)

    async def run_http(self, host: str, port: int) -> None:
        try:
            from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
            import uvicorn
            from starlette.applications import Starlette
            from starlette.responses import JSONResponse, PlainTextResponse
            from starlette.routing import Mount, Route
        except ImportError as exc:  # pragma: no cover
            raise SystemExit(
                "HTTP transport needs starlette+uvicorn: pip install 'mcp[cli]' or "
                "pip install starlette uvicorn"
            ) from exc

        session_manager = StreamableHTTPSessionManager(
            app=self.server, json_response=True, stateless=True,
        )

        async def mcp_asgi_app(scope, receive, send):
            # Raw ASGI app mounted at "/" (a Mount("/mcp") would 307-redirect
            # /mcp -> /mcp/, which some clients do not follow). The stateless
            # transport writes the response itself and returns None, so this
            # must not sit behind a Route() that expects a Response.
            if scope["type"] == "http" and scope.get("path", "").rstrip("/") == "/mcp":
                await session_manager.handle_request(scope, receive, send)
            else:
                resp = PlainTextResponse("not found", status_code=404)
                await resp(scope, receive, send)

        async def health(request):
            hb = launcher.read_heartbeat()
            return JSONResponse({
                "server": "after-effects-mcp", "version": __version__,
                "bridge_alive": bool(hb), "heartbeat": hb,
                "tools": len(self.visible_tools()),
            })

        @contextlib.asynccontextmanager
        async def lifespan(app):
            async with session_manager.run():
                yield

        starlette_app = Starlette(
            routes=[
                Route("/health", health, methods=["GET"]),
                Mount("/", app=mcp_asgi_app),
            ],
            lifespan=lifespan,
        )
        config = uvicorn.Config(starlette_app, host=host, port=port,
                                log_level="warning")
        httpd = uvicorn.Server(config)
        print(f"[ae-mcp] streamable HTTP on http://{host}:{port}/mcp "
              f"(health: /health), tools={len(self.visible_tools())}",
              file=sys.stderr)
        await httpd.serve()

    def run(self, transport: str = "stdio", host: str = "127.0.0.1",
            port: int = 8678) -> None:
        if transport == "stdio":
            anyio.run(self.run_stdio)
        elif transport in ("http", "streamable-http"):
            anyio.run(self.run_http, host, port)
        else:
            raise SystemExit(f"Unknown transport '{transport}' (use stdio or http)")


def main(argv: list[str] | None = None) -> None:
    import argparse
    parser = argparse.ArgumentParser(
        prog="ae-mcp",
        description="After Effects MCP server (file-mailbox bridge to AfterFX)",
    )
    parser.add_argument("--http", action="store_true",
                        help="serve streamable HTTP instead of stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8678)
    parser.add_argument("--registry", default=None,
                        help="path to tools.json (default: repo registry)")
    parser.add_argument("--read-only", action="store_true",
                        help="hide mutating tools (or env AE_MCP_READONLY=1)")
    parser.add_argument("--enable-eval", action="store_true",
                        help="expose run_script (or env AE_MCP_ENABLE_EVAL=1)")
    parser.add_argument("--no-auto-start", action="store_true",
                        help="never launch AfterFX.exe automatically")
    parser.add_argument("--status", action="store_true",
                        help="print diagnostics and exit")
    args = parser.parse_args(argv)

    if args.status:
        print(json.dumps(launcher.status_report(), indent=2, ensure_ascii=False))
        return

    srv = AeMcpServer(
        registry_path=args.registry,
        read_only=True if args.read_only else None,
        enable_eval=True if args.enable_eval else None,
        auto_start=not args.no_auto_start,
    )
    print(f"[ae-mcp] {len(srv.visible_tools())} tools "
          f"(read_only={srv.read_only}, eval={srv.enable_eval})",
          file=sys.stderr)
    srv.run("http" if args.http else "stdio", args.host, args.port)


if __name__ == "__main__":
    main()
