import type { SmsEvent } from "../../../packages/shared/src/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function kindLabel(kind: SmsEvent["kind"]): string {
  return kind === "delivery_status" ? "DELIVERY" : "INBOUND";
}

function statusVariant(status: SmsEvent["status"]): "default" | "otp" | "url" | "test" {
  const upper = (status ?? "").trim().toUpperCase();
  if (upper === "DELIVERED") return "default";
  if (upper === "FAILED" || upper === "REJECTED" || upper === "BLOCKED") return "test";
  if (upper === "RECEIVED") return "otp";
  return "default";
}

export function SmsBadge({
  sms,
  className,
}: {
  sms: SmsEvent;
  className?: string;
}) {
  const provider = sms.provider.toUpperCase();
  const kind = kindLabel(sms.kind);
  const statusBadge =
    sms.status && sms.status.trim().length > 0 ? (
      <Badge key="status" variant={statusVariant(sms.status)} className="mr-2 align-middle">
        {sms.status}
      </Badge>
    ) : null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      <Badge variant="url" className="mr-2">
        SMS
      </Badge>
      <Badge variant="url" className="mr-2">
        {provider}
      </Badge>
      <Badge variant="url" className="mr-2 uppercase">
        {kind}
      </Badge>
      {statusBadge}
    </span>
  );
}
