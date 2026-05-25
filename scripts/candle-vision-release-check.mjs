#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const packageDir = join(root, 'packages/candle-vision');
const runtimeOut = join(root, 'scripts/.tmp/candle-vision-release-check');
const packageName = '@sui-options/candle-vision';

process.on('exit', () => {
  rmSync(runtimeOut, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
}

function assertFile(path, message) {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

rmSync(runtimeOut, { recursive: true, force: true });

const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
if (packageJson.name !== packageName) {
  throw new Error(`expected package name ${packageName}, received ${packageJson.name ?? 'undefined'}`);
}

run('npx', ['tsc', '-p', 'packages/candle-vision/test/tsconfig.runtime.json']);
run('node', ['scripts/.tmp/candle-vision-release-check/runtime/test/release-regression.js']);

run('npm', ['run', 'build'], { cwd: packageDir });

for (const file of [
  'dist/index.d.ts',
  'dist/catalog.d.ts',
  'dist/features.d.ts',
  'dist/ranking.d.ts',
  'dist/registry.d.ts',
  'dist/unified-detector.d.ts',
]) {
  assertFile(join(packageDir, file), `package build did not emit ${file}`);
}

const consumerDir = join(packageDir, 'test/.tmp/consumer');
rmSync(consumerDir, { recursive: true, force: true });
mkdirSync(consumerDir, { recursive: true });
const linkedPackageDir = join(consumerDir, 'node_modules/@sui-options/candle-vision');
mkdirSync(join(consumerDir, 'node_modules/@sui-options'), { recursive: true });
symlinkSync(packageDir, linkedPackageDir, 'dir');
const consumerFile = join(consumerDir, 'import-package.mjs');
writeFileSync(
  consumerFile,
  [
    `import { detectUnifiedCandlePatterns, rankVisiblePatternSignals } from '${packageName}';`,
    `import { scanCandleVision } from '${packageName}/scanner';`,
    `import { createCandleVisionPreset } from '${packageName}/presets';`,
    `import { createLightweightChartsPatternOverlay } from '${packageName}/overlay-lightweight-charts';`,
    'if (typeof detectUnifiedCandlePatterns !== "function" || typeof rankVisiblePatternSignals !== "function") {',
    '  throw new Error("package exports did not expose detector and ranking functions");',
    '}',
    'if (typeof scanCandleVision !== "function" || typeof createCandleVisionPreset !== "function" || typeof createLightweightChartsPatternOverlay !== "function") {',
    '  throw new Error("package subpath exports are not runtime-callable");',
    '}',
  ].join('\n'),
);

try {
  await import(pathToFileURL(consumerFile).href);
} catch (error) {
  throw new Error(
    [
      'package exports are not runtime-importable after build',
      error instanceof Error ? error.message : String(error),
    ].join(': '),
  );
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
}

console.log('candle-vision release checks passed');
