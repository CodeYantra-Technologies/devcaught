import { createServer, type Server } from "node:http";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../../../../packages/shared/src/constants.ts";
import { portInUseMessage } from "../config.ts";
import type { DevCaughtRuntime } from "../runtime.ts";
import { createApiApp } from "./app.ts";

type HttpSlot = {
  server?: Server;
  starting?: Promise<Server | null>;
};

const httpKey = "__devcaughtHttp" as const;

function slot(): HttpSlot {
  const g = globalThis as typeof globalThis & { [httpKey]?: HttpSlot };
  if (!g[httpKey]) g[httpKey] = {};
  return g[httpKey];
}

async function isOurHttpListener(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    const body = (await response.json()) as { product?: string };
    return body.product === PRODUCT_NAME;
  } catch {
    return false;
  }
}

export async function startHttpListener(runtime: DevCaughtRuntime): Promise<Server | null> {
  const current = slot();
  if (current.server?.listening) {
    const address = current.server.address();
    const port =
      address && typeof address === "object" ? address.port : runtime.config.httpPort;
    runtime.setHttpStatus({
      running: true,
      host: runtime.config.host,
      port,
      error: null,
    });
    return current.server;
  }
  if (current.starting) return current.starting;
  current.starting = listen(runtime);
  try {
    current.server = (await current.starting) ?? undefined;
    return current.server ?? null;
  } finally {
    current.starting = undefined;
  }
}

async function listen(runtime: DevCaughtRuntime): Promise<Server | null> {
  const api = createApiApp(runtime);
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          product: PRODUCT_NAME,
          tagline: PRODUCT_TAGLINE,
          smtp: runtime.smtp.status,
          http: {
            ...runtime.http,
            running: true,
            host: runtime.config.host,
            port: runtime.config.httpPort,
          },
          links: {
            health: "/api/health",
            status: "/api/status",
            messages: "/api/messages",
          },
        }),
      );
      return;
    }
    if (url.startsWith("/api")) {
      req.url = url.slice("/api".length) || "/";
    }
    api(req, res);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("error", onError);
        reject(error);
      };
      server.on("error", onError);
      server.listen(runtime.config.httpPort, runtime.config.host, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address();
    const port =
      address && typeof address === "object" ? address.port : runtime.config.httpPort;
    runtime.setHttpStatus({
      running: true,
      host: runtime.config.host,
      port,
      error: null,
    });
    console.log(`[DevCaught] HTTP listening on ${runtime.config.host}:${port}`);
    return server;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      const existing = slot().server;
      if (existing?.listening) {
        runtime.setHttpStatus({
          running: true,
          host: runtime.config.host,
          port: runtime.config.httpPort,
          error: null,
        });
        return existing;
      }
      if (await isOurHttpListener(runtime.config.host, runtime.config.httpPort)) {
        runtime.setHttpStatus({
          running: true,
          host: runtime.config.host,
          port: runtime.config.httpPort,
          error: null,
        });
        return null;
      }
    }
    const message =
      err.code === "EADDRINUSE"
        ? portInUseMessage(
            "HTTP",
            runtime.config.host,
            runtime.config.httpPort,
            "DEVCAUGHT_HTTP_PORT",
          )
        : err.message || "Failed to start HTTP server";
    runtime.setHttpStatus({
      running: false,
      host: runtime.config.host,
      port: runtime.config.httpPort,
      error: message,
    });
    console.error(`[DevCaught] ${message}`);
    return null;
  }
}
