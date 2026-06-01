#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { formatBytes, projectRoot, resolveProjectPath } from './bundleMetrics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const defaultDistAssetsDir = path.join(projectRoot, 'dist', 'assets');
export const defaultOutputDir = path.join(projectRoot, 'output');

export function resolveBundleReportPaths(env = process.env) {
  const distAssetsDir = env.WORKBENCH_BUNDLE_DIST_ASSETS_DIR
    ? resolveProjectPath(env.WORKBENCH_BUNDLE_DIST_ASSETS_DIR)
    : defaultDistAssetsDir;
  const outputDir = env.WORKBENCH_BUNDLE_OUTPUT_DIR
    ? resolveProjectPath(env.WORKBENCH_BUNDLE_OUTPUT_DIR)
    : defaultOutputDir;

  return {
    distAssetsDir,
    outputDir,
    jsonReportPath: path.join(outputDir, 'bundle-report.json'),
    markdownReportPath: path.join(outputDir, 'bundle-report.md'),
  };
}

export function categorizeAsset(fileName) {
  if (fileName.endsWith('.css')) {
    return 'css';
  }
  if (!fileName.endsWith('.js')) {
    return 'other';
  }
  if (fileName.startsWith('vendor-') || fileName.startsWith('vendor.')) {
    return 'vendor';
  }
  if (fileName.startsWith('index-') || fileName.startsWith('index.')) {
    return 'entry';
  }
  return 'lazy';
}

export function summarizeAssets(assets, category) {
  const filteredAssets = assets.filter((asset) => asset.category === category);
  return {
    count: filteredAssets.length,
    bytes: filteredAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    gzipBytes: filteredAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
  };
}

export function topAssets(assets, limit = 10) {
  return [...assets]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);
}

export function toMarkdownTable(assets) {
  if (!assets.length) {
    return '_None_';
  }

  const rows = assets.map(
    (asset) =>
      `| \`${asset.fileName}\` | ${asset.category} | ${formatBytes(asset.bytes)} | ${formatBytes(asset.gzipBytes)} |`,
  );

  return [
    '| Asset | Category | Raw | Gzip |',
    '| --- | --- | ---: | ---: |',
    ...rows,
  ].join('\n');
}

export function buildBundleReport(assets, generatedAt = new Date().toISOString()) {
  const jsAssets = assets.filter((asset) => asset.extension === '.js');
  const cssAssets = assets.filter((asset) => asset.extension === '.css');
  const totals = {
    assetCount: assets.length,
    bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    entry: summarizeAssets(assets, 'entry'),
    lazy: summarizeAssets(assets, 'lazy'),
    vendor: summarizeAssets(assets, 'vendor'),
    css: summarizeAssets(assets, 'css'),
    other: summarizeAssets(assets, 'other'),
  };

  return {
    generatedAt,
    project: '@framers/agentos-workbench',
    distAssetsDir: 'dist/assets',
    totals,
    topJsAssets: topAssets(jsAssets),
    topCssAssets: topAssets(cssAssets),
    topAssets: topAssets(assets, 15),
    assets,
  };
}

export function buildBundleMarkdown(report) {
  const { totals } = report;

  return [
    '# AgentOS Workbench Bundle Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Totals',
    '',
    `- Assets: ${totals.assetCount}`,
    `- Raw size: ${formatBytes(totals.bytes)}`,
    `- Gzip size: ${formatBytes(totals.gzipBytes)}`,
    `- Entry JS: ${totals.entry.count} files, ${formatBytes(totals.entry.bytes)} raw, ${formatBytes(totals.entry.gzipBytes)} gzip`,
    `- Lazy JS: ${totals.lazy.count} files, ${formatBytes(totals.lazy.bytes)} raw, ${formatBytes(totals.lazy.gzipBytes)} gzip`,
    `- Vendor JS: ${totals.vendor.count} files, ${formatBytes(totals.vendor.bytes)} raw, ${formatBytes(totals.vendor.gzipBytes)} gzip`,
    `- CSS: ${totals.css.count} files, ${formatBytes(totals.css.bytes)} raw, ${formatBytes(totals.css.gzipBytes)} gzip`,
    '',
    '## Largest JavaScript Assets',
    '',
    toMarkdownTable(report.topJsAssets),
    '',
    '## Largest CSS Assets',
    '',
    toMarkdownTable(report.topCssAssets),
    '',
    '## Largest Assets Overall',
    '',
    toMarkdownTable(report.topAssets),
    '',
  ].join('\n');
}

async function main() {
  const { distAssetsDir, outputDir, jsonReportPath, markdownReportPath } = resolveBundleReportPaths();
  let assetFileNames;

  try {
    assetFileNames = (await readdir(distAssetsDir)).sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read built assets from ${distAssetsDir}. Run "pnpm build" first. (${detail})`);
  }

  const assets = [];

  for (const fileName of assetFileNames) {
    const filePath = path.join(distAssetsDir, fileName);
    const buffer = await readFile(filePath);

    assets.push({
      fileName,
      path: `dist/assets/${fileName}`,
      bytes: buffer.byteLength,
      gzipBytes: gzipSync(buffer, { level: 9 }).byteLength,
      category: categorizeAsset(fileName),
      extension: path.extname(fileName),
    });
  }

  const report = buildBundleReport(assets);
  const markdown = buildBundleMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownReportPath, markdown, 'utf8');

  console.log(`Wrote ${path.relative(projectRoot, jsonReportPath)}`);
  console.log(`Wrote ${path.relative(projectRoot, markdownReportPath)}`);
  console.log(`Largest JS asset: ${report.topJsAssets[0]?.fileName ?? 'n/a'} (${formatBytes(report.topJsAssets[0]?.bytes ?? 0)})`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
