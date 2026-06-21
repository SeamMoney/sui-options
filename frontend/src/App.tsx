import { lazy, Suspense } from "react";
import { Ride } from "@/routes/Ride";

// The headline `/` (and `/degen`) route is `Ride`, so it stays eagerly
// imported — it's what a judge hits cold and it must paint instantly.
// Every other route is a separate destination reached only by an explicit
// URL, so we lazy-load them: that keeps the candle-vision scanner (gsap +
// motion + the candle-vision lib), the docs grid, the provable-fairness
// verifier, and the pro terminal OUT of the entry chunk the ride page
// downloads. Pre-split, all of that rode along in one ~3.4 MB bundle.
const CandleVision = lazy(() =>
  import("@/routes/CandleVision").then((m) => ({ default: m.CandleVision })),
);
const Docs = lazy(() => import("@/routes/Docs").then((m) => ({ default: m.Docs })));
const Verify = lazy(() => import("@/routes/Verify").then((m) => ({ default: m.Verify })));
const RideTest = lazy(() =>
  import("@/routes/RideTest").then((m) => ({ default: m.RideTest })),
);
const Coach = lazy(() => import("@/routes/Coach").then((m) => ({ default: m.Coach })));
const WickPro = lazy(() => import("@/routes/WickPro").then((m) => ({ default: m.WickPro })));

// Minimal pathname-based routing. Computed once at module load (no hash
// routing / SPA nav within these pages — the Vercel SPA rewrite in
// vercel.json serves index.html for non-asset paths so reload works).
//
// `/` is the tap-hold Ride game; `/pro` is Wick Pro, the Black-Scholes
// options round game (the hackathon submission). The old `/ride` URL
// still renders Ride for any external links / bookmarks that point at it.
const PATHNAME = typeof window !== "undefined" ? window.location.pathname : "/";
const IS_RIDE_TEST_ROUTE = PATHNAME === "/ride-test";
const IS_PRO_ROUTE = PATHNAME === "/pro";
const IS_CANDLE_VISION_ROUTE = PATHNAME === "/candle-vision";
const IS_COACH_ROUTE = PATHNAME === "/coach";
const IS_DEGEN_ROUTE = PATHNAME === "/degen";
const IS_DOCS_ROUTE = PATHNAME === "/docs" || PATHNAME.startsWith("/docs/");
const IS_VERIFY_ROUTE = PATHNAME === "/verify";

// Tiny full-screen fallback while a lazy route chunk streams in. Kept
// dark + centered so it reads as "loading", never as a broken white flash.
function RouteFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-background text-foreground/40 text-sm font-mono tracking-wide">
      loading…
    </div>
  );
}

export default function App() {
  // Non-default routes are lazy chunks, so each needs a Suspense boundary.
  if (IS_VERIFY_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Verify />
      </Suspense>
    ); // in-browser provable-fairness replay
  if (IS_DOCS_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Docs path={PATHNAME} />
      </Suspense>
    ); // docs grid + topic pages (chaos-feed)
  if (IS_DEGEN_ROUTE) return <Ride />; // degen tap-hold app
  if (IS_CANDLE_VISION_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <CandleVision />
      </Suspense>
    );
  if (IS_RIDE_TEST_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <RideTest />
      </Suspense>
    );
  if (IS_COACH_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Coach />
      </Suspense>
    ); // CandleVision pattern-coach panel preview (Wick Pro side panel)
  if (IS_PRO_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <WickPro />
      </Suspense>
    ); // Wick Pro — the Black-Scholes options round game (the submission)
  return <Ride />; // default
}
