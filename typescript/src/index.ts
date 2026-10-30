#!/usr/bin/env node
/** ae-mcp - After Effects MCP server (TypeScript edition).
 *
 *   node dist/index.js               stdio (default)
 *   node dist/index.js --http        streamable HTTP on :8678
 *   node dist/index.js --status      diagnostics and exit
 */

import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AeMcpServer } from "./server.js";
import { statusReport } from "./launcher.js";

interface CliArgs {
  http: boolean;
  host: string;
  port: number;
  registry?: string;
  readOnly: boolean;
  enableEval: boolean;
  noAutoStart: boolean;
  status: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    http: false, host: "127.0.0.1", port: 8678,
    readOnly: false, enableEval: false, noAutoStart: false, status: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--http": args.http = true; break;
      case "--host": args.host = argv[++i] ?? args.host; break;
      case "--port": args.port = Number(argv[++i] ?? 8678) || 8678; break;
      case "--registry": args.registry = argv[++i]; break;
      case "--read-only": args.readOnly = true; break;
      case "--enable-eval": args.enableEval = true; break;
      case "--no-auto-start": args.noAutoStart = true; break;
      case "--status": args.status = true; break;
      default:
        if (a.startsWith("--")) {
          console.error(`[ae-mcp] unknown flag ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function log(msg: string): void {
  console.error(`[ae-mcp] ${msg}`);
}

async function runStdio(srv: AeMcpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await srv.server.connect(transport);
  log(`stdio connected, ${srv.visibleTools().length} tools (read_only=${srv.readOnly}, eval=${srv.enableEval})`);
}

async function runHttp(srv: AeMcpServer, host: string, port: number): Promise<void> {
  // Stateless streamable HTTP: a fresh transport+server pair per POST (official
  // SDK pattern), JSON responses, no sessions to clean up.
  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          server: "after-effects-mcp",
          tools: srv.visibleTools().length,
          status: statusReport(),
        }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end("not found");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end("POST only (stateless mode)");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        res.writeHead(400).end("invalid JSON");
        return;
      }
      const pair = newServerPair(srv);
      res.on("close", () => {
        pair.transport.close().catch(() => undefined);
      });
      await pair.transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  log(`streamable HTTP on http://${host}:${port}/mcp (health: /health), ${srv.visibleTools().length} tools`);
}

function newServerPair(base: AeMcpServer): { transport: StreamableHTTPServerTransport; server: AeMcpServer } {
  // A fresh protocol instance per request keeps stateless mode safe; the
  // underlying registry and bridge client (single mailbox access chain) are
  // shared with the base server.
  const shim = new AeMcpServer({
    registryData: base.registry,
    bridge: base.bridge,
    readOnly: base.readOnly,
    enableEval: base.enableEval,
    autoStart: false,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  void shim.server.connect(transport);
  return { transport, server: shim };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.status) {
    console.log(JSON.stringify(statusReport(), null, 2));
    return;
  }
  const srv = new AeMcpServer({
    registry: args.registry,
    readOnly: args.readOnly || undefined,
    enableEval: args.enableEval || undefined,
    autoStart: !args.noAutoStart,
  });
  log(`${srv.visibleTools().length} tools (read_only=${srv.readOnly}, eval=${srv.enableEval})`);
  if (args.http) {
    await runHttp(srv, args.host, args.port);
  } else {
    await runStdio(srv);
  }
}

main().catch((err) => {
  console.error(`[ae-mcp] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
