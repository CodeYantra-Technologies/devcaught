import { linkParser } from "./linkParser.ts";
import { otpParser } from "./otpParser.ts";
import type { Parser } from "./types.ts";

export { htmlToText, messageCorpus } from "./htmlText.ts";
export { linkParser } from "./linkParser.ts";
export { otpParser } from "./otpParser.ts";
export { runParsers } from "./runParsers.ts";
export type { ParseInput, Parser } from "./types.ts";

export const defaultParsers: Parser[] = [otpParser, linkParser];
