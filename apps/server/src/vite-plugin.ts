import type { Plugin } from "vite";
import { createLocalInboxMiddleware } from "./http/local-inbox.ts";
import { startHttpListener } from "./http/listen.ts";
import { ensureRuntime } from "./runtime.ts";

/** Starts SMTP + the HTTP API as soon as the Vite process is up. */
export function devcaughtPlugin(startRuntime: () => Promise<void> = boot): Plugin {
  const revokeLocalApi = new Set<() => void>();
  return {
    name: "devcaught-runtime",
    configureServer(server) {
      const localApi = createLocalInboxMiddleware(server);
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
