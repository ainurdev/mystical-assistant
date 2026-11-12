export function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return <button className="set-toggle" role="switch" aria-checked={on} aria-label={label} data-on={on || undefined} onClick={onClick}><i /></button>;
}
