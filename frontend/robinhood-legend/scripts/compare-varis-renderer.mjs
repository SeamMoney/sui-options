#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const DEFAULT_REFERENCE = 'reference/tradingview-varis';
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8771/widgets/candlestick-chart';
const DEFAULT_OUT = 'reference/tradingview-varis/local-compare';

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

function largestVisibleCanvas(canvases) {
  return canvases
    .filter((canvas) => canvas.css.width > 200 && canvas.css.height > 160)
    .sort((a, b) => b.css.width * b.css.height - a.css.width * a.css.height)[0];
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

const referenceDir = path.resolve(process.cwd(), argValue('--reference', DEFAULT_REFERENCE));
const localUrl = argValue('--local-url', DEFAULT_LOCAL_URL);
const outDir = path.resolve(process.cwd(), argValue('--out', DEFAULT_OUT));
await fs.mkdir(outDir, { recursive: true });

const metadataPath = path.join(referenceDir, 'metadata.json');
const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
const chartBox = largestVisibleCanvas(metadata.metadata.canvases);
if (!chartBox) throw new Error(`No visible chart canvas found in ${metadataPath}`);

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({
    width: Math.round(chartBox.css.width),
    height: Math.round(chartBox.css.height),
    deviceScaleFactor: 1,
  });
  await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.screenshot({ path: path.join(outDir, 'local-default.png'), fullPage: false });
} finally {
  await browser.close();
}

const referenceCropPath = path.join(outDir, 'reference-chart-crop.png');
const localPath = path.join(outDir, 'local-default.png');
const localSizedPath = path.join(outDir, 'local-chart-sized.png');
const diffPath = path.join(outDir, 'diff.png');

await sharp(path.join(referenceDir, 'default.png'))
  .extract({
    left: Math.max(0, Math.round(chartBox.css.x)),
    top: Math.max(0, Math.round(chartBox.css.y)),
    width: Math.round(chartBox.css.width),
    height: Math.round(chartBox.css.height),
  })
  .png()
  .toFile(referenceCropPath);

await sharp(localPath)
  .resize(Math.round(chartBox.css.width), Math.round(chartBox.css.height), { fit: 'fill' })
  .png()
  .toFile(localSizedPath);

const { data: reference, info } = await sharp(referenceCropPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { data: local } = await sharp(localSizedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { diff, report } = diffPixels(reference, local, info.width, info.height);
await sharp(diff, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(diffPath);

const fullReport = {
  referenceDir,
  localUrl,
  referenceCrop: referenceCropPath,
  localCapture: localPath,
  diff: diffPath,
  chartBox: chartBox.css,
  ...report,
};
await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(fullReport, null, 2));
console.log(JSON.stringify(fullReport, null, 2));
