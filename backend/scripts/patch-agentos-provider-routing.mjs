import { realpathSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The backend sends `options.preferredProviderId` with every turn
// (buildWorkbenchProcessRequestInput), but agentos's GMI picks the turn's
// provider from the persona or config default only, so a model chosen in the
// playground goes to the wrong provider. This postinstall makes the GMI read
// the turn's preferred provider first. It fails the install when it cannot
// apply, so a changed agentos layout is seen at once instead of being skipped.

// agentos moved `cognitive_substrate/` to `cognition/substrate/` in 0.9.x.
const CANDIDATE_PATHS = [
  'node_modules/@framers/agentos/dist/cognition/substrate/GMI.js',
  'node_modules/@framers/agentos/dist/cognitive_substrate/GMI.js',
];

const PROVIDER_INPUT_LINE =
  'const preferredProviderIdFromInput = turnInput.metadata?.options?.preferredProviderId;';
const PATCHED_DECLARATION =
  'const providerIdForModel = preferredProviderIdFromInput || this.activePersona.defaultProviderId || this.config.defaultLlmProviderId;';
const UNPATCHED_DECLARATION =
  /^([ \t]*)const providerIdForModel = this\.activePersona\.defaultProviderId \|\| this\.config\.defaultLlmProviderId;[ \t]*$/gm;
// Each providerIdForModel declaration's initializer, up to its semicolon.
const PROVIDER_DECLARATIONS = /const providerIdForModel\s*=([^;]*);/g;
const DEFAULT_PROVIDER = /defaultProviderId|defaultLlmProviderId/;

/** Whether an initializer takes the turn's preferred provider before any default provider. */
function readsPreferredProviderFirst(initializer) {
  const preferred = initializer.indexOf('preferredProviderId');
  const firstDefault = initializer.search(DEFAULT_PROVIDER);
  return preferred >= 0 && (firstDefault < 0 || preferred < firstDefault);
}

/**
 * Returns GMI.js with the turn's preferred provider routed, or says why it is
 * left as it is. Throws when the provider selection it patches is not there.
 *
 * @param {string} source
 * @returns {{ status: 'patched' | 'already-applied' | 'upstream', source: string }}
 */
export function patchGmiSource(source) {
  if (source.includes(PROVIDER_INPUT_LINE) && source.includes(PATCHED_DECLARATION)) {
    return { status: 'already-applied', source };
  }
  const initializers = [...source.matchAll(PROVIDER_DECLARATIONS)].map((match) => match[1]);
  if (initializers.some((initializer) => initializer.includes('preferredProviderId'))) {
    // An agentos whose own declaration reads the turn's preferred provider counts as upstream
    // routing only when that provider comes before the persona's and the config's default.
    if (initializers.every(readsPreferredProviderFirst)) {
      return { status: 'upstream', source };
    }
    throw new Error(
      'AgentOS provider-routing patch: GMI.js reads preferredProviderId in providerIdForModel, but a default provider comes first, so the turn\'s provider is ignored. ' +
        'Update backend/scripts/patch-agentos-provider-routing.mjs for this agentos version.',
    );
  }
  if (source.includes(PROVIDER_INPUT_LINE)) {
    throw new Error(
      'AgentOS provider-routing patch: GMI.js reads preferredProviderIdFromInput but its providerIdForModel line is not the patched one. Reinstall @framers/agentos.',
    );
  }
  const matches = source.match(UNPATCHED_DECLARATION) ?? [];
  if (matches.length !== 1 || !source.includes('turnInput.metadata?.options?.preferredModelId')) {
    throw new Error(
      `AgentOS provider-routing patch: expected one providerIdForModel declaration beside the preferredModelId read in GMI.js, found ${matches.length}. ` +
        'Update backend/scripts/patch-agentos-provider-routing.mjs for this agentos version.',
    );
  }
  const patched = source.replace(
    UNPATCHED_DECLARATION,
    (_line, indent) => `${indent}${PROVIDER_INPUT_LINE}\n${indent}${PATCHED_DECLARATION}`,
  );
  return { status: 'patched', source: patched };
}

async function findTarget(root) {
  for (const candidate of CANDIDATE_PATHS) {
    const resolved = path.resolve(root, candidate);
    try {
      await access(resolved);
      return resolved;
    } catch {
      // try the next layout
    }
  }
  return null;
}

async function main() {
  const targetPath = await findTarget(process.cwd());
  if (!targetPath) {
    throw new Error(
      `AgentOS provider-routing patch: GMI.js not found under ${process.cwd()} (looked for ${CANDIDATE_PATHS.join(', ')}).`,
    );
  }
  const result = patchGmiSource(await readFile(targetPath, 'utf8'));
  if (result.status === 'already-applied') {
    console.log('AgentOS provider-routing patch already applied.');
    return;
  }
  if (result.status === 'upstream') {
    console.log(
      'AgentOS routes preferredProviderId itself; the provider-routing patch is not needed and can be removed.',
    );
    return;
  }
  await writeFile(targetPath, result.source, 'utf8');
  const written = await readFile(targetPath, 'utf8');
  if (!written.includes(PATCHED_DECLARATION)) {
    throw new Error(`AgentOS provider-routing patch: ${targetPath} does not hold the patched line after writing.`);
  }
  console.log(`Applied AgentOS provider-routing patch to ${targetPath}.`);
}

// Node loads a main module from its real path, so both sides are resolved: through a symlinked
// directory an unresolved argv[1] would not match and the patch would be skipped with exit 0.
function isInvokedDirectly() {
  if (typeof process.argv[1] !== 'string') {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isInvokedDirectly();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
