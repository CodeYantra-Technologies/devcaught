import type { PrivateInbox } from "../auth/private-inbox.ts";
import type { InboxStore } from "../../../apps/server/src/store/sqlite.ts";
import { InboxService } from "../../../apps/server/src/ingest/inboxService.ts";
import { normalizeTestEmail } from "../../../apps/server/src/ingest/normalizeEmail.ts";
import {
  handleList, handleGet, handleRaw, handleDelete, handleClear, handleTestEmail,
} from "../../../apps/server/src/http/handlers.ts";
import { PRODUCT_NAME } from "../../../packages/shared/src/constants.ts";
import { toResponse } from "../http-result.ts";

export type PrivateInboxOperation = "list" | "detail" | "raw" | "delete" | "clear" | "test" | "status";

export interface PrivateInboxApiDependencies {
  postgresVerified: boolean;
  resolveInbox(request: Request): Promise<PrivateInbox | null>;
  openStore(): Promise<InboxStore>;
}

export function inboxUnavailable() {
  return privateResponse(Response.json({ error: "Private inbox unavailable" }, { status: 503 }));
}

function privateResponse(response: Response) {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("vary", "Cookie");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

/** Injectable request boundary; the runtime supplies only trusted server dependencies. */
export function createPrivateInboxApi(deps: PrivateInboxApiDependencies) {
  return async (request: Request, operation: PrivateInboxOperation, id = ""): Promise<Response> => {
    if (!deps.postgresVerified) return inboxUnavailable();
    try {
      const mutation = operation === "delete" || operation === "clear" || operation === "test";
      const method = operation === "delete" ? "DELETE" : mutation ? "POST" : "GET";
      if (request.method !== method) {
        return privateResponse(Response.json({ error: "Method not allowed" }, { status: 405 }));
      }
      const origin = request.headers.get("origin");
      const site = request.headers.get("sec-fetch-site");
      if ((site && site !== "same-origin" && site !== "none") ||
          (origin !== null && origin !== new URL(request.url).origin) ||
          (mutation && origin === null)) {
        return privateResponse(Response.json({ error: "Forbidden" }, { status: 403 }));
      }

      const inbox = await deps.resolveInbox(request);
      if (!inbox) {
        return privateResponse(Response.json({ error: "Unauthorized" }, { status: 401 }));
      }
      // The root store is never passed to handlers or the service.
      const store = (await deps.openStore()).forInbox(inbox.id);
      const runtime = { store, inbox: new InboxService(store), normalizeTestEmail };
      let response: Response;
      switch (operation) {
        case "list": response = toResponse(handleList(runtime, new URL(request.url).searchParams.get("q") ?? undefined)); break;
        case "detail": response = toResponse(handleGet(runtime, id)); break;
        case "raw":
          response = toResponse(handleRaw(runtime, id));
          if (response.ok) response.headers.set("content-disposition", `attachment; filename="message-${id}.txt"`);
          break;
        case "delete": response = toResponse(handleDelete(runtime, id)); break;
        case "clear": response = toResponse(handleClear(runtime)); break;
        case "test": {
          if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            return privateResponse(Response.json({ error: "JSON required" }, { status: 415 }));
          }
          let input: unknown;
          try { input = await request.json(); }
          catch { return privateResponse(Response.json({ error: "Invalid JSON" }, { status: 400 })); }
          response = toResponse(handleTestEmail(runtime, input));
          break;
        }
        case "status":
          // Private counts only: no global message count, paths, or listener details.
          response = Response.json({ product: PRODUCT_NAME, messageCount: store.count() });
          break;
      }
      return privateResponse(response);
    } catch {
      // Includes verification, registry, SQLite and handler errors. No fallback
      // identities, global storage, raw errors, or connection details.
      return inboxUnavailable();
    }
  };
}
