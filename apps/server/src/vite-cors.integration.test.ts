import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import type { DevCaughtRuntime } from "./runtime.ts";
import { devcaughtPlugin } from "./vite-plugin.ts";

const healthPath = "/__devcaught/local-inbox/health";

function fakeRuntime(): DevCaughtRuntime {
  return {
    config: { host: "127.0.0.1", smtpRoutingMode: "local" },
    smtp: { status: { running: true, host: "127.0.0.1", port: 1025, error: null }, close: async () => {} },
  } as unknown as DevCaughtRuntime;
}

function encodeLayers(value: string, layers: number): string {
  let encoded = value;
  for (let i = 0; i < layers; i++) encoded = encodeURIComponent(encoded);
  return encoded;
}

function waitForWebSocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Vite HMR WebSocket failed"));
    const timeout = setTimeout(
      () => finish(new Error("Vite HMR WebSocket did not open")),
      timeoutMs,
    );
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    if (socket.readyState === WebSocket.OPEN) finish();
    else if (socket.readyState === WebSocket.CLOSED) onError();
  });
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>(resolve => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      resolve();
    };
    const onClose = () => finish();
    socket.addEventListener("close", onClose, { once: true });
    timeout = setTimeout(finish, 1_000);
    try {
      // The WHATWG WebSocket API has close(), not terminate(). Vite's server
      // is also closed in the enclosing finally block if this handshake stalls.
      socket.close();
    } catch {
      finish();
    }
    if (socket.readyState === WebSocket.CLOSED) finish();
  });
}

test("Vite dev middleware blocks API CORS while retaining same-origin requests, assets, and HMR", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "devcaught-vite-cors-"));
  let vite: ViteDevServer | undefined;
  let socket: WebSocket | undefined;

  try {
    writeFileSync(path.join(root, "index.html"), "<!doctype html><html><body>isolated</body></html>");
    vite = await createViteServer({
      configFile: false,
      root,
      appType: "custom",
      cacheDir: path.join(root, ".vite-cache"),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        // Simulate a permissive user CORS override. The security plugin must
        // still prevent Vite's earlier CORS middleware from authorizing the API.
        cors: { origin: "*" },
      },
      plugins: [
        devcaughtPlugin(async () => {}, async () => fakeRuntime()),
        {
          name: "local-inbox-downstream-probe",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.headers["x-local-inbox-fallthrough-probe"] !== "1") {
                next();
                return;
              }
              res.statusCode = 418;
              res.setHeader("x-local-inbox-downstream", "reached");
              res.end("downstream reached");
            });
          },
        },
      ],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const deniedPreflight = await fetch(`${base}${healthPath}`, {
      method: "OPTIONS",
      headers: {
        origin: "http://untrusted.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);
    assert.equal(deniedPreflight.headers.get("access-control-allow-methods"), null);

    const sameOrigin = await fetch(`${base}${healthPath}`, {
      headers: { origin: base },
    });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(await sameOrigin.json(), { ok: true, mode: "local-capture" });
    assert.equal(sameOrigin.headers.get("access-control-allow-origin"), null);

    const sameOriginOptions = await fetch(`${base}${healthPath}`, {
      method: "OPTIONS",
      headers: { origin: base, "access-control-request-method": "GET" },
    });
    assert.equal(sameOriginOptions.status, 405);
    assert.equal(sameOriginOptions.headers.get("access-control-allow-origin"), null);

    const aliasCases = [
      { label: "encoded leading slash", target: `/${encodeURIComponent(healthPath)}` },
      { label: "decoded double-leading slash", target: "//__devcaught/local-inbox/health" },
      { label: "encoded prefix characters", target: "/%5f%5fdevcaught/local-inbox/health" },
      { label: "encoded separators", target: "/__devcaught%2flocal-inbox%2fhealth" },
      { label: "mixed-depth encoding", target: "/%255f%5fdevcaught%2Flocal-inbox%252fhealth" },
      ...[17, 18, 32, 33].map(layers => ({
        label: `${layers}-layer encoding`,
        target: `/${encodeLayers(healthPath, layers)}`,
      })),
    ];
    const outcomes: string[] = [];
    const violations: string[] = [];
    for (const { label, target } of aliasCases) {
      const response = await fetch(`${base}${target}`, {
        headers: { "x-local-inbox-fallthrough-probe": "1" },
      });
      const body = await response.text();
      if (body === JSON.stringify({ ok: true, mode: "local-capture" })) {
        violations.push(`${label}: canonical health response`);
      }
      const reachedDownstream = response.headers.get("x-local-inbox-downstream") === "reached";
      if (response.status === 400) {
        outcomes.push(`${label}: HTTP parser 400`);
        if (reachedDownstream) violations.push(`${label}: parser 400 also reached downstream`);
        continue;
      }
      if (response.status === 404 && response.headers.get("cache-control") === "no-store" && !reachedDownstream) {
        outcomes.push(`${label}: Local Inbox middleware 404`);
      } else if (reachedDownstream) {
        outcomes.push(`${label}: downstream ${response.status}`);
        violations.push(`${label}: reached downstream middleware with status ${response.status}`);
      } else {
        outcomes.push(`${label}: unexpected status ${response.status}`);
        violations.push(`${label}: missing Local Inbox rejection; status ${response.status}`);
      }
    }
    assert.ok(outcomes.some(result => result.includes("Local Inbox middleware 404")), "at least one alias must exercise the middleware");
    t.diagnostic(outcomes.join("; "));

    const unrelated = await fetch(`${base}/ordinary-unrelated-path`, {
      headers: { "x-local-inbox-fallthrough-probe": "1" },
    });
    assert.equal(unrelated.status, 418);
    assert.equal(unrelated.headers.get("x-local-inbox-downstream"), "reached");

    const unrelatedDoubleSlash = await fetch(`${base}//ordinary/__devcaught/local-inbox/health`, {
      headers: { "x-local-inbox-fallthrough-probe": "1" },
    });
    assert.equal(unrelatedDoubleSlash.status, 418);
    assert.equal(unrelatedDoubleSlash.headers.get("x-local-inbox-downstream"), "reached");

    const clientAsset = await fetch(`${base}/@vite/client`);
    assert.equal(clientAsset.status, 200);
    assert.match(await clientAsset.text(), /WebSocket/);

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/`, "vite-hmr");
    await waitForWebSocketOpen(socket, 3_000);
    assert.deepEqual(violations, [], "all HTTP-parseable reserved aliases must be consumed by Local Inbox");
  } finally {
    try {
      if (socket) await closeWebSocket(socket);
    } finally {
      try {
        await vite?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("live-preview opt-in keeps the Local Inbox API unavailable", async () => {
  const previous = process.env.DEVCAUGHT_LIVE_PREVIEW;
  const root = mkdtempSync(path.join(tmpdir(), "devcaught-vite-preview-cors-"));
  let vite: ViteDevServer | undefined;
  try {
    process.env.DEVCAUGHT_LIVE_PREVIEW = "1";
    vite = await createViteServer({
      configFile: false,
      root,
      appType: "custom",
      cacheDir: path.join(root, ".vite-cache"),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [devcaughtPlugin(async () => {}, async () => fakeRuntime())],
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}${healthPath}`, { headers: { origin: base } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally {
    try {
      await vite?.close();
    } finally {
      if (previous === undefined) delete process.env.DEVCAUGHT_LIVE_PREVIEW;
      else process.env.DEVCAUGHT_LIVE_PREVIEW = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
