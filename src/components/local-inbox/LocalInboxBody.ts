import { createElement, type ReactElement } from "react";
import type { LocalInboxMessage } from "@/lib/local-inbox-api";

/** Render captured bodies as React text children so payload markup stays inert. */
export function LocalInboxBody({ message }: { message: LocalInboxMessage }): ReactElement {
  return createElement(
    "pre",
    {
      "aria-label": message.type === "webhook" ? "Webhook JSON payload" : message.type === "sms" ? "SMS message body" : "Email plain-text body",
      className: "whitespace-pre-wrap break-words px-5 py-5 font-mono text-sm leading-6 text-foreground",
    },
    (message.type === "sms" ? message.body : message.textBody) || "(This message has no plain-text body.)",
  );
}
