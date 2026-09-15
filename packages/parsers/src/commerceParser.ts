import type { Detection, Parser } from "./types.ts";
import { messageCorpus } from "./htmlText.ts";

type Kind = "payment" | "order" | "transaction";
const kinds: Kind[] = ["payment", "order", "transaction"];
const kindOf = (value: string): Kind | undefined => {
  const name = value.toLowerCase().replace(/[^a-z]/g, "");
  if (name === "paymentintent" || name === "charge") return "payment";
  return kinds.find((kind) => name === kind);
};

/** Deterministic hints, not payment verification. Amounts retain provider units. */
export const commerceParser: Parser = {
  id: "commerce",
  parse(input) {
    const found: Detection[] = [];
    const add = (type: Kind, value: unknown, metadata: Record<string, unknown> = {}) => {
      if (
        (typeof value !== "string" && typeof value !== "number") ||
        String(value).length > 250 ||
        String(value).trim() === ""
      )
        return;
      found.push({
        type,
        value: String(value),
        confidence: 0.95,
        label: `${type} reference`,
        metadata,
      });
    };
    let json: unknown;
    try {
      json = JSON.parse(input.textBody ?? "");
    } catch {
      /* Email / plain text. */
    }
    if (json !== undefined) {
      const walk = (value: unknown, context?: Kind, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 20) return;
        if (Array.isArray(value)) {
          value.forEach((item) => walk(item, context, depth + 1));
          return;
        }
        const record = value as Record<string, unknown>;
        const discriminator = [record.object, record.entity, record.event, record.type].find(
          (v) => typeof v === "string",
        );
        const kind =
          typeof discriminator === "string"
            ? (kindOf(discriminator.split(/[.:/]/)[0]) ?? context)
            : context;
        const metadata: Record<string, unknown> = {};
        for (const key of ["status", "amount", "amount_total", "currency"]) {
          if (typeof record[key] === "string" || typeof record[key] === "number")
            metadata[key] = record[key];
        }
        if (
          kind &&
          record.id !== undefined &&
          !(typeof discriminator === "string" && /[.:/]/.test(discriminator))
        )
          add(kind, record.id, metadata);
        for (const [key, val] of Object.entries(record)) {
          const reference =
            /^(payment(?:_?intent)?|order|transaction)[_\s-]?(?:id|number|reference)$/i.exec(key);
          if (reference) add(kindOf(reference[1])!, val, metadata);
          walk(
            val,
            kindOf(key) ??
              (["data", "payload", "object", "entity"].includes(key) ? kind : undefined),
            depth + 1,
          );
        }
      };
      walk(json);
      // An event name alone is useful even when no entity reference is present.
      if (json && typeof json === "object" && !Array.isArray(json)) {
        const record = json as Record<string, unknown>;
        const event = record.type ?? record.event;
        if (typeof event === "string") {
          const kind = kindOf(event.split(/[.:/]/)[0]);
          if (kind && !found.some((d) => d.type === kind)) add(kind, event, { event });
        }
      }
    } else {
      const text = messageCorpus(input);
      const pattern =
        /\b(payment|order|transaction)\s*(?:id|number|reference|no\.?|#)\s*[:#=-]?\s*([a-z0-9][a-z0-9_-]{1,99})\b/gi;
      for (const match of text.matchAll(pattern)) add(match[1].toLowerCase() as Kind, match[2]);
    }
    return found;
  },
};
