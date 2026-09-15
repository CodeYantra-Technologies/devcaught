import express from "express";
import { normalizeWebhook, WEBHOOK_SIZE_LIMIT } from "../ingest/normalizeWebhook.ts";
import type { DevCaughtRuntime } from "../runtime.ts";
import {
  handleClear,
  handleDelete,
  handleGet,
  handleHealth,
  handleList,
  handleRaw,
  handleStatus,
  handleTestEmail,
  type HandlerResult,
} from "./handlers.ts";

function send(res: express.Response, result: HandlerResult) {
  if (result.text !== undefined) {
    res
      .status(result.status)
      .type(result.contentType ?? "text/plain")
      .send(result.text);
    return;
  }
  res.status(result.status).json(result.body ?? {});
}

export function createApiApp(runtime: DevCaughtRuntime): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.post(
    ["/webhooks", "/webhooks/{*name}"],
    express.raw({ type: () => true, limit: WEBHOOK_SIZE_LIMIT, inflate: false }),
    (req, res) => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : (value ?? ""),
        ]),
      );
      const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      const stored = runtime.inbox.ingest(
        normalizeWebhook({ method: req.method, url: req.originalUrl, headers, body }),
      );
      res.status(201).json({ id: stored.id, ok: true });
    },
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => send(res, handleHealth()));
  app.get("/status", (_req, res) => send(res, handleStatus(runtime)));
  app.get("/messages", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    send(res, handleList(runtime, q));
  });
  app.get("/messages/:id/raw", (req, res) => send(res, handleRaw(runtime, req.params.id)));
  app.get("/messages/:id", (req, res) => send(res, handleGet(runtime, req.params.id)));
  app.delete("/messages/:id", (req, res) => send(res, handleDelete(runtime, req.params.id)));
  app.post("/messages/clear", (_req, res) => send(res, handleClear(runtime)));
  app.post("/messages/test", (req, res) => send(res, handleTestEmail(runtime, req.body)));

  app.use(
    (
      error: { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = error.status ?? 500;
      res
        .status(status)
        .json({
          error:
            status === 413
              ? "Request exceeds 1 MB limit"
              : status === 415
                ? "Unsupported content encoding"
                : status === 400
                  ? "Invalid request body"
                  : "Could not capture request",
        });
    },
  );
  return app;
}
