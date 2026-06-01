import path from 'node:path';
import { writeFileSync } from 'node:fs';

export function createAsset(fileName, bytes, gzipBytes, category, extension = path.extname(fileName)) {
  return {
    fileName,
    path: `dist/assets/${fileName}`,
    bytes,
    gzipBytes,
    category,
    extension,
  };
}

export function createCoreBundleAssets() {
  return {
    vendorJs: createAsset('vendor-polyfills-CoFUuYbz.js', 395_470, 121_000, 'vendor'),
    entryJs: createAsset('index-BX12AB34.js', 155_450, 44_500, 'entry'),
    css: createAsset('index-CD56EF78.css', 111_650, 21_200, 'css'),
  };
}

export function createExtendedBundleAssets() {
  return {
    ...createCoreBundleAssets(),
    lazyJs: createAsset('graph-builder-QWER1234.js', 102_000, 31_000, 'lazy'),
    other: createAsset('logo.svg', 2_400, 1_100, 'other', '.svg'),
  };
}

function summarizeAssets(assets, category) {
  const filteredAssets = assets.filter((asset) => asset.category === category);
  return {
    count: filteredAssets.length,
    bytes: filteredAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    gzipBytes: filteredAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
  };
}

function topAssets(assets, limit = 10) {
  return [...assets]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit);
}

export function createBundleReportFixture({
  assets = Object.values(createCoreBundleAssets()),
  generatedAt = '2026-03-26T12:00:00.000Z',
  project = '@framers/agentos-workbench',
  includeTopJsAssets = true,
  totals: totalsOverrides = {},
} = {}) {
  const jsAssets = assets.filter((asset) => asset.extension === '.js');
  const cssAssets = assets.filter((asset) => asset.extension === '.css');

  return {
    generatedAt,
    project,
    totals: {
      assetCount: assets.length,
      bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
      gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
      entry: summarizeAssets(assets, 'entry'),
      lazy: summarizeAssets(assets, 'lazy'),
      vendor: summarizeAssets(assets, 'vendor'),
      css: summarizeAssets(assets, 'css'),
      other: summarizeAssets(assets, 'other'),
      ...totalsOverrides,
    },
    ...(includeTopJsAssets ? { topJsAssets: topAssets(jsAssets) } : {}),
    topCssAssets: topAssets(cssAssets),
    topAssets: topAssets(assets, 15),
    assets,
  };
}

export function createCurrentBundleBaselineFixture(overrides = {}) {
  return {
    generatedAt: '2026-03-26T12:05:00.000Z',
    sourceReportGeneratedAt: '2026-03-26T12:00:00.000Z',
    project: '@framers/agentos-workbench',
    metrics: {
      totalBytes: 662_570,
      totalGzipBytes: 186_700,
      largestJsBytes: 395_470,
      entryJsBytes: 155_450,
      cssBytes: 111_650,
      ...(overrides.metrics ?? {}),
    },
    assets: {
      largestJs: { label: 'vendor-polyfills.js' },
      entryJs: { label: 'index.js' },
      css: { label: 'index.css' },
      ...(overrides.assets ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['metrics', 'assets'].includes(key))),
  };
}

export function createPreviousBundleBaselineFixture(overrides = {}) {
  return {
    generatedAt: '2026-03-26T11:55:00.000Z',
    sourceReportGeneratedAt: '2026-03-26T11:50:00.000Z',
    project: '@framers/agentos-workbench',
    metrics: {
      totalBytes: 640_000,
      totalGzipBytes: 180_000,
      largestJsBytes: 380_000,
      entryJsBytes: 150_000,
      cssBytes: 110_000,
      ...(overrides.metrics ?? {}),
    },
    assets: {
      largestJs: { label: 'vendor-polyfills.js' },
      entryJs: { label: 'index.js' },
      css: { label: 'index.css' },
      ...(overrides.assets ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['metrics', 'assets'].includes(key))),
  };
}

export function createBundleSummaryFixture(overrides = {}) {
  return {
    totalBytes: 1_880_000,
    totalGzipBytes: 531_250,
    largestJsBytes: 395_470,
    entryJsBytes: 155_450,
    cssBytes: 111_650,
    largestJsAsset: {
      fileName: 'assets/vendor-polyfills-CoFUuYbz.js',
      label: 'assets/vendor-polyfills.js',
      bytes: 395_470,
      gzipBytes: 121_000,
    },
    entryAsset: {
      fileName: 'assets/index-BX12AB34.js',
      label: 'assets/index.js',
      bytes: 155_450,
      gzipBytes: 44_500,
    },
    cssAsset: {
      fileName: 'assets/index-CD56EF78.css',
      label: 'assets/index.css',
      bytes: 111_650,
      gzipBytes: 21_200,
    },
    ...overrides,
  };
}

export function createPolicyBundleBaselineFixture(overrides = {}) {
  return {
    metrics: {
      totalBytes: 1_820_000,
      totalGzipBytes: 520_000,
      largestJsBytes: 382_000,
      entryJsBytes: 149_000,
      cssBytes: 109_000,
      ...(overrides.metrics ?? {}),
    },
    assets: {
      largestJs: { label: 'assets/vendor-polyfills.js' },
      entryJs: { label: 'assets/index.js' },
      css: { label: 'assets/index.css' },
      ...(overrides.assets ?? {}),
    },
  };
}

export function writeJsonFixture(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
