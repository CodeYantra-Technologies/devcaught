import { getRequest } from "@tanstack/react-start/server";
import { auth, authConfigured, authDatabase } from "./server";
import { resolvePrivateInbox } from "./private-inbox.ts";
import { UnauthorizedError } from "./verify.server";

/** Request-bound entry point. No client identity/inbox parameters or dev fallback. */
export async function requirePrivateInbox() {
  const request = getRequest();
  if (!request) throw new UnauthorizedError();
  const inbox = await resolvePrivateInbox(auth, request.headers, authConfigured, authDatabase, {
    provisionMissing: false,
  });
  if (!inbox) throw new UnauthorizedError();
  return inbox;
}
