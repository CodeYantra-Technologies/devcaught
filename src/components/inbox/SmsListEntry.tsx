import { formatDistanceToNow } from "date-fns";
import type { MessageSummary } from "../../../packages/shared/src/types";
import { SmsBadge } from "./SmsBadge";
import { maskPhoneSms } from "../../../packages/shared/src/sms/phone";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** List entry for a caught SMS. Shows the provider, kind, masked address, a
 * short body preview, status and time. Never shows raw phone digits or raw
 * message bytes. */
export function SmsListEntry({
  message,
  selectedId,
  onSelect,
}: {
  message: MessageSummary & { sms?: MessageSummary["sms"] };
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const sms = message.sms;
  const selected = message.id === selectedId;

  if (!sms) {
    // Fall back to the generic email/webhook list entry.
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
              {message.subject || "(no subject)"}
            </p>
            <span className="shrink-0 text-xs text-subtle tabular-nums">
              {formatDistanceToNow(message.createdAt, { addSuffix: true })}
            </span>
          </div>
          <p className="line-clamp-1 text-xs text-muted">From: {maskPhoneSms(message.sender)}</p>
          <p className="line-clamp-1 text-xs text-subtle">To: {maskPhoneSms(message.recipient)}</p>
        </button>
      </li>
    );
  }

  const statusBadge =
    sms.status && sms.status.trim().length > 0 ? (
      <Badge key="status" variant="test" className="mr-2 align-middle">
        {sms.status}
      </Badge>
    ) : null;

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
            <SmsBadge sms={sms} />
            {sms.messageSid ?? "(no message id)"}
          </p>
          <span className="shrink-0 text-xs text-subtle tabular-nums">
            {formatDistanceToNow(message.createdAt, { addSuffix: true })}
          </span>
        </div>
        <p className="line-clamp-1 text-xs text-muted">From: {maskPhoneSms(sms.from)}</p>
        <p className="line-clamp-1 text-xs text-subtle">To: {maskPhoneSms(sms.to)}</p>
        <p className="line-clamp-1 text-xs text-foreground/80">{sms.body || "No body."}</p>
        {statusBadge}
      </button>
    </li>
  );
}
