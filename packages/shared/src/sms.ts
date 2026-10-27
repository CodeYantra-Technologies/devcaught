import type { SmsProvider } from "./types.ts";

/**
 * The SMS ingest security contract. Defined here — as pure, testable logic —
 * so the HTTP layer (S2) enforces exactly this and cannot drift:
 *
 * - Public provider callback paths (Twilio, MSG91) FAIL CLOSED: with no
 *   verification credentials configured, the request is refused (403) and nothing
 *   is stored. DevCaught never silently accepts unverifiable "authentic"
 *   provider events on a public endpoint.
 * - Local simulation is a SEPARATE endpoint that must never be routed publicly;
 *   it is the only producer of verification "local".
 */
export type SmsIngestPolicy =
  | { readonly mode: "verify"; readonly provider: Exclude<SmsProvider, "simulated"> }
  | { readonly mode: "fail_closed" }
  | { readonly mode: "accept_local" };

/**
 * Resolve how an SMS ingest attempt must be handled.
 *
 * @param provider                               provider claimed by the request
 * @param verificationCredentialsConfigured       whether the matching secret
 *   (Twilio auth token / MSG91 webhook secret) is configured on this server
 */
export function resolveSmsIngestPolicy(
  provider: SmsProvider,
  verificationCredentialsConfigured: boolean,
): SmsIngestPolicy {
  if (provider === "simulated") return { mode: "accept_local" };
  if (!verificationCredentialsConfigured) return { mode: "fail_closed" };
  return { mode: "verify", provider };
}
