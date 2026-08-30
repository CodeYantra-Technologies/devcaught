import { createFileRoute } from "@tanstack/react-router";
import { handleHealth } from "../../../apps/server/src/http/handlers";
import { toResponse } from "@/lib/http-result";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => toResponse(handleHealth()),
    },
  },
});
