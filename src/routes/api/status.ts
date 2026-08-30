import { createFileRoute } from "@tanstack/react-router";
import { handleStatus } from "../../../apps/server/src/http/handlers";
import { ensureRuntime } from "../../../apps/server/src/runtime";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/status")({
  server: {
    handlers: {
      GET: async () => toResponse(handleStatus(await ensureRuntime())),
    },
  },
});
