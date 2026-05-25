#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node scripts/patch-esm-imports.mjs <dist-dir>');
  process.exit(1);
}

const root = resolve(process.cwd(), targetDir);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`ESM import patch target does not exist: ${root}`);
  process.exit(1);
}

const files = listJsFiles(root);
let patchedFiles = 0;
let patchedSpecifiers = 0;

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = patchStaticSpecifiers(file, before);
  if (after !== before) {
    patchedFiles += 1;
    patchedSpecifiers += countSpecifierDelta(before, after);
    writeFileSync(file, after);
  }
}

console.log(`patched ESM imports: ${patchedSpecifiers} specifier(s) in ${patchedFiles} file(s)`);

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function patchStaticSpecifiers(file, source) {
  let output = source.replace(
    /\b(from\s*)(['"])(\.{1,2}\/[^'"]+)(\2)/g,
    (match, prefix, quote, specifier, suffix) => `${prefix}${quote}${resolveRuntimeSpecifier(file, specifier)}${suffix}`,
  );

  output = output.replace(
    /\b(import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)(\2\s*\))/g,
    (match, prefix, quote, specifier, suffix) => `${prefix}${quote}${resolveRuntimeSpecifier(file, specifier)}${suffix}`,
  );

  output = output.replace(
    /\b(import\s*)(['"])(\.{1,2}\/[^'"]+)(\2\s*;)/g,
    (match, prefix, quote, specifier, suffix) => `${prefix}${quote}${resolveRuntimeSpecifier(file, specifier)}${suffix}`,
  );

  return output;
}

function resolveRuntimeSpecifier(file, specifier) {
  if (hasRuntimeExtension(specifier)) return specifier;

  const absolute = resolve(dirname(file), specifier);
  if (existsSync(`${absolute}.js`)) return `${specifier}.js`;
  if (existsSync(join(absolute, 'index.js'))) return `${specifier.replace(/\/$/, '')}/index.js`;
  return specifier;
}

function hasRuntimeExtension(specifier) {
  const lastSegment = specifier.split('/').at(-1) ?? '';
  return Boolean(extname(lastSegment));
}

function countSpecifierDelta(before, after) {
  const beforeSpecs = before.match(/\.{1,2}\/[^'"]+/g)?.length ?? 0;
  const afterSpecs = after.match(/\.{1,2}\/[^'"]+/g)?.length ?? 0;
  return Math.max(beforeSpecs, afterSpecs);
}
