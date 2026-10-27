import { createFileRoute } from "@tanstack/react-router";
import { handlePrivateInboxRequest } from "@/lib/inbox/private-inbox-api.server";

export const Route = createFileRoute("/api/messages/test")({
  server: {
    handlers: {
      POST: ({ request }) => handlePrivateInboxRequest(request, "test"),
    },
  },
});
