// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Tiny /healthz HTTP endpoint. No deps — `node:http` only.
// Reports last tick timestamp, error rate in last 5 minutes, packageId.

import { createServer } from "node:http";
import type { Server } from "node:http";

export interface HealthState {
  packageId: string;
  network: string;
  address: string;
  lastTickMs: number;
  /// Ring buffer of (ts_ms, failed_count) for the last 5 minutes.
  errorWindow: { tsMs: number; count: number }[];
}

const WINDOW_MS = 5 * 60 * 1000;

export function createHealth(initial: Omit<HealthState, "lastTickMs" | "errorWindow">): HealthState {
  return {
    ...initial,
    lastTickMs: 0,
    errorWindow: [],
  };
}

export function recordTick(state: HealthState, atMs: number, failed: number): void {
  state.lastTickMs = atMs;
  if (failed > 0) {
    state.errorWindow.push({ tsMs: atMs, count: failed });
  }
  const cutoff = atMs - WINDOW_MS;
  while (state.errorWindow.length > 0 && state.errorWindow[0]!.tsMs < cutoff) {
    state.errorWindow.shift();
  }
}

function summary(state: HealthState): {
  ok: boolean;
  last_tick_ms: number;
  errors_last_5m: number;
  package_id: string;
  network: string;
  address: string;
} {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const errors = state.errorWindow
    .filter((e) => e.tsMs >= cutoff)
    .reduce((acc, e) => acc + e.count, 0);
  // We are "ok" if we've ticked in the last minute OR we've never started.
  const ok = state.lastTickMs === 0 || (now - state.lastTickMs) < 60_000;
  return {
    ok,
    last_tick_ms: state.lastTickMs,
    errors_last_5m: errors,
    package_id: state.packageId,
    network: state.network,
    address: state.address,
  };
}

export function startHealthServer(state: HealthState, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      const body = JSON.stringify(summary(state));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        action: "health-listen",
        msg: `health endpoint on :${port}/healthz`,
      }),
    );
  });
  return server;
}
