import { Bell, X } from 'lucide-react';
import { useAlerts } from '../lib/alerts';

export default function AlertBanner() {
  const { notifications, dismissNotification } = useAlerts();
  const visible = notifications.filter(n => !n.dismissed);
  if (visible.length === 0) return null;

  return (
    <div className="fixed left-0 right-0 top-0 z-[300] flex flex-col gap-1 p-2 pointer-events-none">
      {visible.map(n => (
        <div
          key={n.id}
          className="pointer-events-auto flex items-center gap-2.5 rounded-md border border-yellow-300/90 bg-yellow-300 px-3 py-2 shadow-lg shadow-yellow-500/30"
        >
          <Bell size={12} className="shrink-0 text-yellow-950" />
          <span className="flex-1 font-mono text-[11px] text-yellow-950">
            <span className="text-black">{n.symbol}</span>
            {' — '}
            {n.label}
            {' → '}
            <span className="text-yellow-900/80">{n.triggeredValue.toFixed(2)}</span>
          </span>
          <button
            type="button"
            onClick={() => dismissNotification(n.id)}
            className="flex h-5 w-5 items-center justify-center rounded text-yellow-950/60 transition-colors hover:bg-black/10 hover:text-black"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
