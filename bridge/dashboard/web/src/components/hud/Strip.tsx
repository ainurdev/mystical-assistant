export function Strip({ host }: { host: string }) {
  return (
    <div
      className="flex flex-none items-center gap-3.5 border-b border-border px-4 py-[7px]"
      style={{ animation: "flicker .8s ease both" }}
    >
      <span className="glow text-[12px] tracking-[3px] text-primary">MYSTICAL//ASSISTANT</span>
      <span className="text-[11px] tracking-[2px] text-muted-2">REMOTE DEV BRIDGE</span>
      <span className="flex-1" />
      <span className="flex items-center gap-[7px] text-[11px] tracking-[1.5px] text-muted-foreground">
        <span
          className="h-[7px] w-[7px] rounded-full bg-success"
          style={{ animation: "mpulse 2.4s infinite" }}
        />
        BRIDGE ONLINE · {host}
      </span>
      <span className="text-[11px] tracking-[2px] text-muted-2">MAIN SHELL</span>
    </div>
  );
}
