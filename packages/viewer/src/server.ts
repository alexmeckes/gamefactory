import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { FACTORY_VIEWER_HTML } from "./ui.js";
import {
  createFactorySnapshot,
  factoryTraceSignature,
  readFactoryTrace,
  type FactoryTrace,
  type FactoryViewerOptions,
  type FactoryViewerSnapshot
} from "./trace.js";

export interface FactoryViewerServerOptions extends FactoryViewerOptions {
  host?: string;
  port?: number;
}

export interface FactoryViewerServer {
  url: string;
  host: string;
  port: number;
  snapshot(runId?: string): FactoryViewerSnapshot;
  close(): Promise<void>;
}

const securityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(encoded)
  });
  response.end(encoded);
}

function selectedRun(url: URL): string | undefined {
  const value = url.searchParams.get("run");
  return value?.trim() || undefined;
}

async function safeArtifactPath(root: string, path: string): Promise<string | undefined> {
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
    const traversal = relative(canonicalRoot, canonicalPath);
    if (!traversal || traversal.startsWith("..") || isAbsolute(traversal)) return undefined;
    const info = await stat(canonicalPath);
    return info.isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export async function startFactoryViewer(options: FactoryViewerServerOptions): Promise<FactoryViewerServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4317;
  const intervalMs = Math.max(100, options.pollIntervalMs ?? 400);
  let trace = await readFactoryTrace(options);
  let signature = await factoryTraceSignature(options);
  let refreshing: Promise<boolean> | undefined;
  const clients = new Map<ServerResponse, string | undefined>();

  const snapshot = (runId?: string) => createFactorySnapshot(trace, options.campaign, runId);
  const refresh = (): Promise<boolean> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const nextSignature = await factoryTraceSignature(options);
      if (nextSignature === signature) return false;
      trace = await readFactoryTrace(options);
      signature = nextSignature;
      return true;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };

  const broadcast = (): void => {
    for (const [client, runId] of clients) {
      client.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(runId))}\n\n`);
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${requestedPort}`}`);
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, {
          ...securityHeaders,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(FACTORY_VIEWER_HTML)
        });
        response.end(FACTORY_VIEWER_HTML);
        return;
      }
      if (url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, campaignId: options.campaign.id, live: snapshot().live });
        return;
      }
      if (url.pathname === "/api/snapshot") {
        await refresh();
        sendJson(response, 200, snapshot(selectedRun(url)));
        return;
      }
      if (url.pathname === "/api/stream") {
        response.writeHead(200, {
          ...securityHeaders,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive"
        });
        const runId = selectedRun(url);
        clients.set(response, runId);
        response.write(`retry: 1000\nevent: snapshot\ndata: ${JSON.stringify(snapshot(runId))}\n\n`);
        request.once("close", () => clients.delete(response));
        return;
      }
      if (url.pathname.startsWith("/artifacts/")) {
        const id = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        if (!/^[a-f0-9]{64}$/i.test(id)) {
          sendJson(response, 404, { error: "Artifact not found" });
          return;
        }
        const artifact = trace.artifactFiles.get(id);
        const path = artifact ? await safeArtifactPath(trace.sources.artifactDirectory, artifact.path) : undefined;
        if (!artifact || !path) {
          sendJson(response, 404, { error: "Artifact not found" });
          return;
        }
        const contents = await readFile(path);
        response.writeHead(200, {
          ...securityHeaders,
          "Content-Type": artifact.mediaType ?? "application/octet-stream",
          "Content-Disposition": `inline; filename="${artifact.label.replace(/["\\\r\n]/g, "_")}"`,
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Length": contents.byteLength
        });
        response.end(contents);
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const timer = setInterval(() => {
    void refresh().then((changed) => { if (changed) broadcast(); }).catch((error: unknown) => {
      const message = JSON.stringify({ message: error instanceof Error ? error.message : String(error) });
      for (const client of clients.keys()) client.write(`event: trace-error\ndata: ${message}\n\n`);
    });
  }, intervalMs);
  const ping = setInterval(() => {
    for (const client of clients.keys()) client.write(": keepalive\n\n");
  }, 15_000);
  const address = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url,
    host,
    port: address.port,
    snapshot,
    close: async () => {
      clearInterval(timer);
      clearInterval(ping);
      for (const client of clients.keys()) client.end();
      clients.clear();
      await closeServer(server);
    }
  };
}
