import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBudgetThresholds,
  evaluateBundleBudgets,
  formatBudgetCheck,
} from './checkBundleBudget.mjs';
import {
  buildRegressionAllowances,
  evaluateBundleRegression,
  formatRegressionCheck,
} from './checkBundleRegression.mjs';
import {
  createBundleSummaryFixture,
  createPolicyBundleBaselineFixture,
} from './bundleTestFixtures.mjs';

test('buildBudgetThresholds supports explicit env overrides', () => {
  const budgets = buildBudgetThresholds({
    WORKBENCH_BUNDLE_MAX_TOTAL_BYTES: '2100000',
    WORKBENCH_BUNDLE_MAX_CSS_BYTES: '130000',
  });

  assert.equal(budgets.totalBytes, 2_100_000);
  // The default: 560,000 for JavaScript and CSS plus 338,000 for the sql.js wasm.
  assert.equal(budgets.totalGzipBytes, 898_000);
  assert.equal(budgets.cssBytes, 130_000);
});

test('buildBudgetThresholds rejects invalid byte overrides', () => {
  assert.throws(
    () => buildBudgetThresholds({ WORKBENCH_BUNDLE_MAX_TOTAL_BYTES: 'not-a-number' }),
    /Invalid WORKBENCH_BUNDLE_MAX_TOTAL_BYTES/,
  );
});

test('evaluateBundleBudgets reports clean pass state within thresholds', () => {
  const { checks, failures, summaryMessage } = evaluateBundleBudgets(createBundleSummaryFixture(), {
    totalBytes: 2_000_000,
    totalGzipBytes: 560_000,
    largestJsBytes: 425_000,
    entryJsBytes: 170_000,
    cssBytes: 125_000,
  });

  assert.equal(checks.length, 5);
  assert.equal(failures.length, 0);
  assert.equal(summaryMessage, null);
  assert.match(formatBudgetCheck(checks[2]), /\[PASS\] Largest JavaScript asset/);
});

test('evaluateBundleBudgets reports exceeded thresholds with a readable summary', () => {
  const { failures, summaryMessage } = evaluateBundleBudgets(createBundleSummaryFixture(), {
    totalBytes: 1_800_000,
    totalGzipBytes: 560_000,
    largestJsBytes: 390_000,
    entryJsBytes: 170_000,
    cssBytes: 125_000,
  });

  assert.deepEqual(
    failures.map((failure) => failure.label),
    ['Total raw bundle size', 'Largest JavaScript asset'],
  );
  assert.match(summaryMessage, /Total raw bundle size exceeded by 80\.00 kB/);
  assert.match(summaryMessage, /Largest JavaScript asset exceeded by 5\.47 kB/);
});

test('buildRegressionAllowances supports explicit env overrides', () => {
  const allowances = buildRegressionAllowances({
    WORKBENCH_BUNDLE_BASELINE_MAX_TOTAL_BYTES_DELTA: '125000',
    WORKBENCH_BUNDLE_BASELINE_MAX_ENTRY_JS_BYTES_DELTA: '17000',
  });

  assert.equal(allowances.totalBytes, 125_000);
  assert.equal(allowances.totalGzipBytes, 28_000);
  assert.equal(allowances.entryJsBytes, 17_000);
});

test('buildRegressionAllowances rejects invalid byte overrides', () => {
  assert.throws(
    () => buildRegressionAllowances({ WORKBENCH_BUNDLE_BASELINE_MAX_CSS_BYTES_DELTA: '-1' }),
    /Invalid WORKBENCH_BUNDLE_BASELINE_MAX_CSS_BYTES_DELTA/,
  );
});

test('evaluateBundleRegression passes within allowance and formats stable assets', () => {
  const { checks, failures, summaryMessage } = evaluateBundleRegression(
    createBundleSummaryFixture(),
    createPolicyBundleBaselineFixture(),
    {
      totalBytes: 120_000,
      totalGzipBytes: 28_000,
      largestJsBytes: 29_000,
      entryJsBytes: 14_000,
      cssBytes: 13_000,
    },
  );

  assert.equal(checks.length, 5);
  assert.equal(failures.length, 0);
  assert.equal(summaryMessage, null);
  assert.match(formatRegressionCheck(checks[0]), /\[PASS\] Total raw bundle size/);
  assert.match(formatRegressionCheck(checks[2]), /assets\/vendor-polyfills\.js\)/);
});

test('evaluateBundleRegression reports allowance failures and asset relabeling', () => {
  const { failures, summaryMessage } = evaluateBundleRegression(
    createBundleSummaryFixture({
      largestJsBytes: 450_000,
      largestJsAsset: {
        fileName: 'assets/runtime-heavy-QWER1234.js',
        label: 'assets/runtime-heavy.js',
        bytes: 450_000,
        gzipBytes: 130_000,
      },
    }),
    createPolicyBundleBaselineFixture(),
    {
      totalBytes: 120_000,
      totalGzipBytes: 28_000,
      largestJsBytes: 10_000,
      entryJsBytes: 14_000,
      cssBytes: 13_000,
    },
  );

  assert.deepEqual(failures.map((failure) => failure.label), ['Largest JavaScript asset']);
  assert.match(summaryMessage, /Largest JavaScript asset exceeded baseline allowance by 58\.00 kB/);
  assert.match(
    formatRegressionCheck(failures[0]),
    /assets\/vendor-polyfills\.js -> assets\/runtime-heavy\.js/,
  );
});
