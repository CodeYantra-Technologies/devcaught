import type { Plugin } from "vite";
import { startHttpListener } from "./http/listen.ts";
import { ensureRuntime } from "./runtime.ts";

/** Starts SMTP + the HTTP API as soon as the Vite process is up. */
export function devcaughtPlugin(): Plugin {
  return {
    name: "devcaught-runtime",
    configureServer() {
      void boot().catch((error: unknown) => {
        console.error("[DevCaught] failed to start runtime", error);
      });
    },
    configurePreviewServer() {
      void boot().catch((error: unknown) => {
        console.error("[DevCaught] failed to start runtime", error);
      });
    },
  };
}

async function boot() {
  const runtime = await ensureRuntime();
  await startHttpListener(runtime);
}
