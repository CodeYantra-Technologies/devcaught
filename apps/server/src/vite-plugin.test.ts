import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { devcaughtPlugin } from "./vite-plugin.ts";

async function invoke(handler: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void) {
  let statusCode = 200;
  let finish!: () => void;
  const done = new Promise<number>(resolve => {
    finish = () => resolve(statusCode);
  });
  const req = {
    url: "/__devcaught/local-inbox/health",
    method: "GET",
    headers: { host: "127.0.0.1:8080" },
    rawHeaders: ["Host", "127.0.0.1:8080"],
    socket: { remoteAddress: "127.0.0.1", encrypted: false },
  } as unknown as IncomingMessage;
  const responseState = { statusCode: 200, destroyed: false, writableEnded: false };
  const res = {
    ...responseState,
    setHeader() {},
    end(this: typeof responseState) {
      statusCode = this.statusCode;
      finish();
    },
  } as unknown as ServerResponse & { statusCode: number; destroyed: boolean; writableEnded: boolean };
  handler(req, res, () => { throw new Error("reserved API request fell through"); });
  return done;
}

test("development hook registers the middleware on its Vite server instance", () => {
  let middlewareRegistrations = 0;
  const httpServer = Object.assign(new EventEmitter(), { address: () => null });
  const plugin = devcaughtPlugin(async () => {});
  const hook = plugin.configureServer;
  assert.equal(typeof hook, "function");
  if (typeof hook !== "function") throw new Error("Expected a dev hook");
  hook.call({} as never, {
    httpServer,
    middlewares: { use() { middlewareRegistrations++; } },
  } as never);
  assert.equal(middlewareRegistrations, 1);
  const closeHook = plugin.closeServer;
  if (typeof closeHook === "function") closeHook.call({} as never, { reason: "close" });
});

test("HTTP close revokes only its middleware and plugin close revokes remaining instances", async () => {
  const plugin = devcaughtPlugin(async () => {});
  const configure = plugin.configureServer;
  if (typeof configure !== "function") throw new Error("Expected a dev hook");
  const servers = [0, 1].map(() => {
    const httpServer = Object.assign(new EventEmitter(), { address: () => null });
    let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void) | undefined;
    configure.call({} as never, {
      httpServer,
      middlewares: { use(value: typeof handler) { handler = value; } },
    } as never);
    assert.ok(handler);
    return { httpServer, handler };
  });

  servers[0]!.httpServer.emit("close");
  assert.equal(await invoke(servers[0]!.handler!), 503, "closed server middleware is revoked");
  assert.equal(await invoke(servers[1]!.handler!), 403, "closing one server does not revoke another instance");

  const closeHook = plugin.closeServer;
  if (typeof closeHook === "function") closeHook.call({} as never, { reason: "close" });
  assert.equal(await invoke(servers[1]!.handler!), 503, "plugin shutdown revokes remaining middleware");
});

test("preview hook does not register the development local API middleware", async () => {
  let middlewareRegistrations = 0;
  const plugin = devcaughtPlugin(async () => {});
  const hook = plugin.configurePreviewServer;
  assert.equal(typeof hook, "function");
  if (typeof hook !== "function") throw new Error("Expected a preview hook");
  await hook.call({} as never, {
    middlewares: { use() { middlewareRegistrations++; } },
  } as never);
  assert.equal(middlewareRegistrations, 0);
});

test("CORS is disabled only for the development server, not preview or build", () => {
  const plugin = devcaughtPlugin(async () => {});
  const hook = plugin.config;
  if (typeof hook !== "function") throw new Error("Expected a config hook");

  const dev = hook.call({} as never, {}, {
    command: "serve", mode: "development", isSsrBuild: false, isPreview: false,
  });
  assert.deepEqual(dev, { server: { cors: false } });

  const preview = hook.call({} as never, {}, {
    command: "serve", mode: "development", isSsrBuild: false, isPreview: true,
  });
  assert.equal(preview, undefined);

  const build = hook.call({} as never, {}, {
    command: "build", mode: "production", isSsrBuild: false, isPreview: false,
  });
  assert.equal(build, undefined);
});
