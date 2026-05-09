import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "error" | "pending";

export interface ToastInput {
  id?: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  href?: string;
  hrefLabel?: string;
  /** Auto-dismiss after N ms. 0 / undefined = sticky. */
  ttlMs?: number;
}

interface Toast extends ToastInput {
  id: string;
  tone: ToastTone;
  createdAt: number;
}

interface ToastContextValue {
  push: (t: ToastInput) => string;
  update: (id: string, patch: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
}

const Ctx = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be inside <ToastProvider>");
  return v;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((input: ToastInput): string => {
    const id = input.id ?? `t${++counter.current}`;
    setToasts((cur) => {
      const filtered = cur.filter((t) => t.id !== id);
      return [
        ...filtered,
        {
          ...input,
          id,
          tone: input.tone ?? "info",
          createdAt: Date.now(),
        },
      ];
    });
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<ToastInput>) => {
    setToasts((cur) =>
      cur.map((t) => (t.id === id ? { ...t, ...patch, id, tone: patch.tone ?? t.tone } : t)),
    );
  }, []);

  const value = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (!toast.ttlMs) return;
    const id = window.setTimeout(() => onDismiss(toast.id), toast.ttlMs);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.ttlMs, onDismiss]);

  const toneClasses: Record<ToastTone, string> = {
    info: "border-border text-foreground",
    pending: "border-[color:var(--color-warning)]/40 text-[color:var(--color-warning)]",
    success: "border-[color:var(--color-touch)]/40 text-[color:var(--color-touch)]",
    error: "border-[color:var(--color-no-touch)]/40 text-[color:var(--color-no-touch)]",
  };

  const dotClasses: Record<ToastTone, string> = {
    info: "bg-foreground/40",
    pending: "bg-[color:var(--color-warning)] animate-pulse",
    success: "bg-[color:var(--color-touch)]",
    error: "bg-[color:var(--color-no-touch)]",
  };

  return (
    <div
      className={cn(
        "rounded-sm bg-card/95 backdrop-blur px-3 py-2 border shadow-lg font-mono text-[12px] flex gap-3 items-start",
        toneClasses[toast.tone],
      )}
    >
      <span className={cn("size-2 rounded-full mt-1.5 shrink-0", dotClasses[toast.tone])} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="font-medium text-[12px] text-foreground">{toast.title}</div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="text-muted-foreground hover:text-foreground text-[14px] leading-none -mt-0.5"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
        {toast.description && (
          <div className="mt-0.5 text-[11px] text-muted-foreground break-words">
            {toast.description}
          </div>
        )}
        {toast.href && (
          <a
            href={toast.href}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-[11px] underline underline-offset-2 hover:opacity-80"
          >
            {toast.hrefLabel ?? "view"}
          </a>
        )}
      </div>
    </div>
  );
}
