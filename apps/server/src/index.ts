import { startHttpListener } from "./http/listen.ts";
import { ensureRuntime } from "./runtime.ts";

export { createApiApp } from "./http/app.ts";
export { startHttpListener } from "./http/listen.ts";
export { ensureRuntime } from "./runtime.ts";
export { loadConfig } from "./config.ts";

export async function startStandaloneServer() {
  const runtime = await ensureRuntime();
  const server = await startHttpListener(runtime);
  if (!runtime.http.running || !server) {
    process.exitCode = 1;
    throw new Error(runtime.http.error ?? "HTTP server failed to start");
  }
  return { runtime, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startStandaloneServer();
}
