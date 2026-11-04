import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { ensureRuntime, type DevCaughtRuntime } from "./runtime.ts";
import { createLocalInboxMiddleware } from "./http/local-inbox.ts";
import { isNumericLoopbackHost } from "./config.ts";

type RuntimeSlot = { runtime?: DevCaughtRuntime; starting?: Promise<DevCaughtRuntime> };
type RuntimeGlobal = typeof globalThis & { __devcaughtRuntime?: RuntimeSlot };

function assertIsolatedConfiguration(server: ViteDevServer): void {
  if (server.config.server.host !== "127.0.0.1") {
    throw new Error("Isolated local capture requires Vite host 127.0.0.1");
  }

  const host = process.env.DEVCAUGHT_HOST;
  if (!host || !isNumericLoopbackHost(host)) {
    throw new Error("Isolated local capture requires DEVCAUGHT_HOST to be a numeric loopback address");
  }
  if (process.env.DEVCAUGHT_SMTP_ROUTING_MODE !== "local") {
    throw new Error("Isolated local capture requires DEVCAUGHT_SMTP_ROUTING_MODE=local");
  }
  if (process.env.DEVCAUGHT_SMS_ROUTING_MODE) {
    throw new Error("Isolated local capture does not allow private SMS routing");
  }

  const dbPath = process.env.DEVCAUGHT_DB_PATH;
  if (!dbPath || !path.isAbsolute(dbPath)) {
    throw new Error("Isolated local capture requires an absolute disposable DEVCAUGHT_DB_PATH");
  }
  const resolvedDbPath = path.resolve(dbPath);
  const relativeDbPath = path.relative(tmpdir(), resolvedDbPath);
  if (!relativeDbPath || relativeDbPath === ".." || relativeDbPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDbPath)) {
    throw new Error("Isolated local capture database must be below the system temporary directory");
  }
  for (const candidate of [
    resolvedDbPath,
    `${resolvedDbPath}-wal`,
    `${resolvedDbPath}-shm`,
    `${resolvedDbPath}-journal`,
  ]) {
    if (existsSync(candidate)) {
      throw new Error("Isolated local capture database and sidecars must not already exist");
    }
  }

  const runtimeGlobal = globalThis as RuntimeGlobal;
  if (runtimeGlobal.__devcaughtRuntime?.runtime || runtimeGlobal.__devcaughtRuntime?.starting) {
    throw new Error("Isolated local capture requires a fresh DevCaught runtime process");
  }
}

function assertLocalRuntime(runtime: DevCaughtRuntime): void {
  if (
    runtime.config.smtpRoutingMode !== "local" ||
    !isNumericLoopbackHost(runtime.config.host) ||
    runtime.config.host !== process.env.DEVCAUGHT_HOST ||
    runtime.config.smsRoutingMode !== undefined ||
    runtime.privateSmsIngest !== undefined ||
    runtime.dbMode !== "file" ||
    runtime.config.dbPath !== path.resolve(process.env.DEVCAUGHT_DB_PATH ?? "") ||
    !runtime.smtp.status.running ||
    runtime.smtp.status.host !== runtime.config.host ||
    runtime.smtp.status.port !== runtime.config.smtpPort ||
    runtime.http.running
  ) {
    throw new Error("DevCaught runtime did not start in isolated local-capture mode");
  }
}

/** Test-only Vite integration for local SMTP and synthetic Local Inbox capture. */
export function devcaughtLocalCapturePlugin(): Plugin {
  let runtimePromise: Promise<DevCaughtRuntime> | undefined;
  let acquiredRuntime: DevCaughtRuntime | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let revokeLocalApi: (() => void) | undefined;

  const shutdown = () => {
    shutdownPromise ??= (async () => {
      revokeLocalApi?.();
      if (!runtimePromise) return;

      let runtime = acquiredRuntime;
      if (!runtime) {
        try {
          runtime = await runtimePromise;
        } catch {
          runtime = acquiredRuntime;
          if (!runtime) return;
        }
      }

      const errors: unknown[] = [];
      try {
        await runtime.smtp.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        runtime.store.close();
      } catch (error) {
        errors.push(error);
      }

      const runtimeGlobal = globalThis as RuntimeGlobal;
      if (runtimeGlobal.__devcaughtRuntime?.runtime === runtime) {
        delete runtimeGlobal.__devcaughtRuntime;
      }
      if (errors.length) throw new AggregateError(errors, "Isolated local runtime shutdown failed");
    })();
    return shutdownPromise;
  };

  return {
    name: "devcaught-local-capture-test",
    apply: (_config, env) => env.command === "serve" && !env.isPreview,
    config() {
      return { server: { host: "127.0.0.1", cors: false } };
    },
    configureServer(server) {
      assertIsolatedConfiguration(server);
      const localApi = createLocalInboxMiddleware(server, async () => {
        if (!runtimePromise) throw new Error("Isolated local runtime is not ready");
        return runtimePromise;
      });
      revokeLocalApi = localApi.revoke;
      server.middlewares.use(localApi.handler);
      server.httpServer?.once("close", () => { void shutdown(); });

      runtimePromise = ensureRuntime().then(runtime => {
        acquiredRuntime = runtime;
        assertLocalRuntime(runtime);
        return runtime;
      });
      void runtimePromise.catch(error => {
        console.error("[DevCaught] isolated local runtime failed to start", error);
      });
    },
    closeServer: shutdown,
  };
}
