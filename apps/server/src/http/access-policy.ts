/**
 * Shared access policy for DevCaught's HTTP entry points.
 *
 * Until a verified authentication mechanism is connected,
 * sensitive operations must fail closed.
 *
 * Never accept client-supplied user IDs as authorization.
 */

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401; error: "Unauthorized" };

export function requireInboxAccess(): AccessDecision {
  return {
    allowed: false,
    status: 401,
    error: "Unauthorized",
  };
}

export function requireGenericWebhookAccess(): AccessDecision {
  return {
    allowed: false,
    status: 401,
    error: "Unauthorized",
  };
}
