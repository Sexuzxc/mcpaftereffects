#!/usr/bin/env python3
"""Installer for the After Effects MCP server.

What it does (no admin rights needed):
  1. Checks prerequisites (Python 3.10+, Node.js if the TypeScript edition is wanted).
  2. Installs the resident bridge ae_bridge.jsx into the user-level Scripts
     folder of every detected After Effects (auto-start on AE launch) and into
     Scripts (manual run available under File > Scripts).
  3. Best-effort enables the AE security preference "Allow Scripts to Write
     Files and Access Network" by patching the AE prefs file (backup kept).
     If AE is running or the pref is not found, prints manual steps instead.
  4. Optionally installs Python deps (pip install mcp) and builds the
     TypeScript server (npm install + npm run build).
  5. Prints ready-to-paste MCP client configs (Claude Desktop, Cursor, ...).

Usage:  python install.py [--with-python] [--with-node] [--no-pref-patch]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
AE_VERSIONS = ["2026", "2025", "2024", "2023", "2022", "2021"]
PREF_KEY = "Pref_SCRIPTING_FILE_NETWORK_SECURITY"
PREF_SECTION = "Pref_Scripting"


def info(msg: str) -> None:
    print(f"\033[1;34m[info]\033[0m {msg}")


def ok(msg: str) -> None:
    print(f"\033[1;32m[ ok ]\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"\033[1;33m[warn]\033[0m {msg}")


def err(msg: str) -> None:
    print(f"\033[1;31m[fail]\033[0m {msg}")


def ae_user_roots() -> list[Path]:
    """%APPDATA%/Adobe/After Effects/<version> for every installed version."""
    base = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Adobe" / "After Effects"
    roots = []
    if base.is_dir():
        for child in sorted(base.iterdir()):
            if child.is_dir() and any(v in child.name for v in AE_VERSIONS):
                roots.append(child)
    return roots


def afterfx_exe() -> Path | None:
    env = os.environ.get("AE_MCP_EXE")
    if env and Path(env).is_file():
        return Path(env)
    for ver in AE_VERSIONS:
        for cand in (
            Path(f"C:/Program Files/Adobe/Adobe After Effects {ver}/Support Files/AfterFX.exe"),
            Path(f"C:/Program Files/Adobe/Adobe After Effects {ver}/AfterFX.exe"),
        ):
            if cand.is_file():
                return cand
    return None


def is_ae_running() -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
        )
        return "AfterFX.exe" in out.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False


def install_bridge(roots: list[Path]) -> list[Path]:
    src = REPO / "bridge" / "ae_bridge.jsx"
    if not src.is_file():
        err(f"bridge not found at {src}")
        return []
    installed = []
    for root in roots:
        for sub, autostart in (("Scripts/Startup", True), ("Scripts", False)):
            dest_dir = root / sub
            try:
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / "ae_bridge.jsx"
                shutil.copy2(src, dest)
                installed.append(dest)
                if autostart:
                    ok(f"auto-start bridge  -> {dest}")
                else:
                    ok(f"manual run copy   -> {dest}")
            except OSError as exc:
                err(f"cannot copy into {dest_dir}: {exc}")
    return installed


def patch_security_pref(roots: list[Path]) -> None:
    """Best-effort: set Pref_SCRIPTING_FILE_NETWORK_SECURITY = 1 in AE prefs."""
    if is_ae_running():
        warn("After Effects is RUNNING - skipping prefs patch (prefs would be overwritten on exit).")
        warn("Enable it manually: Edit > Preferences > Scripting & Expressions > "
             "'Allow Scripts to Write Files and Access Network', then restart AE.")
        return
    patched = 0
    for root in roots:
        prefs_dir = root / "Preferences"
        if not prefs_dir.is_dir():
            continue
        for prefs_file in prefs_dir.glob("* Prefs.txt"):
            try:
                text = prefs_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if PREF_KEY not in text:
                continue
            new_text, n = re.subn(
                rf'("{PREF_KEY}"\s*=\s*)"?[0-9.]+"?',
                r'\g<1>"1"',
                text,
            )
            if n > 0 and new_text != text:
                backup = prefs_file.with_suffix(".txt.ae-mcp-backup")
                shutil.copy2(prefs_file, backup)
                prefs_file.write_text(new_text, encoding="utf-8")
                patched += 1
                ok(f"security pref ON  -> {prefs_file.name} (backup: {backup.name})")
    if patched == 0:
        warn("Could not patch the security preference automatically.")
        warn("Enable it manually in AE: Edit > Preferences > Scripting & Expressions > "
             "'Allow Scripts to Write Files and Access Network'.")
    else:
        info("Restart After Effects so the new preference takes effect.")


def install_python_deps() -> bool:
    try:
        import mcp  # noqa: F401
        ok("Python deps already present (mcp package found).")
        return True
    except ImportError:
        pass
    info("Installing Python dependencies: pip install mcp anyio starlette uvicorn ...")
    proc = subprocess.run([sys.executable, "-m", "pip", "install", "mcp>=1.9"],
                          capture_output=True, text=True)
    if proc.returncode == 0:
        ok("Python deps installed.")
        return True
    err(f"pip install failed:\n{proc.stdout}\n{proc.stderr}")
    return False


def build_typescript() -> bool:
    ts_dir = REPO / "typescript"
    if not (ts_dir / "package.json").is_file():
        err("typescript/ folder not found next to install.py")
        return False
    npm = shutil.which("npm")
    if npm is None:
        warn("npm not found - the TypeScript edition will not be built "
             "(the Python edition is fully functional on its own).")
        return False
    info("npm install (TypeScript edition)...")
    proc = subprocess.run([npm, "install", "--no-audit", "--no-fund"],
                          cwd=ts_dir, capture_output=True, text=True, shell=os.name == "nt")
    if proc.returncode != 0:
        err(f"npm install failed:\n{proc.stdout[-800:]}\n{proc.stderr[-800:]}")
        return False
    info("npm run build...")
    proc = subprocess.run([npm, "run", "build"], cwd=ts_dir, capture_output=True, text=True, shell=os.name == "nt")
    if proc.returncode != 0:
        err(f"tsc build failed:\n{proc.stdout[-800:]}\n{proc.stderr[-800:]}")
        return False
    ok(f"TypeScript server built -> {ts_dir / 'dist' / 'index.js'}")
    return True


def python_exe_hint() -> str:
    return sys.executable.replace("\\", "\\\\")


def print_configs(with_node: bool, node_server: Path | None) -> None:
    py = python_exe_hint()
    py_server = (REPO / "python" / "ae_mcp" / "server.py")
    print()
    print("=" * 74)
    print("CONNECT YOUR MCP CLIENT - copy one of the blocks below")
    print("=" * 74)

    print("""
