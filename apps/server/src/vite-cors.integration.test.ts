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

test("Vite dev middleware blocks API CORS while retaining same-origin requests, assets, and HMR", async () => {
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
      plugins: [devcaughtPlugin(async () => {}, async () => fakeRuntime())],
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

    const clientAsset = await fetch(`${base}/@vite/client`);
    assert.equal(clientAsset.status, 200);
    assert.match(await clientAsset.text(), /WebSocket/);

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/`, "vite-hmr");
    await waitForWebSocketOpen(socket, 3_000);
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
