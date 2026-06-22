import { lazy, Suspense } from "react";

// Every route is lazy-loaded. Crucially this keeps the Ride game's wallet
// stack (Dynamic Labs social-login SDK + dapp-kit) — the bulk of the JS —
// OUT of the shared entry chunk, so the Wick Pro submission at /pro (which
// uses no wallet) downloads and becomes interactive far sooner. Each route
// also carries its own heavy deps (candle-vision scanner, docs, verifier)
// only when visited.
const Ride = lazy(() => import("@/routes/Ride").then((m) => ({ default: m.Ride })));
const CandleVision = lazy(() =>
  import("@/routes/CandleVision").then((m) => ({ default: m.CandleVision })),
);
const Docs = lazy(() => import("@/routes/Docs").then((m) => ({ default: m.Docs })));
const Verify = lazy(() => import("@/routes/Verify").then((m) => ({ default: m.Verify })));
const RideTest = lazy(() =>
  import("@/routes/RideTest").then((m) => ({ default: m.RideTest })),
);
const Coach = lazy(() => import("@/routes/Coach").then((m) => ({ default: m.Coach })));
// /pro is the LIVE-DeepBook-mark Wick Pro (the submission build per
// SUBMISSION-STRATEGY: options priced off the real CLOB mid + live σ).
const WickProLive = lazy(() =>
  import("@/routes/WickProLive").then((m) => ({ default: m.WickProLive })),
);
// The synthetic, commit/reveal provably-fair round game, kept at /pro-sim.
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
const IS_PRO_SIM_ROUTE = PATHNAME === "/pro-sim";
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
  if (IS_DEGEN_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <Ride />
      </Suspense>
    ); // degen tap-hold app
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
        <WickProLive />
      </Suspense>
    ); // Wick Pro — Black-Scholes options on the LIVE DeepBook mark (submission)
  if (IS_PRO_SIM_ROUTE)
    return (
      <Suspense fallback={<RouteFallback />}>
        <WickPro />
      </Suspense>
    ); // synthetic commit/reveal provably-fair variant
  return (
    <Suspense fallback={<RouteFallback />}>
      {/* Semantic page heading for the document outline / a11y / SEO — kept
          here in the router so it covers every internal Ride state (RideV4 /
          RideV3 / between-rounds) without threading it through the game
          component. Visually hidden so the full-screen chart UI is untouched. */}
      <h1 className="sr-only">
        Wick — tap-hold touch / no-touch rides on Sui, with provably-fair on-chain candles
      </h1>
      <Ride />
    </Suspense>
  ); // default
}
