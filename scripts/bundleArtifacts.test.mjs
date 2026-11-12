import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBundleSummary, getBundleBaselinePath, normalizeAssetLabel, projectRoot } from './bundleMetrics.mjs';
import { buildBundleBaseline } from './updateBundleBaseline.mjs';
import { buildBundleMarkdown, buildBundleReport, categorizeAsset, toMarkdownTable } from './generateBundleReport.mjs';
import {
  createAsset,
  createBundleReportFixture,
  createCoreBundleAssets,
  createExtendedBundleAssets,
} from './bundleTestFixtures.mjs';

test('categorizeAsset classifies workbench asset naming patterns', () => {
  assert.equal(categorizeAsset('index-ABC12345.js'), 'entry');
  assert.equal(categorizeAsset('vendor-QWER5678.js'), 'vendor');
  assert.equal(categorizeAsset('graph-builder-XYZ98765.js'), 'lazy');
  assert.equal(categorizeAsset('styles-A1B2C3D4.css'), 'css');
  assert.equal(categorizeAsset('logo.svg'), 'other');
});

test('normalizeAssetLabel strips content hashes while preserving extensions', () => {
  assert.equal(normalizeAssetLabel('assets/index-BX12AB34.js'), 'assets/index.js');
  assert.equal(normalizeAssetLabel('assets/styles-ABCD123456.css'), 'assets/styles.css');
  assert.equal(normalizeAssetLabel('assets/runtime.js'), 'assets/runtime.js');
});

test('buildBundleReport summarizes totals and largest assets', () => {
  const assets = Object.values(createExtendedBundleAssets());

  const report = buildBundleReport(assets, '2026-03-26T12:00:00.000Z');

  assert.equal(report.generatedAt, '2026-03-26T12:00:00.000Z');
  assert.equal(report.totals.assetCount, 5);
  assert.equal(report.totals.bytes, 766_970);
  assert.equal(report.totals.gzipBytes, 218_800);
  assert.equal(report.totals.entry.bytes, 155_450);
  assert.equal(report.totals.vendor.bytes, 395_470);
  assert.equal(report.topJsAssets[0].fileName, 'vendor-polyfills-CoFUuYbz.js');
  assert.equal(report.topCssAssets[0].fileName, 'index-CD56EF78.css');
  assert.equal(report.topAssets[0].fileName, 'vendor-polyfills-CoFUuYbz.js');
});

test('buildBundleMarkdown renders summary sections and tables', () => {
  const report = buildBundleReport(Object.values(createCoreBundleAssets()), '2026-03-26T12:00:00.000Z');

  const markdown = buildBundleMarkdown(report);

  assert.match(markdown, /# AgentOS Workbench Bundle Report/);
  assert.match(markdown, /- Raw size: 662\.57 kB/);
  assert.match(markdown, /## Largest JavaScript Assets/);
  assert.match(markdown, /\| `vendor-polyfills-CoFUuYbz\.js` \| vendor \| 395\.47 kB \| 121\.00 kB \|/);
});

test('buildBundleMarkdown totals account for assets that are neither JavaScript nor CSS', () => {
  // The sql.js wasm is emitted into dist/assets beside the chunks, so it counts toward the
  // total budgets; the totals breakdown has to show where those bytes are.
  const report = buildBundleReport(
    [
      ...Object.values(createCoreBundleAssets()),
      createAsset('sql-wasm-browser-CXIAVl5-.wasm', 688_197, 337_776, 'other', '.wasm'),
    ],
    '2026-03-26T12:00:00.000Z',
  );

  const markdown = buildBundleMarkdown(report);

  assert.match(markdown, /- Raw size: 1\.35 MB/);
  assert.match(markdown, /- Other assets: 1 files, 688\.20 kB raw, 337\.78 kB gzip/);
});

test('toMarkdownTable returns an empty marker for empty asset lists', () => {
  assert.equal(toMarkdownTable([]), '_None_');
});

test('buildBundleSummary falls back to raw assets when topJsAssets are missing', () => {
  const report = createBundleReportFixture({ includeTopJsAssets: false });

  const summary = buildBundleSummary(report);

  assert.equal(summary.totalBytes, 662_570);
  assert.equal(summary.largestJsBytes, 395_470);
  assert.equal(summary.largestJsAsset?.label, 'vendor-polyfills.js');
  assert.equal(summary.entryAsset?.label, 'index.js');
  assert.equal(summary.cssAsset?.label, 'index.css');
});

test('buildBundleBaseline projects report metrics into tracked baseline shape', () => {
  const report = buildBundleReport(Object.values(createCoreBundleAssets()), '2026-03-26T12:00:00.000Z');

  const baseline = buildBundleBaseline(report, undefined, '2026-03-26T12:05:00.000Z');

  assert.equal(baseline.generatedAt, '2026-03-26T12:05:00.000Z');
  assert.equal(baseline.sourceReportGeneratedAt, '2026-03-26T12:00:00.000Z');
  assert.equal(baseline.metrics.totalBytes, 662_570);
  assert.equal(baseline.metrics.largestJsBytes, 395_470);
  assert.equal(baseline.assets.largestJs?.label, 'vendor-polyfills.js');
  assert.equal(baseline.assets.entryJs?.label, 'index.js');
});

test('getBundleBaselinePath resolves a relative override from the project root', () => {
  const baselinePath = getBundleBaselinePath({
    WORKBENCH_BUNDLE_BASELINE_PATH: 'tmp/custom-bundle-baseline.json',
  });

  assert.equal(baselinePath, `${projectRoot}/tmp/custom-bundle-baseline.json`);
});
