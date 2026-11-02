import { redirect } from "@tanstack/react-router";
import { checkLocalInboxHealth } from "./local-inbox-api.ts";

/** Resolve TanStack client-side visits to / without bypassing private auth. */
export async function beforeLoadInboxRoute(): Promise<void> {
  // The server middleware handles full document requests. This guard covers
  // client-side Link/navigation transitions that do not reach that middleware.
  if (typeof window === "undefined") return;

  try {
    await checkLocalInboxHealth();
  } catch {
    // No verified local capability: continue to the authenticated inbox route.
    return;
  }

  throw redirect({ to: "/local-inbox", replace: true });
}
