import { createFileRoute } from "@tanstack/react-router";
import { handlePrivateInboxRequest } from "@/lib/inbox/private-inbox-api.server";

export const Route = createFileRoute("/api/messages/clear")({
  server: {
    handlers: {
      POST: ({ request }) => handlePrivateInboxRequest(request, "clear"),
    },
  },
});
