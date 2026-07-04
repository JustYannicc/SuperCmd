#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist/renderer');
const indexPath = path.join(distDir, 'index.html');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath));
    } else {
      out.push(fullPath);
    }
  }
  return out;
}

if (!fs.existsSync(indexPath)) {
  console.error('dist/renderer/index.html not found. Run `npm run build:renderer` first.');
  process.exit(1);
}

const html = fs.readFileSync(indexPath, 'utf8');
const startupAssets = [...html.matchAll(/(?:src|href)="\.?\/?([^"]+)"/g)]
  .map((match) => match[1])
  .filter((asset) => asset.startsWith('assets/'));

const assets = walk(distDir)
  .filter((filePath) => /\.(js|css|map)$/.test(filePath))
  .map((filePath) => {
    const buffer = fs.readFileSync(filePath);
    const relativePath = path.relative(distDir, filePath);
    return {
      path: relativePath,
      bytes: buffer.length,
      gzipBytes: zlib.gzipSync(buffer).length,
      startup: startupAssets.includes(relativePath),
    };
  })
  .sort((a, b) => b.bytes - a.bytes);

const totals = assets.reduce(
  (acc, asset) => {
    acc.bytes += asset.bytes;
    acc.gzipBytes += asset.gzipBytes;
    if (asset.startup) {
      acc.startupBytes += asset.bytes;
      acc.startupGzipBytes += asset.gzipBytes;
    }
    return acc;
  },
  { bytes: 0, gzipBytes: 0, startupBytes: 0, startupGzipBytes: 0 }
);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  totals,
  startupAssets,
  largestAssets: assets.slice(0, 30),
}, null, 2));
