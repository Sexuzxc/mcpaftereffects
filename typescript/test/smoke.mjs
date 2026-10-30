/** E2E smoke test for the TypeScript MCP server - no After Effects needed.
 * Emulates the AE side of the mailbox, spawns the compiled server over stdio,
 * and drives it with a real MCP client.  Run:  node test/smoke.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = path.join(root, "dist", "index.js");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-ts-test-"));

// ---- fake bridge -----------------------------------------------------------
const failTools = new Set();
let stop = false;

function startFakeBridge() {
  fs.mkdirSync(path.join(runtime, "commands"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "results"), { recursive: true });
  const hb = {
    kind: "ae_mcp_bridge_heartbeat", id: "fake-bridge", version: 1,
    ae_version: "99.0 (fake)", project: null, project_name: null,
    dirty: false, num_items: 0, started_at: Date.now(), uptime_s: 0,
    ticks: 0, served: 0, busy: false, busy_since: null, last_error: null,
    security_pref: true, runtime_dir: runtime, ts: Date.now(),
    iso: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runtime, "heartbeat.json"), JSON.stringify(hb));
  const tick = () => {
    if (stop) return;
    try {
      const dir = path.join(runtime, "commands");
      for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("request-") && n.endsWith(".json")).sort()) {
        const full = path.join(dir, f);
        const body = JSON.parse(fs.readFileSync(full, "utf-8"));
        fs.unlinkSync(full);
        const id = f.replace(/^request-/, "").replace(/\.json$/, "");
        const resp = failTools.has(body.tool)
          ? { ok: false, id, error: { code: "TOOL_ERROR", message: "emulated failure" } }
          : { ok: true, id, result: { tool: body.tool, args: body.args, fake: true } };
        const out = path.join(runtime, "results", `response-${id}.json`);
        fs.writeFileSync(out + ".tmp", JSON.stringify(resp));
        fs.renameSync(out + ".tmp", out);
      }
    } catch { /* keep ticking */ }
    setTimeout(tick, 50);
  };
  tick();
}

function assert(cond, msg, extra) {
  if (!cond) {
    console.error("[test] FAIL:", msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
    process.exit(1);
  }
}

async function withServer(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distIndex, "--no-auto-start"],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function main() {
  process.env.AE_MCP_RUNTIME_DIR = runtime;
  startFakeBridge();

  await withServer({}, async (client) => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    console.log(`[test] listed ${names.size} tools`);
    assert(names.has("comp_create"), "comp_create must be listed");
    assert(names.has("aerender_render"), "aerender_render must be listed");
    assert(!names.has("run_script"), "run_script must be gated");

    const ping = await client.callTool({ name: "ping", arguments: {} });
    const pingData = JSON.parse(ping.content[0].text);
    assert(pingData.ok === true && pingData.result.tool === "ping", "ping round-trip", pingData);
    console.log("[test] ping OK");

    const created = await client.callTool({ name: "comp_create", arguments: { name: "Intro", width: 1920, height: 1080 } });
    const createdData = JSON.parse(created.content[0].text);
    assert(createdData.ok === true && createdData.result.args.name === "Intro", "comp_create round-trip", createdData);
    console.log("[test] comp_create OK");

    failTools.add("comp_info");
    const failed = await client.callTool({ name: "comp_info", arguments: {} });
    const failedData = JSON.parse(failed.content[0].text);
    assert(failedData.ok === false && failedData.error.code === "TOOL_ERROR", "tool error propagates", failedData);
    assert(failed.isError === true, "isError flag set");
    failTools.delete("comp_info");
    console.log("[test] tool error propagated ->", failedData.error.code);

    const gated = await client.callTool({ name: "run_script", arguments: { code: "return 1;" } });
    const gatedData = JSON.parse(gated.content[0].text);
    assert(gatedData.ok === false && gatedData.error.code === "EVAL_DISABLED", "run_script gated", gatedData);
    console.log("[test] run_script gated ->", gatedData.error.code);
  });

  await withServer({ AE_MCP_READONLY: "1" }, async (client) => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert(!names.has("comp_create"), "read-only hides comp_create");
    assert(names.has("ping") && names.has("help_bridge"), "read tools remain");
    console.log(`[test] read-only mode lists ${names.size} tools (mutating hidden)`);
  });

  stop = true;
  console.log("[test] ALL SMOKE TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
