import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";

interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  viewportClassName?: string;
  viewportStyle?: CSSProperties;
  contentClassName?: string;
  trackClassName?: string;
  thumbClassName?: string;
}

function mergeRefs<T>(refs: Array<Ref<T> | undefined>, value: T) {
  refs.forEach((ref) => {
    if (!ref) return;
    if (typeof ref === "function") {
      ref(value);
      return;
    }
    (ref as MutableRefObject<T>).current = value;
  });
}

const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    children,
    className,
    viewportClassName,
    viewportStyle,
    contentClassName,
    trackClassName,
    thumbClassName,
    ...rest
  },
  forwardedRef,
) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState({ thumbHeight: 0, thumbOffset: 0, visible: false });

  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    mergeRefs([forwardedRef], node);
  }, [forwardedRef]);

  const updateMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const { clientHeight, scrollHeight, scrollTop } = viewport;
    if (scrollHeight <= clientHeight + 1) {
      setMetrics((prev) => (
        prev.visible ? { thumbHeight: 0, thumbOffset: 0, visible: false } : prev
      ));
      return;
    }

    const rawThumbHeight = (clientHeight / scrollHeight) * clientHeight;
    const thumbHeight = Math.max(28, Math.min(clientHeight, rawThumbHeight));
    const travel = Math.max(0, clientHeight - thumbHeight);
    const maxScroll = Math.max(1, scrollHeight - clientHeight);
    const thumbOffset = (scrollTop / maxScroll) * travel;

    setMetrics({ thumbHeight, thumbOffset, visible: true });
  }, []);

  useEffect(() => {
    updateMetrics();

    const viewport = viewportRef.current;
    if (!viewport) return;

    const onScroll = () => updateMetrics();
    viewport.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateMetrics());
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) {
      resizeObserver.observe(viewport.firstElementChild);
    }

    window.addEventListener("resize", updateMetrics);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateMetrics);
    };
  }, [children, updateMetrics]);

  return (
    <div className={`relative ${className ?? ""}`} {...rest}>
      <div
        ref={setViewportRef}
        className={`scrollbar-none overflow-y-auto ${viewportClassName ?? ""}`}
        style={viewportStyle}
      >
        {contentClassName ? <div className={contentClassName}>{children}</div> : children}
      </div>

      {metrics.visible ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-1 right-1 w-1 rounded-full bg-white/[0.05] ${trackClassName ?? ""}`}
        >
          <div
            className={`absolute left-0 right-0 rounded-full bg-white/[0.18] ${thumbClassName ?? ""}`}
            style={{
              height: metrics.thumbHeight,
              transform: `translateY(${metrics.thumbOffset}px)`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
});

export default ScrollArea;
