import { formatDistanceToNow } from "date-fns";
import type { MessageSummary } from "../../../packages/shared/src/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function senderName(sender: string) {
  const match = sender.match(/^"?([^"<]+)"?\s*</);
  return (match?.[1] ?? sender).trim() || "Unknown sender";
}

export function MessageList({
  messages,
  selectedId,
  onSelect,
}: {
  messages: MessageSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium text-foreground">Inbox is empty</p>
        <p className="mt-2 max-w-xs text-sm text-muted">
          Point your app at the local SMTP server, or catch a test email from the composer. Test
          ingest is not an SMTP health check.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {messages.map((message) => {
        const otp = message.detections.find((d) => d.type === "otp");
        const selected = message.id === selectedId;
        return (
          <li key={message.id}>
            <button
              type="button"
              onClick={() => onSelect(message.id)}
              className={cn(
                "flex min-h-11 w-full flex-col gap-1 px-4 py-3.5 text-left transition-colors",
                selected ? "bg-surface-2" : "hover:bg-surface-2/70",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="line-clamp-1 text-sm font-medium text-foreground">
                  {otp ? (
                    <Badge variant="otp" className="mr-2 align-middle">
                      OTP
                    </Badge>
                  ) : null}
                  {message.source === "test" ? (
                    <Badge variant="test" className="mr-2 align-middle">
                      TEST
                    </Badge>
                  ) : null}
                  {message.subject || "(no subject)"}
                </p>
                <span className="shrink-0 text-xs text-subtle tabular-nums">
                  {formatDistanceToNow(message.createdAt, { addSuffix: true })}
                </span>
              </div>
              <p className="line-clamp-1 text-xs text-muted">From: {senderName(message.sender)}</p>
              <p className="line-clamp-1 text-xs text-subtle">To: {message.recipient || "—"}</p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
