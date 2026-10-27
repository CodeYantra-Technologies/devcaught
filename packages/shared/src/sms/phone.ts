/**
 * DevCaught phone-number helper (S1).
 *
 * Pure, dependency-free helper kept in the shared package so every provider
 * adapter (and any future consumer) applies exactly one masking rule.
 *
 * Contract:
 * - `null` for non-string input, empty or whitespace-only strings, or fewer
 *   than four digits (anything too short to mask without losing identity).
 * - The returned string keeps the leading sign (`+` or `-`) and replaces every
 *   digit except the final four with `*`.
 *
 *   maskPhone("+1 415 555 0123") => "+*****0123"
 *   maskPhone("555-0123")        => "***50123"
 *   maskPhone("1234")            => "1234"
 *   maskPhone("+44 20 7193 8000") => "+****8000"
 */
export function maskPhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value === "") return null;

  const sign = value.startsWith("+") ? "+" : value.startsWith("-") ? "-" : "";
  const digits = value.replace(/[^0-9]/g, "");

  // Too short to mask without discarding identity.
  if (digits.length < 4) return null;

  const last4 = digits.slice(-4);
  const masked = digits.slice(0, -4).replace(/./g, "*");
  return sign + masked + last4;
}

/** Safe placeholder rendered for empty or invalid SMS phone input. */
export const PHONE_PLACEHOLDER = "—";

/**
 * SMS phone-number presentation helper.
 *
 * - Raw (unmasked) numbers are masked with the shared `maskPhone` rule.
 * - Values that already carry `maskPhone`'s `*` mask are preserved unchanged
 *   (re-processing would widen the mask and hide the number).
 * - Empty or invalid input returns a safe placeholder instead of the raw
 *   value, so no number ever leaks through display or copy.
 *
 *   maskPhoneSms("+1 415 555 0123")   => "+*******0123"
 *   maskPhoneSms("+*******0123")      => "+*******0123"   (already masked)
 *   maskPhoneSms("")                  => PHONE_PLACEHOLDER
 *   maskPhoneSms("123")               => PHONE_PLACEHOLDER
 *   maskPhoneSms(null as unknown)     => PHONE_PLACEHOLDER
 */
export function maskPhoneSms(input: unknown): string {
  if (typeof input !== "string") return PHONE_PLACEHOLDER;
  const value = input.trim();
  if (value === "") return PHONE_PLACEHOLDER;

  // Already masked: preserve unchanged so re-processing can't widen the mask.
  if (value.includes("*")) return value;

  // Raw number: reuse the shared maskPhone rule.
  const masked = maskPhone(value);
  return masked ?? PHONE_PLACEHOLDER;
}
