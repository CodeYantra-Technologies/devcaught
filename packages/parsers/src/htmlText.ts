/** Strip tags so HTML-only mail can still be parsed. Not a sanitizer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
    .replace(/"/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function messageCorpus(input: {
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}): string {
  const parts = [
    input.subject ?? "",
    input.textBody ?? "",
    input.htmlBody ? htmlToText(input.htmlBody) : "",
  ];
  return parts.filter(Boolean).join("\n");
}
