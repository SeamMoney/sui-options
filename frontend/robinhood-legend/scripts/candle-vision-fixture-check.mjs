import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(root, 'src/lib/candle-vision');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-vision-fixtures-'));
const outRoot = path.join(tempRoot, 'candle-vision');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const fromDir = path.dirname(fromFile);
  const absBase = path.resolve(fromDir, specifier);
  const asFile = `${absBase}.ts`;
  const asIndex = path.join(absBase, 'index.ts');
  if (fs.existsSync(asFile)) return `${specifier}.js`;
  if (fs.existsSync(asIndex)) return `${specifier.replace(/\/$/, '')}/index.js`;
  return specifier;
}

function rewriteImports(source, filePath) {
  return source
    .replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveSpecifier(filePath, specifier)}${suffix}`;
    })
    .replace(/(import\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveSpecifier(filePath, specifier)}${suffix}`;
    });
}

for (const sourcePath of walk(sourceRoot)) {
  const relative = path.relative(sourceRoot, sourcePath).replace(/\.ts$/, '.js');
  const outPath = path.join(outRoot, relative);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const rewritten = rewriteImports(fs.readFileSync(sourcePath, 'utf8'), sourcePath);
  const transpiled = ts.transpileModule(rewritten, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      verbatimModuleSyntax: false,
    },
    fileName: sourcePath,
  }).outputText;
  fs.writeFileSync(outPath, transpiled);
}

const { detectUnifiedCandlePatterns } = await import(path.join(outRoot, 'unified-detector.js'));
const { rankPatternSignals } = await import(path.join(outRoot, 'ranking.js'));
const {
  createBullishEngulfingFixture,
  createChoppyFixture,
  createMorningStarFixture,
  createRandomWalkFixture,
  createTrendFixture,
} = await import(path.join(outRoot, 'fixtures.js'));

const cases = [
  {
    name: 'random walk does not over-detect',
    candles: createRandomWalkFixture({ seed: 11, count: 180 }),
    assert: (_events, visible) => visible.length <= 30,
  },
  {
    name: 'choppy range does not over-detect',
    candles: createChoppyFixture({ seed: 12, count: 160 }),
    assert: (_events, visible) => visible.length <= 30,
  },
  {
    name: 'trend has bounded signals',
    candles: createTrendFixture({ seed: 13, count: 140, direction: 'up' }),
    assert: (_events, visible) => visible.length <= 30,
  },
  {
    name: 'bullish engulfing fixture detects engulfing',
    candles: createBullishEngulfingFixture({ seed: 14 }),
    assert: (events) => events.some((event) => event.kind === 'engulfing' && event.direction === 'bullish'),
  },
  {
    name: 'morning star fixture detects morning-star',
    candles: createMorningStarFixture({ seed: 15 }),
    assert: (events) => events.some((event) => event.kind === 'morning-star'),
  },
];

let failed = 0;

for (const testCase of cases) {
  const events = detectUnifiedCandlePatterns(testCase.candles, {
    minConfidence: 0.72,
    lookback: 220,
    enableExpandedCandles: true,
    enableStructures: true,
    enableTaPatterns: true,
  });
  const ranked = rankPatternSignals(events, {
    latestIndex: testCase.candles.length - 1,
    maxVisible: 30,
    minVisibleScore: 0.36,
    recencyWindow: 180,
    perKindLimit: 4,
    perFamilyLimit: 22,
    allowOverlaps: true,
  });
  const visible = ranked.visible.map((signal) => signal.event);
  const pass = testCase.assert(events, visible);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${testCase.name} (${events.length} raw · ${visible.length} visible)`);
  if (!pass) {
    failed += 1;
    console.log(events.slice(-12).map((event) => `${event.kind}:${event.confidence.toFixed(2)}`).join(', '));
  }
}

process.exitCode = failed ? 1 : 0;
