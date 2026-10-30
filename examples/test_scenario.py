#!/usr/bin/env python3
"""End-to-end test against a REAL After Effects (Windows).

Builds a small animated intro scene through the bridge and renders a preview
frame, printing every step. Run AFTER After Effects is open (any project):

    cd python && python ../examples/test_scenario.py

Optional env: AE_MCP_RUNTIME_DIR (mailbox), AE_MCP_EXE (AfterFX.exe path).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PY_DIR = Path(__file__).resolve().parent.parent / "python"
sys.path.insert(0, str(PY_DIR))

from ae_mcp.bridge import BridgeClient, BridgeError  # noqa: E402
from ae_mcp import launcher  # noqa: E402


def main() -> int:
    print("=" * 66)
    print(" After Effects MCP - test scenario")
    print("=" * 66)
    print(f"mailbox : {launcher.runtime_dir()}")
    status = launcher.status_report()
    print(f"AE exe  : {status['afterfx_exe']}")
    print(f"bridge  : {status['bridge_js']}")
    print()

    bridge = BridgeClient(default_timeout_s=60, auto_start=True)
    step = 0

    def run(tool: str, args: dict | None = None, label: str = ""):
        nonlocal step
        step += 1
        args = args or {}
        print(f"[{step:02d}] {tool} {label or ''}")
        try:
            result = bridge.call(tool, args)
            print(f"     OK  -> {str(result)[:220]}")
            return result
        except BridgeError as exc:
            print(f"     FAIL [{exc.code}] {exc}")
            if exc.hint:
                print(f"     hint: {exc.hint}")
            raise SystemExit(1)

    # 0. connectivity
    hb = launcher.read_heartbeat()
    if hb is None:
        print("heartbeat: no live bridge found - trying auto-start (AfterFX.exe -r)...")
    else:
        print(f"heartbeat: AE {hb.get('ae_version')} | project={hb.get('project_name')} | served={hb.get('served')}")

    run("ping", label="(bridge round-trip)")
    run("ae_info", label="(security pref, features)")

    # 1. a fresh comp
    comp = run("comp_create", {
        "name": "AE-MCP-Test", "width": 1280, "height": 720,
        "duration": 4, "frame_rate": 30, "background_color": [16, 18, 24],
    }, label="(1280x720, 4s, 30fps)")
    comp_name = comp["comp"]["name"]

    # 2. animated title
    run("layer_add_text", {
        "comp": comp_name, "text": "AE MCP WORKS", "font_size": 96,
        "font": "Arial-Black", "fill_color": [235, 240, 255],
        "position": [640, 360], "justification": "center",
    }, label="(title)")

    run("transform_set", {
        "comp": comp_name, "layer": 1, "position": [640, 380, 0],
        "set_keyframe": True,
    }, label="(position key @0s)")
    run("keyframe_set", {
        "comp": comp_name, "layer": 1, "path": "Transform.Position",
        "time_s": 1.5, "value": [640, 300, 0], "interpolation": "bezier",
    }, label="(position key @1.5s)")
    run("keyframe_set", {
        "comp": comp_name, "layer": 1, "path": "Transform.Scale",
        "times": [0, 0.8, 1.5], "values": [[60, 60], [104, 104], [100, 100]],
    }, label="(scale pop 60->104->100)")
    run("keyframe_set_interpolation", {
        "comp": comp_name, "layer": 1, "path": "Transform.Scale",
        "interpolation": "bezier", "ease_in": [0, 80], "ease_out": [0, 80],
    }, label="(ease 80%)")

    # 3. expression-driven backdrop
    run("layer_add_shape", {
        "comp": comp_name, "shape_type": "rect", "name": "Backdrop",
        "size": [1280, 720], "fill_color": [28, 34, 48],
    })
    run("layer_reorder", {
        "comp": comp_name, "layer": "Backdrop", "where": "bottom",
    })
    run("expression_set", {
        "comp": comp_name, "layer": "Backdrop", "path": "Transform.Opacity",
        "expression": "50 + 20 * Math.sin(time * 2)",
    }, label="(breathing backdrop)")

    # 4. glow + shadow
    run("effect_add", {
        "comp": comp_name, "layer": 1, "match_name": "ADBE Glow",
        "params": {"Glow Threshold": 70, "Glow Radius": 22},
    }, label="(Glow)")
    run("effect_add", {
        "comp": comp_name, "layer": 1, "match_name": "ADBE Drop Shadow",
        "params": {"Opacity": 0.55, "Distance": 18, "Softness": 24},
    }, label="(Drop Shadow)")

    # 5. markers + null control
    run("marker_add", {
        "comp": comp_name, "target": "comp", "time_s": 0,
        "comment": "in", "chapter": "A",
    })
    run("marker_add", {
        "comp": comp_name, "target": "comp", "time_s": 3.5,
        "comment": "out",
    })
    run("layer_add_null", {"comp": comp_name, "name": "CTRL"})

    # 6. preview frames
    run("frame_render", {
        "comp": comp_name, "times_s": [0.2, 1.5, 3.2],
    }, label="(3 preview PNGs -> open them!)")

    print()
    print("=" * 66)
    print(" DONE - check the three preview PNGs in the mailbox previews folder,")
    print(" and the 'AE-MCP-Test' comp inside After Effects.")
    print(" Nothing was saved to disk except the previews; undo in AE removes all.")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("AE_MCP_TIMEOUT", "60")
    raise SystemExit(main())
