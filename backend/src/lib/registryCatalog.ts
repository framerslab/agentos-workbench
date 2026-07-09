import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const SKILLS_REGISTRY_ROOT = path.join(REPO_ROOT, 'packages/agentos-skills-registry');
const EXTENSIONS_REGISTRY_ROOT = path.join(REPO_ROOT, 'packages/agentos-extensions');

/**
 * Resolve the root directory that holds the skills content
 * (`registry.json` + `registry/curated/<name>/SKILL.md`).
 *
 * The skills ecosystem split content out of the catalog SDK: SKILL.md files
 * and registry.json now live in the `@framers/agentos-skills` content
 * package, while `@framers/agentos-skills-registry` is a code-only SDK with
 * no registry.json on disk. Resolution order:
 *
 * 1. `packages/agentos-skills` in the parent monorepo (current layout).
 * 2. `packages/agentos-skills-registry` (legacy layout, pre-split).
 * 3. The installed `@framers/agentos-skills` npm package (standalone
 *    checkouts with no monorepo siblings). The package explicitly exports
 *    `./registry.json`, so `require.resolve` is exports-safe.
 *
 * Memoized after the first hit; returns null when no candidate carries a
 * registry.json (skills then list as empty, matching the legacy behavior).
 */
let cachedSkillsContentRoot: string | null | undefined;
function resolveSkillsContentRoot(): string | null {
  if (cachedSkillsContentRoot !== undefined) {
    return cachedSkillsContentRoot;
  }
  const candidates = [
    path.join(REPO_ROOT, 'packages/agentos-skills'),
    SKILLS_REGISTRY_ROOT,
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'registry.json'))) {
      cachedSkillsContentRoot = candidate;
      return candidate;
    }
  }
  try {
    const requireFromHere = createRequire(__filename);
    const registryJson = requireFromHere.resolve('@framers/agentos-skills/registry.json');
    cachedSkillsContentRoot = path.dirname(registryJson);
    return cachedSkillsContentRoot;
  } catch {
    cachedSkillsContentRoot = null;
    return null;
  }
}

/**
 * Whether a guardrail pack's implementation is present in this environment.
 *
 * The five guardrail packs migrated out of the `agentos-extensions` monorepo
 * into standalone packages (`packages/agentos-ext-<packId>` beside the
 * workbench in the parent monorepo; `@framers/agentos-ext-<packId>` on npm),
 * so the extensions-registry directory probe alone reports them as missing.
 * A pack counts as installed when any of these hold:
 *
 * 1. The extensions-registry entry resolved (caller passes its `installed`).
 * 2. Its standalone package directory exists in the parent monorepo.
 * 3. Its npm package resolves from this backend's dependency graph.
 */
export function isGuardrailPackInstalled(packId: string, extensionInstalled?: boolean): boolean {
  if (extensionInstalled) {
    return true;
  }
  if (existsSync(path.join(REPO_ROOT, `packages/agentos-ext-${packId}`, 'package.json'))) {
    return true;
  }
  try {
    createRequire(__filename).resolve(`@framers/agentos-ext-${packId}/package.json`);
    return true;
  } catch {
    return false;
  }
}
const SECRET_ENV_MAP_SOURCE = path.join(
  REPO_ROOT,
  'packages/agentos-extensions-registry/src/secret-env-map.ts'
);

type JsonObject = Record<string, unknown>;

interface SkillRegistryEntry {
  id: string;
  name: string;
  displayName?: string;
  version?: string;
  path?: string;
  description?: string;
  category?: string;
  namespace?: string;
  verified?: boolean;
  source?: string;
  verifiedAt?: string;
  keywords?: string[];
  requiredSecrets?: string[];
  requiredTools?: string[];
  metadata?: JsonObject;
}

interface ExtensionRegistryEntry {
  id: string;
  name: string;
  package: string;
  version: string;
  category: string;
  path?: string;
  description: string;
  author?: {
    name?: string;
    email?: string;
    url?: string;
  };
  features?: string[];
  tools?: string[];
  keywords?: string[];
  npm?: string;
  repository?: string;
  verified?: boolean;
  verifiedAt?: string;
  verificationChecklistVersion?: string;
  downloads?: number;
}

interface ExtensionManifestEntry {
  id?: string;
  kind?: string;
  displayName?: string;
  description?: string;
}

interface ExtensionManifest {
  platforms?: string[];
  requiredSecrets?: string[];
  features?: string[];
  configuration?: JsonObject;
  extensions?: ExtensionManifestEntry[];
  categories?: string[];
}

