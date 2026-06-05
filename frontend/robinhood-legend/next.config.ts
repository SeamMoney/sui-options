import type { NextConfig } from 'next';
import path from 'node:path';
const nextConfig: NextConfig = {
  // StrictMode double-invokes effects and state updater functions, which broke
  // imperative chart-root unmount/remount and toggle-state semantics. Off in dev
  // — real production renders only once, so this matches prod behavior.
  reactStrictMode: false,
  trailingSlash: false,
  // Pin the workspace root so Turbopack doesn't follow node_modules symlinks
  // up to the parent monorepo and complain about file boundaries.
  turbopack: { root: path.resolve('.') },
  outputFileTracingRoot: path.resolve('.'),
};
export default nextConfig;
