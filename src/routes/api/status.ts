import { createFileRoute } from "@tanstack/react-router";
import { handlePrivateInboxRequest } from "@/lib/inbox/private-inbox-api.server";

export const Route = createFileRoute("/api/status")({
  server: {
    handlers: {
      GET: ({ request }) => handlePrivateInboxRequest(request, "status"),
    },
  },
});
