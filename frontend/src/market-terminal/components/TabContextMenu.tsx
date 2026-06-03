import { useEffect, useRef } from "react";
import { Pencil, Copy, ExternalLink } from "lucide-react";

interface TabContextMenuProps {
  x: number;
  y: number;
  canDetach?: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onDetach?: () => void;
  onClose: () => void;
}

export default function TabContextMenu({
  x,
  y,
  canDetach,
  onRename,
  onDuplicate,
  onDetach,
  onClose,
}: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const itemClass =
    "flex w-full items-center gap-2 text-left px-3 py-1.5 text-[11px] text-white/60 hover:bg-white/[0.06] hover:text-white/80 transition-colors duration-75";

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[140px] rounded-md border border-white/[0.08] bg-[#1C2128] py-1 shadow-xl shadow-black/40"
      style={{ left: x, top: y }}
    >
      <button className={itemClass} onClick={onRename}>
        <Pencil className="h-3 w-3 shrink-0 text-white/30" strokeWidth={1.5} />
        Rename
      </button>
      <button className={itemClass} onClick={onDuplicate}>
        <Copy className="h-3 w-3 shrink-0 text-white/30" strokeWidth={1.5} />
        Duplicate
      </button>
      {canDetach && onDetach && (
        <>
          <div className="mx-2 my-1 h-px bg-white/[0.06]" />
          <button className={itemClass} onClick={onDetach}>
            <ExternalLink className="h-3 w-3 shrink-0 text-blue/70" strokeWidth={1.5} />
            <span className="text-blue/80">Detach</span>
          </button>
        </>
      )}
    </div>
  );
}
