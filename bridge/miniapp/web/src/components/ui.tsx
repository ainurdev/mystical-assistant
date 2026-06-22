import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
}) {
  const base =
    "px-4 py-2.5 rounded-lg text-sm font-medium transition-opacity active:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-[var(--tg-button)] text-[var(--tg-button-text)]"
      : "bg-[var(--tg-secondary-bg)] text-[var(--tg-text)]";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl bg-[var(--tg-secondary-bg)] p-3 ${className}`}
    >
      {children}
    </div>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "error" | "info";
  children: ReactNode;
}) {
  const color =
    tone === "error"
      ? "bg-red-500/15 text-red-300"
      : "bg-[var(--tg-secondary-bg)] text-[var(--tg-hint)]";
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${color}`}>{children}</div>
  );
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-green-400"
      : status === "exited" || status === "error"
        ? "bg-red-400"
        : "bg-[var(--tg-hint)]";
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />
  );
}
