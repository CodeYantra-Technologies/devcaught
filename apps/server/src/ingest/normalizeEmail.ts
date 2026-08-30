import type { AddressObject, ParsedMail } from "mailparser";
import type { MessageSource, NormalizedMessage } from "../../../../packages/shared/src/types.ts";

function formatAddresses(field?: AddressObject | AddressObject[]): string {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list
    .flatMap((entry) =>
      entry.value.map((value) => {
        if (value.name && value.address) return `${value.name} <${value.address}>`;
        return value.address || value.name || "";
      }),
    )
    .filter(Boolean)
    .join(", ");
}

export function normalizeParsedMail(
  parsed: ParsedMail,
  rawData: string,
  source: MessageSource,
): NormalizedMessage {
  return {
    type: "email",
    source,
    sender: formatAddresses(parsed.from) || parsed.from?.text || "",
    recipient: formatAddresses(parsed.to) || (parsed.to && !Array.isArray(parsed.to) ? parsed.to.text : "") || "",
    subject: parsed.subject ?? null,
    textBody: parsed.text?.toString() ?? "",
    htmlBody: typeof parsed.html === "string" ? parsed.html : "",
    rawData,
    createdAt: parsed.date?.getTime() ?? Date.now(),
  };
}

export function normalizeTestEmail(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}): NormalizedMessage {
  const subject = input.subject || "";
  const text = input.text || "";
  const html = input.html || "";
  const raw = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    html
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
    "",
    html || text,
  ].join("\r\n");

  return {
    type: "email",
    source: "test",
    sender: input.from,
    recipient: input.to,
    subject: subject || null,
    textBody: text,
    htmlBody: html,
    rawData: raw,
    createdAt: Date.now(),
  };
}
