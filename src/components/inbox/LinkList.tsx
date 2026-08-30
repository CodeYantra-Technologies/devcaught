import { ExternalLink } from "lucide-react";
import type { Detection } from "../../../packages/shared/src/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./CopyButton";

export function LinkList({ detections }: { detections: Detection[] }) {
  if (detections.length === 0) return null;

  return (
    <section className="rounded-[20px] border border-border bg-surface p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">Detected links</p>
      <ul className="mt-3 space-y-2">
        {detections.map((detection) => (
          <li
            key={detection.value}
            className="flex flex-col gap-2 rounded-[12px] bg-surface-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="min-w-0 break-all font-mono text-xs text-foreground">{detection.value}</p>
            <div className="flex shrink-0 gap-2">
              <CopyButton value={detection.value} />
              <Button variant="secondary" size="sm" asChild>
                <a href={detection.value} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  Open
                </a>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
