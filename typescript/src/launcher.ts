/** Locate After Effects, manage the bridge mailbox, push the resident bridge. */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_FILENAME = "ae_bridge.jsx";
const HEARTBEAT_MAX_AGE_MS = 6000;
const AE_VERSIONS = [2026, 2025, 2024, 2023, 2022, 2021];

export function repoRoot(): string {
  // dist/index.js -> typescript/dist -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const base of [here, path.join(here, ".."), path.join(here, "..", ".."), process.cwd(), ...walkUp(process.cwd())]) {
    const cand = path.join(base, "registry", "tools.json");
    if (existsSync(cand)) return base;
  }
  return process.cwd();
}

function walkUp(start: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(start);
  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    out.push(cur);
  }
  return out;
}

export function runtimeDir(): string {
  const custom = process.env.AE_MCP_RUNTIME_DIR;
  if (custom && custom.length > 0) return custom;
  return path.join(os.tmpdir(), "ae-mcp-bridge");
}

export function bridgeJsPath(): string | null {
  const env = process.env.AE_MCP_BRIDGE_JS;
  if (env && existsSync(env)) return env;
  const root = repoRoot();
  const cand = path.join(root, "bridge", BRIDGE_FILENAME);
  return existsSync(cand) ? cand : null;
}

export function findAfterfxExe(): string | null {
  const env = process.env.AE_MCP_EXE;
  if (env && existsSync(env)) return env;
  for (const ver of AE_VERSIONS) {
    const c1 = `C:/Program Files/Adobe/Adobe After Effects ${ver}/Support Files/AfterFX.exe`;
    const c2 = `C:/Program Files/Adobe/Adobe After Effects ${ver}/AfterFX.exe`;
    if (existsSync(c1)) return c1;
    if (existsSync(c2)) return c2;
  }
  return null;
}

export function findAerenderExe(): string | null {
  const env = process.env.AE_AERENDER;
  if (env && existsSync(env)) return env;
  const exe = findAfterfxExe();
  if (exe) {
    const aer = path.join(path.dirname(exe), "aerender.exe");
    if (existsSync(aer)) return aer;
  }
  for (const ver of AE_VERSIONS) {
    const cand = `C:/Program Files/Adobe/Adobe After Effects ${ver}/Support Files/aerender.exe`;
    if (existsSync(cand)) return cand;
  }
  return null;
}

export interface Heartbeat {
  kind: string;
  id: string;
  version: number;
  ae_version: string;
  ae_build?: string;
  project: string | null;
  project_name: string | null;
  dirty: boolean;
  num_items: number;
  started_at: number;
  uptime_s: number;
  ticks: number;
  served: number;
  busy: boolean;
  busy_since: number | null;
  last_error: string | null;
  security_pref: boolean | null;
  runtime_dir: string;
  ts: number;
  iso: string;
  _age_s?: number;
}

export function readHeartbeat(maxAgeMs: number = HEARTBEAT_MAX_AGE_MS): Heartbeat | null {
  const hb = path.join(runtimeDir(), "heartbeat.json");
  try {
    if (!existsSync(hb)) return null;
    const age = Date.now() - statSync(hb).mtimeMs;
    if (age > maxAgeMs) return null;
    const data = JSON.parse(readFileSync(hb, "utf-8")) as Heartbeat;
    if (!data || data.kind !== "ae_mcp_bridge_heartbeat") return null;
    data._age_s = Math.round((age / 1000) * 100) / 100;
    return data;
  } catch {
    return null;
  }
}

export function bridgeLogTail(lines = 15): string {
  const log = path.join(runtimeDir(), "bridge.log");
  try {
    if (!existsSync(log)) return "";
    const text = readFileSync(log, "utf-8");
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export interface PushResult {
  started: boolean;
  heartbeat?: Heartbeat;
  note?: string;
  log_tail?: string;
}

export async function pushBridge(waitS = 25): Promise<PushResult> {
  const js = bridgeJsPath();
  if (!js) {
    throw new Error(
      "ae_bridge.jsx not found. Set AE_MCP_BRIDGE_JS to its path, or run the installer (install.py).",
    );
  }
  const exe = findAfterfxExe();
  if (!exe) {
    throw new Error(
      "AfterFX.exe not found. Set AE_MCP_EXE to the full path of 'C:/Program Files/Adobe/Adobe After Effects <ver>/Support Files/AfterFX.exe'.",
    );
  }
  const env = { ...process.env, AE_MCP_RUNTIME_DIR: runtimeDir() };
  const child = spawn(exe, ["-r", js], {
    cwd: path.dirname(exe),
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + waitS * 1000;
  while (Date.now() < deadline) {
    const hb = readHeartbeat(3600_000);
    if (hb && hb.ts > Date.now() - 5000) return { started: true, heartbeat: hb };
    await sleep(500);
  }
  return {
    started: false,
    note:
      "AfterFX.exe was launched but no heartbeat appeared in " +
      `${waitS}s. AE may still be cold-starting, may be blocked by a modal dialog, ` +
      "or 'Allow Scripts to Write Files and Access Network' is OFF in AE preferences.",
    log_tail: bridgeLogTail(10),
  };
}

export async function ensureBridgeAlive(
  autoStart: boolean,
  waitS = 25,
): Promise<{ alive: boolean; heartbeat?: Heartbeat; push?: PushResult }> {
  const hb = readHeartbeat();
  if (hb) return { alive: true, heartbeat: hb };
  if (autoStart) {
    const push = await pushBridge(waitS);
    const hb2 = readHeartbeat();
    if (hb2) return { alive: true, heartbeat: hb2 };
    return { alive: false, push };
  }
  return { alive: false };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function statusReport(): Record<string, unknown> {
  const rt = runtimeDir();
  let heartbeat: Heartbeat | null = null;
  const hbPath = path.join(rt, "heartbeat.json");
  if (existsSync(hbPath)) {
    try {
      heartbeat = JSON.parse(readFileSync(hbPath, "utf-8"));
    } catch {
      heartbeat = null;
    }
  }
  return {
    runtime_dir: rt,
    runtime_exists: existsSync(rt),
    heartbeat_file_exists: existsSync(hbPath),
    heartbeat_age_s: heartbeat ? (Date.now() - statSync(hbPath).mtimeMs) / 1000 : null,
    heartbeat,
    bridge_js: bridgeJsPath(),
    afterfx_exe: findAfterfxExe(),
    aerender_exe: findAerenderExe(),
    node: process.version,
  };
}
