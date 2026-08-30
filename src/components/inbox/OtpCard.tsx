import type { Detection } from "../../../packages/shared/src/types";
import { CopyButton } from "./CopyButton";

export function OtpCard({ detection }: { detection: Detection }) {
  return (
    <section className="rounded-[20px] border border-otp-border bg-otp-bg px-5 py-5">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-otp">OTP detected</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <p className="font-mono text-4xl font-medium tracking-[0.12em] text-foreground tabular-nums">
          {detection.value}
        </p>
        <CopyButton value={detection.value} label="Copy" />
      </div>
      {detection.label ? <p className="mt-3 text-sm text-muted">{detection.label}</p> : null}
    </section>
  );
}
