/** MCP wiring: registry/tools.json -> MCP tools; every call goes through the
 * mailbox bridge (or is served locally). Same behavior as the Python edition. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { BridgeClient, BridgeError } from "./bridge.js";
import { repoRoot, statusReport } from "./launcher.js";
export function loadRegistry(registryPath) {
    const cand = registryPath
        ? path.resolve(registryPath)
        : path.join(repoRoot(), "registry", "tools.json");
    try {
        return JSON.parse(readFileSync(cand, "utf-8"));
    }
    catch (err) {
        throw new Error(`Cannot read registry at ${cand}: ${err.message}. ` +
            "Run `python registry/generate_registry.py` or pass --registry.");
    }
}
export const TOOL_TIMEOUTS = {
    run_script: 120,
    project_open: 180,
    project_import_file: 120,
    project_new: 120,
    render_start: 1800,
    frame_render: 120,
};
export const BRIDGE_HELP = {
    bridge: "ae_bridge.jsx resident ExtendScript bridge",
    how_it_works: [
        "The MCP server writes commands/request-<id>.json into the mailbox.",
        "The resident bridge inside After Effects consumes them every 250 ms,",
        "runs each tool inside one undo group with dialogs suppressed, and",
        "writes results/response-<id>.json back.",
    ],
    install_steps: [
        "1. AE Preferences > Scripting & Expressions > enable 'Allow Scripts to Write Files and Access Network', then restart AE.",
        "2. Run the installer (install.py) to copy the bridge into %APPDATA%\\Adobe\\After Effects <ver>\\Scripts\\Startup (auto-start).",
        "3. Or call any tool: the server pushes the bridge via AfterFX.exe -r.",
    ],
    troubleshooting: [
        "ping fails, no heartbeat.json -> AE not running or bridge not loaded.",
        "All tools time out -> security preference OFF, or a modal dialog blocks AE.",
        "Read <runtime>/bridge.log for the AE-side log.",
    ],
    status: statusReport(),
};
export class AeMcpServer {
    registry;
    readOnly;
    enableEval;
    bridge;
    server;
    constructor(opts = {}) {
        this.registry = opts.registryData ?? loadRegistry(opts.registry);
        const env = (k) => ["1", "true", "yes"].includes(String(process.env[k] ?? "").trim().toLowerCase());
        this.readOnly = opts.readOnly ?? env("AE_MCP_READONLY");
        this.enableEval = opts.enableEval ?? env("AE_MCP_ENABLE_EVAL");
        const timeout = Number(process.env.AE_MCP_TIMEOUT ?? 30) || 30;
        this.bridge = opts.bridge ?? new BridgeClient(timeout, opts.autoStart ?? true);
        this.server = new Server({ name: "after-effects-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
        this.registerHandlers();
    }
    visibleTools() {
        return this.registry.tools.filter((t) => {
            if (t.name === "help_bridge" || t.name === "aerender_render")
                return true;
            if (t.name === "run_script")
                return this.enableEval;
            if (this.readOnly && t.mutating)
                return false;
            return true;
        });
    }
    spec(name) {
        return this.registry.tools.find((t) => t.name === name);
    }
    toolTimeout(name, args) {
        const t = args["timeout_s"];
        if (typeof t === "number" && t > 0)
            return t;
        return TOOL_TIMEOUTS[name];
    }
    async callTool(name, args) {
        const spec = this.spec(name);
        if (!spec)
            throw new BridgeError(`Unknown tool '${name}'`, "UNKNOWN_TOOL");
        if (name !== "help_bridge" && this.readOnly && spec.mutating) {
            throw new BridgeError(`Server is in read-only mode (AE_MCP_READONLY=1); '${name}' mutates the project and was not executed.`, "READ_ONLY");
        }
        if (name === "help_bridge")
            return BRIDGE_HELP;
        if (name === "run_script" && !this.enableEval) {
            throw new BridgeError("run_script (arbitrary ExtendScript) is disabled. Start the server with AE_MCP_ENABLE_EVAL=1 (or --enable-eval) to allow it.", "EVAL_DISABLED");
        }
        if (name === "aerender_render")
            return this.bridge.aerenderRender(args);
        return this.bridge.call(name, args, this.toolTimeout(name, args));
    }
    registerHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.visibleTools().map((t) => ({
                name: t.name,
                title: t.title,
                description: t.description,
                inputSchema: t.inputSchema,
            })),
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const name = request.params.name;
            const args = (request.params.arguments ?? {});
            try {
                const result = await this.callTool(name, args);
                const payload = { ok: true, tool: name, result };
                return {
                    content: [{ type: "text", text: JSON.stringify(payload) }],
                };
            }
            catch (err) {
                const be = err instanceof BridgeError ? err : new BridgeError(String(err?.message ?? err));
                const payload = {
                    ok: false,
                    tool: name,
                    error: { code: be.code, message: be.message, ...(be.hint ? { hint: be.hint } : {}) },
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(payload) }],
                    isError: true,
                };
            }
        });
    }
}
