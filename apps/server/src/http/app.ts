import express from "express";
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
    res.status(result.status).type(result.contentType ?? "text/plain").send(result.text);
    return;
  }
  res.status(result.status).json(result.body ?? {});
}

export function createApiApp(runtime: DevCaughtRuntime): express.Express {
  const app = express();
  app.disable("x-powered-by");
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

  return app;
}
