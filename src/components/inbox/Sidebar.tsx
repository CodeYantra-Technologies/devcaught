import { Inbox, Settings } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const links = [
  { to: "/", label: "Inbox", icon: Inbox },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: 4000,
  });

  const smtpRunning = status.data?.smtp.running ?? false;

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface">
      <div className="px-5 pb-4 pt-6">
        <Link to="/" className="block">
          <p className="font-display text-lg font-medium tracking-tight text-foreground">DevCaught</p>
          <p className="mt-1 text-xs text-subtle">Everything your app sends. Caught.</p>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {links.map((link) => {
          const active = pathname === link.to;
          const Icon = link.icon;
          return (
            <Link
              key={link.to}
              to={link.to}
              className={cn(
                "flex h-11 items-center gap-2 rounded-[12px] px-3 text-sm font-medium transition-colors",
                active ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border px-5 py-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">SMTP server</p>
        <p className="mt-2 flex items-center gap-2 text-sm">
          <span
            className={cn("size-2 rounded-full", smtpRunning ? "bg-otp" : "bg-danger")}
            aria-hidden
          />
          <span className="text-foreground">{smtpRunning ? "Running" : "Stopped"}</span>
        </p>
        {status.data ? (
          <p className="mt-1 font-mono text-xs text-subtle">
            {status.data.smtp.host}:{status.data.smtp.port}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
