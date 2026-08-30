import type { Detection, ParseInput } from "./types.ts";
import { htmlToText, messageCorpus } from "./htmlText.ts";

const URL_RE = /https?:\/\/[^\s<>"'\\]+/gi;
const HREF_RE = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[).,;:!?]+$/g, "");
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function collect(text: string, re: RegExp, group = 0): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = stripTrailingPunctuation(match[group] ?? match[0]);
    if (isSafeHttpUrl(raw)) out.push(raw);
  }
  return out;
}

export const linkParser = {
  id: "url",
  parse(input: ParseInput): Detection[] {
    const urls = new Set<string>();

    for (const url of collect(messageCorpus(input), URL_RE)) urls.add(url);
    if (input.htmlBody) {
      for (const url of collect(input.htmlBody, HREF_RE, 1)) urls.add(url);
      for (const url of collect(htmlToText(input.htmlBody), URL_RE)) urls.add(url);
    }

    return [...urls].map((value) => ({
      type: "url" as const,
      value,
      confidence: 0.9,
    }));
  },
};