export interface WorkbenchSkillInfo {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  category: string;
  namespace?: string;
  verified: boolean;
  source: string;
  verifiedAt?: string;
  tags: string[];
  emoji: string;
  primaryEnv: string | null;
  requiredEnvVars: string[];
  requiredSecrets: string[];
  requiredTools: string[];
  requiredBins: string[];
  installHints: JsonObject[];
  contentPath?: string;
}

export interface WorkbenchExtensionInfo {
  id: string;
  name: string;
  package: string;
  version: string;
  description: string;
  category: string;
  verified: boolean;
  verifiedAt?: string;
  verificationChecklistVersion?: string;
  installed: boolean;
  tools: string[];
  features: string[];
  keywords: string[];
  requiredSecrets: string[];
  requiredEnvVars: string[];
  platforms: string[];
  configuration: JsonObject;
  manifestEntries: Array<{
    id: string;
    kind?: string;
    displayName?: string;
    description?: string;
  }>;
  author?: {
    name?: string;
    email?: string;
    url?: string;
  };
  npm?: string;
  repository?: string;
  path?: string;
}

export interface WorkbenchToolInfo {
  id: string;
  name: string;
  description: string;
  extension: string;
  extensionPackage: string;
  category: string;
  hasSideEffects: boolean;
  kind?: string;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }
  return {
    frontmatter: match[1] ?? null,
    body: match[2] ?? '',
  };
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  const withoutBrackets = trimmed.replace(/^\[/, '').replace(/\]$/, '');
  return withoutBrackets
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseWorkspaceSkillFrontmatter(frontmatter: string | null): Partial<WorkbenchSkillInfo> {
  if (!frontmatter) {
    return {};
  }

  const parsed: Partial<WorkbenchSkillInfo> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_.-]+):\s*(.+)$/);
    if (!match) continue;
    const [, rawKey, rawValue] = match;
    const value = rawValue.trim();
    switch (rawKey) {
      case 'name':
        parsed.name = value.replace(/^['"]|['"]$/g, '');
        break;
      case 'displayName':
        parsed.displayName = value.replace(/^['"]|['"]$/g, '');
        break;
      case 'description':
        parsed.description = value.replace(/^['"]|['"]$/g, '');
        break;
      case 'category':
        parsed.category = value.replace(/^['"]|['"]$/g, '');
        break;
      case 'tags':
        parsed.tags = parseInlineArray(value);
        break;
      case 'requires_tools':
        parsed.requiredTools = parseInlineArray(value);
        break;
      case 'requires_secrets':
        parsed.requiredSecrets = parseInlineArray(value);
        break;
      default:
        break;
    }
  }

  const emojiMatch = frontmatter.match(/emoji:\s*["']?(.+?)["']?\s*$/m);
  if (emojiMatch?.[1]) {
    parsed.emoji = emojiMatch[1];
  }

  return parsed;
}

let cachedSecretEnvMap: Record<string, string> | null = null;

async function loadSecretEnvMap(): Promise<Record<string, string>> {
  if (cachedSecretEnvMap) {
    return cachedSecretEnvMap;
  }

  const source = await readTextFile(SECRET_ENV_MAP_SOURCE);
  const map: Record<string, string> = {};
  if (source) {
    const regex = /['"]([^'"]+)['"]:\s*\{\s*envVar:\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(regex)) {
      const [, secretId, envVar] = match;
      map[secretId] = envVar;
    }
  }

  cachedSecretEnvMap = map;
  return map;
}

function pickPrimaryEnv(
  metadata: JsonObject | undefined,
  requiredSecrets: string[],
  secretEnvMap: Record<string, string>
): { primaryEnv: string | null; requiredEnvVars: string[] } {
  const metadataPrimaryEnv =
    typeof metadata?.primaryEnv === 'string' ? metadata.primaryEnv : null;
  const requiredEnvVars = requiredSecrets
    .map((secretId) => secretEnvMap[secretId])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (metadataPrimaryEnv) {
    return {
      primaryEnv: metadataPrimaryEnv,
      requiredEnvVars: requiredEnvVars.includes(metadataPrimaryEnv)
        ? requiredEnvVars
        : [metadataPrimaryEnv, ...requiredEnvVars],
    };
  }

  return {
    primaryEnv: requiredEnvVars[0] ?? null,
    requiredEnvVars,
  };
}

async function loadWorkspaceSkills(secretEnvMap: Record<string, string>): Promise<WorkbenchSkillInfo[]> {
  const workspaceSkillsDir = path.join(REPO_ROOT, '.agents', 'skills');
  if (!existsSync(workspaceSkillsDir)) {
    return [];
  }

  const entries = await readdir(workspaceSkillsDir, { withFileTypes: true });
  const skills = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return null;
    }

    const skillDir = path.join(workspaceSkillsDir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) {
      return null;
    }

    const content = await readTextFile(skillFile);
    if (!content) {
      return null;
    }

    const { frontmatter } = splitFrontmatter(content);
    const metadata = parseWorkspaceSkillFrontmatter(frontmatter);
    const requiredSecrets = metadata.requiredSecrets ?? [];
    const envInfo = pickPrimaryEnv(undefined, requiredSecrets, secretEnvMap);

    return {
      id: `workspace:${metadata.name ?? entry.name}`,
      name: metadata.name ?? entry.name,
      displayName: metadata.displayName ?? metadata.name ?? entry.name,
      version: 'workspace',
      description: metadata.description ?? 'Workspace skill',
      category: metadata.category ?? 'workspace',
      namespace: 'workspace',
      verified: false,
      source: 'workspace',
      tags: metadata.tags ?? [],
      emoji: metadata.emoji ?? '🧩',
      primaryEnv: envInfo.primaryEnv,
      requiredEnvVars: envInfo.requiredEnvVars,
      requiredSecrets,
      requiredTools: metadata.requiredTools ?? [],
      requiredBins: [],
      installHints: [],
      contentPath: skillFile,
    } satisfies WorkbenchSkillInfo;
  }));

  return skills.filter(
    (skill) => skill !== null
  ) as WorkbenchSkillInfo[];
}

export async function listWorkbenchSkills(): Promise<WorkbenchSkillInfo[]> {
  const skillsContentRoot = resolveSkillsContentRoot();
  const registry = skillsContentRoot
    ? await readJsonFile<{ skills?: { curated?: SkillRegistryEntry[]; community?: SkillRegistryEntry[] } }>(
        path.join(skillsContentRoot, 'registry.json')
      )
    : null;
  const secretEnvMap = await loadSecretEnvMap();
  const curated = registry?.skills?.curated ?? [];
  const community = registry?.skills?.community ?? [];
  const workspaceSkills = await loadWorkspaceSkills(secretEnvMap);

  const catalog = [...curated, ...community].map((entry) => {
    const metadata = entry.metadata ?? {};
    const requiredSecrets = normalizeStringArray(entry.requiredSecrets);
    const envInfo = pickPrimaryEnv(metadata, requiredSecrets, secretEnvMap);
    const requires = metadata.requires;
    const requiredBins =
      requires && typeof requires === 'object' && !Array.isArray(requires)
        ? normalizeStringArray((requires as JsonObject).bins)
        : [];
    const installHints = Array.isArray(metadata.install)
      ? metadata.install.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];

    return {
      id: entry.id,
      name: entry.name,
      displayName: entry.displayName || entry.name,
      version: entry.version ?? '1.0.0',
      description: entry.description ?? '',
      category: entry.category ?? 'uncategorized',
      namespace: entry.namespace,
      verified: Boolean(entry.verified),
      source: entry.source ?? 'curated',
      verifiedAt: entry.verifiedAt,
      tags: normalizeStringArray(entry.keywords),
      emoji: typeof metadata.emoji === 'string' ? metadata.emoji : '🧩',
      primaryEnv: envInfo.primaryEnv,
      requiredEnvVars: envInfo.requiredEnvVars,
      requiredSecrets,
      requiredTools: normalizeStringArray(entry.requiredTools),
      requiredBins,
      installHints,
      contentPath: entry.path && skillsContentRoot
        ? path.join(skillsContentRoot, entry.path, 'SKILL.md')
        : undefined,
    } satisfies WorkbenchSkillInfo;
  });

  const byName = new Map<string, WorkbenchSkillInfo>();
  for (const skill of catalog) {
    byName.set(skill.name, skill);
  }
  for (const skill of workspaceSkills) {
    byName.set(skill.name, skill);
  }

  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getWorkbenchSkill(name: string): Promise<(WorkbenchSkillInfo & { content: string }) | null> {
  const skills = await listWorkbenchSkills();
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    return null;
  }

  const rawContent = skill.contentPath ? await readTextFile(skill.contentPath) : null;
  const { body } = splitFrontmatter(rawContent ?? '');

  return {
    ...skill,
    content: body.trim() || `# ${skill.displayName}\n\n${skill.description}`,
  };
}

export async function listWorkbenchExtensions(): Promise<WorkbenchExtensionInfo[]> {
  const registry = await readJsonFile<{
    extensions?: {
      curated?: ExtensionRegistryEntry[];
      community?: ExtensionRegistryEntry[];
    };
  }>(path.join(EXTENSIONS_REGISTRY_ROOT, 'registry.json'));
  const secretEnvMap = await loadSecretEnvMap();
  const entries = [...(registry?.extensions?.curated ?? []), ...(registry?.extensions?.community ?? [])];

  const extensions = await Promise.all(entries.map(async (entry) => {
    const manifestPath = entry.path
      ? path.join(EXTENSIONS_REGISTRY_ROOT, entry.path, 'manifest.json')
      : null;
    const manifest = manifestPath ? await readJsonFile<ExtensionManifest>(manifestPath) : null;
    const requiredSecrets = normalizeStringArray(manifest?.requiredSecrets);
    const requiredEnvVars = requiredSecrets
      .map((secretId) => secretEnvMap[secretId])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const manifestEntries = (manifest?.extensions ?? [])
      .filter((item): item is ExtensionManifestEntry => Boolean(item))
      .map((item) => ({
        id: item.id ?? '',
        kind: item.kind,
        displayName: item.displayName,
        description: item.description,
      }))
      .filter((item) => item.id.length > 0);

    return {
      id: entry.id,
      name: entry.name,
      package: entry.package,
      version: entry.version,
      description: entry.description,
      category: entry.category,
      verified: Boolean(entry.verified),
      verifiedAt: entry.verifiedAt,
      verificationChecklistVersion: entry.verificationChecklistVersion,
      installed: entry.path ? existsSync(path.join(EXTENSIONS_REGISTRY_ROOT, entry.path)) : false,
      tools: normalizeStringArray(entry.tools),
      features: normalizeStringArray(manifest?.features).length > 0
        ? normalizeStringArray(manifest?.features)
        : normalizeStringArray(entry.features),
      keywords: normalizeStringArray(entry.keywords),
      requiredSecrets,
      requiredEnvVars,
      platforms: normalizeStringArray(manifest?.platforms),
      configuration:
        manifest?.configuration && typeof manifest.configuration === 'object' && !Array.isArray(manifest.configuration)
          ? manifest.configuration
          : {},
      manifestEntries,
      author: entry.author,
      npm: entry.npm,
      repository: entry.repository,
      path: entry.path,
    } satisfies WorkbenchExtensionInfo;
  }));

  return extensions.sort((left, right) => left.name.localeCompare(right.name));
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferToolSideEffects(toolId: string, category: string): boolean {
  if (category === 'channels' || category === 'communications' || category === 'cloud') {
    return true;
  }

  return /(send|post|publish|reply|delete|remove|create|update|deploy|install|like|follow|schedule|share|upload|execute|run|set|write|comment)/i.test(toolId);
}

export async function listWorkbenchTools(): Promise<WorkbenchToolInfo[]> {
  const extensions = await listWorkbenchExtensions();
  return extensions.flatMap((extension) => {
    const manifestEntriesById = new Map(
      extension.manifestEntries.map((entry) => [entry.id, entry] as const)
    );

    return extension.tools.map((toolId) => {
      const manifestEntry = manifestEntriesById.get(toolId);
      return {
        id: toolId,
        name: manifestEntry?.displayName ?? humanizeIdentifier(toolId),
        description: manifestEntry?.description ?? extension.description,
        extension: extension.name,
        extensionPackage: extension.package,
        category: extension.category,
        hasSideEffects: inferToolSideEffects(toolId, extension.category),
        kind: manifestEntry?.kind,
      } satisfies WorkbenchToolInfo;
    });
  });
}

export async function listGuardrailExtensions(): Promise<WorkbenchExtensionInfo[]> {
  const guardrailPackageSuffixes = [
    'pii-redaction',
    'ml-classifiers',
    'topicality',
    'code-safety',
    'grounding-guard',
  ];
  const extensions = await listWorkbenchExtensions();
  return guardrailPackageSuffixes
    .map((suffix) => extensions.find((entry) => entry.package.endsWith(suffix)))
    .filter((entry): entry is WorkbenchExtensionInfo => Boolean(entry));
}
