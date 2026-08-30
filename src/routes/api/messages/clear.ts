import { createFileRoute } from "@tanstack/react-router";
import { handleClear } from "../../../../apps/server/src/http/handlers";
import { ensureRuntime } from "../../../../apps/server/src/runtime";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/messages/clear")({
  server: {
    handlers: {
      POST: async () => toResponse(handleClear(await ensureRuntime())),
    },
  },
});
