#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8771';
const DEFAULT_OUT = 'reference/pixel-audit';
const DEFAULT_TARGETS = 'scripts/tradingview-targets.json';

async function loadPuppeteer() {
  try {
    return await import('puppeteer');
  } catch {
    return await import('/Users/maxmohammadi/website-cloner/cloner/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js');
  }
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function largestVisibleCanvas(canvases = []) {
  return canvases
    .filter((canvas) => canvas.css?.width > 200 && canvas.css?.height > 160)
    .sort((a, b) => b.css.width * b.css.height - a.css.width * a.css.height)[0];
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function diffPixels(reference, local, width, height) {
  const diff = Buffer.alloc(reference.length);
  let mismatched = 0;
  let totalAbs = 0;
  let maxAbs = 0;

  for (let i = 0; i < reference.length; i += 4) {
    const dr = Math.abs(reference[i] - local[i]);
    const dg = Math.abs(reference[i + 1] - local[i + 1]);
    const db = Math.abs(reference[i + 2] - local[i + 2]);
    const da = Math.abs(reference[i + 3] - local[i + 3]);
    const delta = Math.max(dr, dg, db, da);
    totalAbs += dr + dg + db + da;
    maxAbs = Math.max(maxAbs, delta);

    if (delta > 18) mismatched += 1;
    diff[i] = delta > 18 ? 255 : 0;
    diff[i + 1] = delta > 18 ? 35 : 0;
    diff[i + 2] = 0;
    diff[i + 3] = delta > 18 ? 210 : 0;
  }

  return {
    diff,
    report: {
      width,
      height,
      pixels: width * height,
      mismatchedPixels: mismatched,
      mismatchPct: +(mismatched / (width * height) * 100).toFixed(4),
      avgAbsPerChannel: +(totalAbs / reference.length).toFixed(3),
      maxAbs,
    },
  };
}

async function screenshotLocal(browser, localUrl, chartBox, outPath) {
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: Math.round(chartBox.css.width),
      height: Math.round(chartBox.css.height),
      deviceScaleFactor: 1,
    });
    await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await page.screenshot({ path: outPath, fullPage: false });
  } finally {
    await page.close();
  }
}

async function auditTarget({ browser, rootDir, baseUrl, outRoot, target }) {
  const targetOut = path.resolve(rootDir, outRoot, target.id);
  await fs.mkdir(targetOut, { recursive: true });

  if (!target.localPath) {
    return {
      id: target.id,
      name: target.name,
      status: 'missing-local-route',
      sourceUrl: target.sourceUrl,
      referenceDir: target.referenceDir,
      blocker: 'No localPath is configured for this target.',
    };
  }

  const referenceDir = path.resolve(rootDir, target.referenceDir);
  const metadataPath = path.join(referenceDir, 'metadata.json');
  const defaultPath = path.join(referenceDir, 'default.png');
  if (!(await fileExists(metadataPath)) || !(await fileExists(defaultPath))) {
    return {
      id: target.id,
      name: target.name,
      status: 'missing-reference',
      sourceUrl: target.sourceUrl,
      referenceDir: target.referenceDir,
      blocker: 'metadata.json or default.png is missing.',
    };
  }

  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const chartBox = largestVisibleCanvas(metadata.metadata?.canvases);
  if (!chartBox) {
    return {
      id: target.id,
      name: target.name,
      status: 'no-chart-canvas',
      sourceUrl: target.sourceUrl,
      referenceDir: target.referenceDir,
      blocker: 'Reference capture did not expose a visible chart canvas.',
    };
  }

  const localUrl = new URL(target.localPath, baseUrl).toString();
  const referenceCropPath = path.join(targetOut, 'reference-chart-crop.png');
  const localCapturePath = path.join(targetOut, 'local-default.png');
  const localSizedPath = path.join(targetOut, 'local-chart-sized.png');
  const diffPath = path.join(targetOut, 'diff.png');

  await screenshotLocal(browser, localUrl, chartBox, localCapturePath);

  await sharp(defaultPath)
    .extract({
      left: Math.max(0, Math.round(chartBox.css.x)),
      top: Math.max(0, Math.round(chartBox.css.y)),
      width: Math.round(chartBox.css.width),
      height: Math.round(chartBox.css.height),
    })
    .png()
    .toFile(referenceCropPath);

  await sharp(localCapturePath)
    .resize(Math.round(chartBox.css.width), Math.round(chartBox.css.height), { fit: 'fill' })
    .png()
    .toFile(localSizedPath);

  const { data: reference, info } = await sharp(referenceCropPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: local } = await sharp(localSizedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { diff, report } = diffPixels(reference, local, info.width, info.height);
  await sharp(diff, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(diffPath);

  const result = {
    id: target.id,
    name: target.name,
    status: report.mismatchPct <= 1 ? 'pass' : 'fail',
    targetStatus: target.status,
    sourceUrl: target.sourceUrl,
    localUrl,
    referenceDir,
    outputDir: targetOut,
    referenceCrop: referenceCropPath,
    localCapture: localCapturePath,
    diff: diffPath,
    chartBox: chartBox.css,
    ...report,
  };
  await fs.writeFile(path.join(targetOut, 'report.json'), JSON.stringify(result, null, 2));
  return result;
}

const rootDir = process.cwd();
const baseUrl = argValue('--base-url', DEFAULT_BASE_URL);
const outRoot = argValue('--out', DEFAULT_OUT);
const targetPath = path.resolve(rootDir, argValue('--targets', DEFAULT_TARGETS));
const only = argValue('--only', '');
const failOnMismatch = hasFlag('--fail-on-mismatch');
const targets = JSON.parse(await fs.readFile(targetPath, 'utf8')).filter((target) => !only || target.id === only);

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const results = [];
try {
  for (const target of targets) {
    console.log(`\n[tradingview-audit] ${target.id}`);
    const result = await auditTarget({ browser, rootDir, baseUrl, outRoot, target });
    results.push(result);
    if (result.mismatchPct != null) {
      console.log(`  ${result.status.toUpperCase()} ${result.mismatchPct}% mismatch -> ${path.relative(rootDir, result.outputDir)}`);
    } else {
      console.log(`  ${result.status.toUpperCase()} ${result.blocker}`);
    }
  }
} finally {
  await browser.close();
}

await fs.mkdir(path.resolve(rootDir, outRoot), { recursive: true });
const summary = {
  capturedAt: new Date().toISOString(),
  baseUrl,
  targetCount: results.length,
  passCount: results.filter((result) => result.status === 'pass').length,
  failCount: results.filter((result) => result.status === 'fail').length,
  blockedCount: results.filter((result) => result.blocker).length,
  results,
};
await fs.writeFile(path.resolve(rootDir, outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n[tradingview-audit] summary -> ${path.join(outRoot, 'summary.json')}`);
console.table(
  results.map((result) => ({
    id: result.id,
    status: result.status,
    mismatchPct: result.mismatchPct ?? '',
    blocker: result.blocker ?? '',
  })),
);

if (failOnMismatch && results.some((result) => result.status !== 'pass')) {
  process.exitCode = 1;
}
