// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// ErrorBoundary — wraps the wallet provider stack so a misbehaving browser
// wallet extension (e.g. Razor's inpage-script.js trying to destructure
// `register` from undefined, observed 2026-05-23) doesn't unmount the
// entire React tree.
//
// The wallet-extension space on Sui is messy: Razor, Backpack, Slush,
// MetaMask Sui Snap, Phantom, Suiet, Surf, Nightly — they all inject
// scripts that race for the same window-global namespace. When one of
// them throws synchronously during init, the error's stack happens to
// surface inside React's reconciler because React is rendering on the
// same event-loop tick. Without an ErrorBoundary the throw bubbles up
// and unmounts everything.
//
// This boundary catches those throws, logs them with a recognizable
// prefix, and renders a soft fallback inviting the user to disable
// conflicting wallet extensions. The rest of the app stays alive.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback for which surface failed. */
  surface?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(
      "[wick] ErrorBoundary caught render-time throw — likely a browser " +
        "wallet extension misbehaving. The app stays alive; check the " +
        "console stack to identify the extension.",
      { error, componentStack: info.componentStack },
    );
  }

  reset = () => {
    this.setState({ error: null });
  };

  override render() {
    if (!this.state.error) return this.props.children;

    const isLikelyWalletExt =
      /destructure|register|wallet|inpage|extension/i.test(this.state.error.message) ||
      /inpage-script|contentscript|extension/i.test(this.state.error.stack ?? "");

    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-white p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="text-amber-400 text-sm uppercase tracking-widest">
            {this.props.surface ?? "Wick"} hit a wall
          </div>
          <div className="text-2xl font-semibold">
            Something crashed during render
          </div>
          {isLikelyWalletExt ? (
            <p className="text-zinc-400 text-sm leading-relaxed">
              This looks like a browser <strong>wallet extension</strong>{" "}
              throwing during initialization — usually Razor, Backpack, or a
              second EVM wallet fighting for{" "}
              <code className="text-zinc-300">window.ethereum</code>. Try
              disabling extra wallets and refresh. If that doesn't help, the
              full error is in the browser console.
            </p>
          ) : (
            <p className="text-zinc-400 text-sm leading-relaxed">
              The full error is in the browser console. Refresh to retry.
            </p>
          )}
          <pre className="text-left text-xs text-rose-400/80 bg-zinc-900 rounded p-3 overflow-auto max-h-40">
            {this.state.error.message}
          </pre>
          <button
            onClick={this.reset}
            className="px-4 py-2 rounded bg-amber-500 text-zinc-950 font-semibold hover:bg-amber-400 transition"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
