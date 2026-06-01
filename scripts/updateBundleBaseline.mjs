#!/usr/bin/env node

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  buildBundleSummary,
  getBundleBaselinePath,
  readBundleReport,
} from './bundleMetrics.mjs';

export function buildBundleBaseline(report, summary = buildBundleSummary(report), generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    sourceReportGeneratedAt: report.generatedAt ?? null,
    project: report.project ?? '@framers/agentos-workbench',
    metrics: {
      totalBytes: summary.totalBytes,
      totalGzipBytes: summary.totalGzipBytes,
      largestJsBytes: summary.largestJsBytes,
      entryJsBytes: summary.entryJsBytes,
      cssBytes: summary.cssBytes,
    },
    assets: {
      largestJs: summary.largestJsAsset,
      entryJs: summary.entryAsset,
      css: summary.cssAsset,
    },
  };
}

async function main() {
  const report = await readBundleReport();
  const baselinePath = getBundleBaselinePath();
  const baseline = buildBundleBaseline(report);

  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${baselinePath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
