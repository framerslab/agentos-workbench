import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { patchGmiSource } from '../scripts/patch-agentos-provider-routing.mjs';

const backendDir = path.resolve(__dirname, '..');
const scriptPath = path.join(backendDir, 'scripts', 'patch-agentos-provider-routing.mjs');
const gmiRelativePath = path.join('node_modules', '@framers', 'agentos', 'dist', 'cognition', 'substrate', 'GMI.js');
const installedGmiPath = path.join(backendDir, gmiRelativePath);

const PATCHED_DECLARATION =
  'const providerIdForModel = preferredProviderIdFromInput || this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;';
const PROVIDER_INPUT_LINE = 'const preferredProviderIdFromInput = turnInput.metadata?.options?.preferredProviderId;';

// The block as agentos 0.15 ships it: the model id line sits between the two
// lines the patch reads, so a replace that expects them adjacent never matches.
const UNPATCHED_BLOCK = [
  '                const gateway = this.config.completionGateway;',
  '                const preferredModelIdFromInput = turnInput.metadata?.options?.preferredModelId;',
  '                const modelIdToUse = preferredModelIdFromInput || this.activePersona.defaultModelId || this.config.defaultLlmModelId;',
  '                const providerIdForModel = this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;',
  '                if (!modelIdToUse) {',
  '                    throw new Error("Could not determine modelId for LLM call.");',
  '                }',
].join('\n');

function providerDeclarations(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('const providerIdForModel ='));
}

function syntaxCheck(source: string): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gmi-syntax-'));
  const file = path.join(dir, 'GMI.mjs');
  writeFileSync(file, source, 'utf8');
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `patched GMI.js does not parse: ${result.stderr}`);
}

function runScript(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' });
}

function fakeInstall(source: string): { dir: string; gmiPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentos-install-'));
  const gmiPath = path.join(dir, gmiRelativePath);
  mkdirSync(path.dirname(gmiPath), { recursive: true });
  writeFileSync(gmiPath, source, 'utf8');
  return { dir, gmiPath };
}

test('patchGmiSource routes the turn provider through preferredProviderId on the agentos 0.15 layout', () => {
  const result = patchGmiSource(UNPATCHED_BLOCK);

  assert.equal(result.status, 'patched');
  assert.deepEqual(providerDeclarations(result.source), [PATCHED_DECLARATION]);
  const lines = result.source.split('\n');
  const inputLine = lines.findIndex((line) => line.trim() === PROVIDER_INPUT_LINE);
  const declarationLine = lines.findIndex((line) => line.trim() === PATCHED_DECLARATION);
  assert.ok(inputLine >= 0 && inputLine === declarationLine - 1, 'the provider input is read on the line before its use');
  assert.equal(lines[inputLine].match(/^\s*/)?.[0], lines[declarationLine].match(/^\s*/)?.[0]);
});

test('patchGmiSource leaves an already patched file unchanged', () => {
  const once = patchGmiSource(UNPATCHED_BLOCK).source;
  const twice = patchGmiSource(once);

  assert.equal(twice.status, 'already-applied');
  assert.equal(twice.source, once);
});

test('patchGmiSource reports an agentos that routes preferredProviderId itself', () => {
  const upstream = UNPATCHED_BLOCK.replace(
    'const providerIdForModel = this.activePersona.defaultProviderId',
    "const providerIdForModel = (typeof turnInput.metadata?.options?.preferredProviderId === 'string' && turnInput.metadata.options.preferredProviderId) || this.activePersona.defaultProviderId",
  );
  const result = patchGmiSource(upstream);

  assert.equal(result.status, 'upstream');
  assert.equal(result.source, upstream);
});

// The declaration as framerslab/agentos#680 compiles it: the turn's provider read on its own
// line, then a typeof check ahead of the persona's and the config's default.
test('patchGmiSource reports the upstream declaration that reads the turn provider first', () => {
  const upstream = UNPATCHED_BLOCK.replace(
    '                const providerIdForModel = this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;',
    [
      `                ${PROVIDER_INPUT_LINE}`,
      "                const providerIdForModel = (typeof preferredProviderIdFromInput === 'string' && preferredProviderIdFromInput) ||",
      '                    this.activePersona.defaultProviderId ||',
      '                    this.config.defaultLlmProviderId;',
    ].join('\n'),
  );
  const result = patchGmiSource(upstream);

  assert.equal(result.status, 'upstream');
  assert.equal(result.source, upstream);
});

test('patchGmiSource refuses a declaration where a default provider wins over preferredProviderId', () => {
  const defaultFirst = UNPATCHED_BLOCK.replace(
    'const providerIdForModel = this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;',
    'const providerIdForModel = this.activePersona.defaultProviderId || turnInput.metadata?.options?.preferredProviderId || this.config.defaultLlmProviderId;',
  );

  assert.throws(() => patchGmiSource(defaultFirst), /provider-routing/);
});

test('patchGmiSource throws when the provider selection it patches is gone', () => {
  assert.throws(() => patchGmiSource('export class GMI {}\n'), /provider-routing/);
});

// After `npm ci` the postinstall has already patched the installed file; CI's lockfile step
// installs with --ignore-scripts, so the suite sees it both ways.
test('patchGmiSource patches the GMI.js this lockfile installs, before or after the postinstall', () => {
  const source = readFileSync(installedGmiPath, 'utf8');
  const result = patchGmiSource(source);

  assert.ok(['patched', 'already-applied', 'upstream'].includes(result.status), `unexpected status ${result.status}`);
  if (result.status !== 'upstream') {
    assert.deepEqual(providerDeclarations(result.source), [PATCHED_DECLARATION]);
    assert.ok(result.source.includes(PROVIDER_INPUT_LINE));
  }
  syntaxCheck(result.source);
});

test('the postinstall script patches an install, is idempotent, and exits non-zero when it cannot patch', () => {
  const { dir, gmiPath } = fakeInstall(UNPATCHED_BLOCK);
  copyFileSync(gmiPath, `${gmiPath}.orig`);

  const first = runScript(dir);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(providerDeclarations(readFileSync(gmiPath, 'utf8')), [PATCHED_DECLARATION]);

  const second = runScript(dir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already applied/);

  const unknown = fakeInstall('export class GMI {}\n');
  const failed = runScript(unknown.dir);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /provider-routing/);
  assert.equal(readFileSync(unknown.gmiPath, 'utf8'), 'export class GMI {}\n');

  const empty = mkdtempSync(path.join(os.tmpdir(), 'agentos-missing-'));
  const missing = runScript(empty);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /GMI\.js/);
});
