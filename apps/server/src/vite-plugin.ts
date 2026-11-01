import type { Plugin } from "vite";
import { createLocalInboxMiddleware } from "./http/local-inbox.ts";
import { startHttpListener } from "./http/listen.ts";
import { ensureRuntime } from "./runtime.ts";

/** Starts SMTP + the HTTP API as soon as the Vite process is up. */
export function devcaughtPlugin(
  startRuntime: () => Promise<void> = boot,
  getLocalApiRuntime = ensureRuntime,
): Plugin {
  const revokeLocalApi = new Set<() => void>();
  return {
    name: "devcaught-runtime",
    config(_config, env) {
      // Vite's built-in CORS runs before configureServer middleware and cannot
      // apply a path-specific policy. DevCaught's dashboard is same-origin, as
      // are its assets and WebSocket HMR, so disable dev-server CORS. Preview
      // has no Local Inbox middleware and retains its independent CORS policy.
      if (env.command === "serve" && !env.isPreview) return { server: { cors: false } };
    },
    configureServer(server) {
      const localApi = createLocalInboxMiddleware(server, getLocalApiRuntime);
      const revoke = () => {
        localApi.revoke();
        revokeLocalApi.delete(revoke);
      };
      revokeLocalApi.add(revoke);
      server.middlewares.use(localApi.handler);
      server.httpServer?.once("close", revoke);
      void startRuntime().catch((error: unknown) => {
        console.error("[DevCaught] failed to start runtime", error);
      });
    },
    configurePreviewServer() {
      void startRuntime().catch((error: unknown) => {
        console.error("[DevCaught] failed to start runtime", error);
      });
    },
    closeServer() {
      for (const revoke of [...revokeLocalApi]) revoke();
    },
  };
}

async function boot() {
  const runtime = await ensureRuntime();
  await startHttpListener(runtime);
}
