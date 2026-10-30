/** File-based mailbox client for the resident ExtendScript bridge (same
 * protocol as the Python edition - see bridge/ae_bridge.jsx header). */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureBridgeAlive,
  findAerenderExe,
  readHeartbeat,
  runtimeDir,
  sleep,
} from "./launcher.js";

export class BridgeError extends Error {
  code: string;
  hint?: string;
  constructor(message: string, code = "BRIDGE_ERROR", hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export interface CallResult {
  [k: string]: unknown;
}

const DEFAULT_TIMEOUT_S = 30;

export class BridgeClient {
  defaultTimeoutS: number;
  autoStart: boolean;
  private chain: Promise<unknown> = Promise.resolve(); // serialize calls (AE runs one script at a time)

  constructor(defaultTimeoutS = DEFAULT_TIMEOUT_S, autoStart = true) {
    this.defaultTimeoutS = defaultTimeoutS;
    this.autoStart = autoStart;
  }

  /** Queue-serialized wrapper so concurrent MCP calls do not clobber the mailbox. */
  call(tool: string, args: Record<string, unknown> = {}, timeoutS?: number): Promise<CallResult> {
    const run = () => this._call(tool, args, timeoutS);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async _call(
    tool: string,
    args: Record<string, unknown>,
    timeoutS?: number,
  ): Promise<CallResult> {
    let timeout = timeoutS ?? this.defaultTimeoutS;
    const argTimeout = (args as { timeout_s?: unknown }).timeout_s;
    if (typeof argTimeout === "number" && argTimeout > 0) timeout = argTimeout;

    const alive = await ensureBridgeAlive(this.autoStart);
    if (!alive.alive && tool !== "help_bridge") {
      const push = alive.push;
      let extra = "";
      if (push?.log_tail) extra = `\nbridge.log tail:\n${push.log_tail}`;
      throw new BridgeError(
        `After Effects bridge is not responding. ${push?.note ?? ""}`.trim(),
        "BRIDGE_NOT_ALIVE",
        "1) Is After Effects running? 2) Preferences > Scripting & Expressions > " +
          "'Allow Scripts to Write Files and Access Network' must be ON. " +
          "3) Install the bridge (install.py) or rely on auto-start. " +
          "4) Dismiss any modal dialog blocking AE." + extra,
      );
    }

    const rt = runtimeDir();
    const commandsDir = path.join(rt, "commands");
    const resultsDir = path.join(rt, "results");
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(resultsDir, { recursive: true });

    const rid = `${Date.now() * 1000 + Math.floor(Math.random() * 1000)}-${randomUUID().slice(0, 8)}`;
    const reqPath = path.join(commandsDir, `request-${rid}.json`);
    const body = JSON.stringify({
      tool,
      args,
      ts: Date.now() / 1000,
      undo_group: true,
      suppress_dialogs: true,
    });
    const tmp = reqPath + ".tmp";
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, reqPath);

    const started = Date.now();
    let resp: { ok?: boolean; result?: CallResult; error?: { code?: string; message?: string } } | null = null;
    let delay = 50;
    while (Date.now() - started < timeout * 1000) {
      resp = readResponse(rid, resultsDir);
      if (resp) break;
      await sleep(delay);
      delay = Math.min(delay * 1.3, 250);
    }
    if (!resp) {
      throw new BridgeError(
        `Timed out after ${Math.round(timeout)}s waiting for '${tool}'. AE may be busy (long render), blocked by a modal dialog, or the bridge is not loaded.`,
        "TIMEOUT",
        "Try a larger timeout_s; check bridge.log in the runtime dir; render_queue_control action=stop aborts a stuck render.",
      );
    }
    if (resp.ok) return resp.result ?? {};
    throw new BridgeError(
      resp.error?.message ?? "Unknown bridge error",
      resp.error?.code ?? "TOOL_ERROR",
    );
  }

  /** aerender_render runs OUTSIDE AE as a subprocess. */
  async aerenderRender(args: Record<string, unknown>): Promise<CallResult> {
    const exe = findAerenderExe();
    if (!exe) {
      throw new BridgeError("aerender.exe not found. Set AE_AERENDER or AE_MCP_EXE.", "AERENDER_NOT_FOUND");
    }
    let project = args["project_path"] as string | undefined;
    if (!project) {
      const hb = readHeartbeat(3600_000);
      project = hb?.project ?? undefined;
      if (!project) {
        throw new BridgeError("No project_path given and no open project known.", "BAD_ARGS");
      }
    }
    const cmd: string[] = [exe, "-project", project];
    const comp = args["comp"];
    if (comp !== undefined && comp !== null && comp !== "") cmd.push("-comp", String(comp));
    if (args["output_template"]) cmd.push("-OMtemplate", String(args["output_template"]));
    if (args["render_settings_template"]) cmd.push("-RStemplate", String(args["render_settings_template"]));
    if (args["output_path"]) cmd.push("-output", String(args["output_path"]));
    if (args["start_frame"] !== undefined && args["start_frame"] !== null) cmd.push("-s", String(args["start_frame"]));
    if (args["end_frame"] !== undefined && args["end_frame"] !== null) cmd.push("-e", String(args["end_frame"]));
    const timeoutS = Number(args["timeout_s"] ?? 3600) || 3600;
    const started = Date.now();

    const { execFile } = await import("node:child_process");
    const { stdout, stderr, code, timedOut } = await new Promise<{
      stdout: string; stderr: string; code: number; timedOut: boolean;
    }>((resolve) => {
      const child = execFile(
        cmd[0], cmd.slice(1),
        { timeout: timeoutS * 1000, cwd: path.dirname(exe), maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const killed = Boolean(err && (err as { killed?: boolean }).killed);
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: child.exitCode ?? (err ? 1 : 0),
            timedOut: killed,
          });
        },
      );
    });
    if (timedOut) {
      throw new BridgeError(`aerender timed out after ${timeoutS}s`, "TIMEOUT");
    }
    const tail = stdout.split(/\r?\n/).slice(-25).join("\n");
    return {
      exit_code: code,
      duration_s: Math.round(((Date.now() - started) / 1000) * 10) / 10,
      command: cmd,
      stdout_tail: tail,
      stderr_tail: stderr.split(/\r?\n/).slice(-10).join("\n"),
      success: code === 0,
    };
  }
}

function readResponse(
  rid: string,
  resultsDir: string,
): { ok?: boolean; result?: CallResult; error?: { code?: string; message?: string } } | null {
  const p = path.join(resultsDir, `response-${rid}.json`);
  try {
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf-8");
    if (!text.trim()) return null;
    const data = JSON.parse(text);
    try {
      unlinkSync(p);
    } catch {
      /* next reader re-creates via poll - fine, single consumer */
    }
    return data;
  } catch {
    return null;
  }
}
