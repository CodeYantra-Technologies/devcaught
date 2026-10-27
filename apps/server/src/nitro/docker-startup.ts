import { startStandaloneServer } from "../index.ts";

export default async function dockerStartup() {
  const { runtime, server } = await startStandaloneServer();

  let stopping = false;

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;

    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
        runtime.smtp.close(),
      ]);

      runtime.store.close();
      console.log("[DevCaught] Runtime shutdown complete");
    } catch (error) {
      console.error("[DevCaught] Runtime shutdown failed:", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