--- Claude Desktop / any config-file client (claude_desktop_config.json) ----
{
  "mcpServers": {
    "after-effects": {
      "command": "python",
      "args": ["%(server)s"]
    }
  }
}
""" % {"server": py_server.as_posix()})

    print("--- Claude Code (terminal) ----------------------------------------------")
    print(f'claude mcp add after-effects -- python "{py_server.as_posix()}"')

    print("""
--- Cursor / Windsurf / Cline (mcp.json) -----------------------------------
{
  "mcpServers": {
    "after-effects": {
      "command": "python",
      "args": ["%(server)s"]
    }
  }
}
""" % {"server": py_server.as_posix()})

    if with_node and node_server:
        print("--- Node edition (alternative) ------------------------------------------")
        print(f'{{ "command": "node", "args": ["{node_server.as_posix()}"] }}')

    print("""
--- HTTP mode (optional; for remote agents / web clients) -------------------
  python "%(server)s" --http --port 8678
  -> endpoint: http://127.0.0.1:8678/mcp   (health: /health)

--- Useful environment variables --------------------------------------------
  AE_MCP_READONLY=1      audit mode: mutating tools hidden
  AE_MCP_ENABLE_EVAL=1   expose run_script (arbitrary ExtendScript!)
  AE_MCP_EXE=<path>      custom AfterFX.exe location
  AE_MCP_TIMEOUT=60      default per-call timeout, seconds
""" % {"server": py_server.as_posix()})


def print_checklist(installed: list[Path]) -> None:
    print("""
============================================================================
FINAL CHECKLIST (30 seconds)
============================================================================
1. AE preference 'Allow Scripts to Write Files and Access Network' is ON
   (Edit > Preferences > Scripting & Expressions), then RESTART After Effects.
2. The bridge auto-starts with AE (copied to Scripts\\Startup). The first tool
   call also pushes it automatically if it is not loaded yet.
3. Add the MCP config block above to your client and restart the client.
4. First test - ask the agent:  "use the after-effects tools: run ping"
5. Read the full README.md (RU) for the tool catalog and examples.
""")


def main() -> None:
    parser = argparse.ArgumentParser(description="Install the After Effects MCP server")
    parser.add_argument("--with-python", action="store_true", default=True,
                        help="install Python deps (default)")
    parser.add_argument("--no-python", action="store_true",
                        help="skip pip install")
    parser.add_argument("--with-node", action="store_true",
                        help="also npm install + build the TypeScript edition")
    parser.add_argument("--no-pref-patch", action="store_true",
                        help="do not touch the AE prefs file")
    args = parser.parse_args()

    if os.name != "nt":
        warn("This installer targets Windows. On macOS adapt the paths manually "
             "(~/Library/Preferences/Adobe/After Effects/<ver>/).")

    print("=" * 74)
    print(" After Effects MCP Server - installer")
    print("=" * 74)

    # 1. prerequisites
    if sys.version_info < (3, 10):
        err("Python 3.10+ required, found " + sys.version.split()[0])
        sys.exit(1)
    ok(f"Python {sys.version.split()[0]}")

    exe = afterfx_exe()
    if exe:
        ok(f"After Effects found: {exe}")
    else:
        warn("AfterFX.exe not found in standard paths - set AE_MCP_EXE if AE is elsewhere.")

    # 2. bridge into user Scripts folders
    roots = ae_user_roots()
    if not roots:
        warn("No '%APPDATA%/Adobe/After Effects/<version>' folders found. "
             "Launch AE once so it creates its profile folder, then re-run.")
    installed = install_bridge(roots)

    # 3. security pref
    if not args.no_pref_patch and roots:
        patch_security_pref(roots)

    # 4. deps
    node_server = REPO / "typescript" / "dist" / "index.js"
    built_node = False
    if not args.no_python:
        install_python_deps()
    if args.with_node:
        built_node = build_typescript()

    print_configs(built_node, node_server if built_node else None)
    print_checklist(installed)

    info("Sanity check without AE:  python tests/test_smoke.py")
    info("Diagnostics:              python -m ae_mcp --status   (from the python/ folder)")


if __name__ == "__main__":
    main()
