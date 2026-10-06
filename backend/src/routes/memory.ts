import { FastifyInstance, FastifyReply } from 'fastify';
import { getAgentOS } from '../lib/agentos';

export type MemoryWorkbenchMode = 'runtime' | 'demo';

export const WORKBENCH_MEMORY_MODE_HEADER = 'X-AgentOS-Workbench-Mode';

// ---------------------------------------------------------------------------
// Mock memory data — mirrors the four-tier AgentOS cognitive memory model.
// Used as fallback when the real AgentOS runtime is not connected or does not
// expose its internal memory subsystem via a public API.
// ---------------------------------------------------------------------------

/**
 * A single entry in one of the long-term memory categories (episodic, semantic,
 * or procedural).
 *
 * @property id         - Stable unique identifier for delete/pin operations.
 * @property content    - Human-readable description of the remembered fact or event.
 * @property confidence - Model confidence score in [0, 1].
 * @property timestamp  - Unix ms when the entry was written.
 * @property source     - Origin of the memory: 'conversation' | 'observation' | 'rag' | 'learned' | 'policy'.
 * @property tags       - Searchable label list used for UI filtering.
 */
interface MemoryEntry {
  id: string;
  content: string;
  confidence: number;
  timestamp: number;
  source: string;
  tags: string[];
}

/**
 * Snapshot of the agent's working (context-window) memory.
 *
 * @property tokens        - Current token consumption of the active context.
 * @property maxTokens     - Hard limit imposed by the model's context window.
 * @property activeTurns   - Number of un-summarised conversation turns in context.
 * @property summarizedTurns - Turns that have been compressed into the rolling summary.
 * @property rollingSummary  - Condensed narrative of prior context used to preserve continuity.
 */
interface WorkingMemory {
  tokens: number;
  maxTokens: number;
  activeTurns: number;
  summarizedTurns: number;
  rollingSummary: string;
}

/**
 * Container for all four memory categories served by the `/memory/entries` endpoint.
 */
interface MemoryStore {
  episodic: MemoryEntry[];
  semantic: MemoryEntry[];
  procedural: MemoryEntry[];
  working: WorkingMemory;
}

/**
 * A single entry in the memory operation timeline feed.
 *
 * @property timestamp  - Unix ms when the operation occurred.
 * @property operation  - Operation type: WRITE | RETRIEVE | CONSOLIDATE | SUMMARIZE | DELETE.
 * @property category   - Memory tier that was targeted.
 * @property content    - Short description of what was written, retrieved, or transformed.
 * @property metadata   - Arbitrary key/value bag (confidence, relevance, tokensSaved, etc.).
 */
interface TimelineEntry {
  timestamp: number;
  operation: string;
  category: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface MemoryDeletionStore {
  episodic: Array<{ id: string }>;
  semantic: Array<{ id: string }>;
  procedural: Array<{ id: string }>;
}

export interface RuntimeMemoryDeleteState {
  liveManagers: Array<{
    manager: {
      getStore?: () =>
        | {
            getTrace?: (id: string) => unknown;
            softDelete?: (id: string) => Promise<unknown> | unknown;
          }
        | undefined;
    };
  }>;
}

/**
 * In-memory mock data store.  State is process-scoped and resets on restart —
 * acceptable for a workbench prototype where persistence is added separately.
 */
const mockMemoryEntries: MemoryStore = {
  episodic: [
    {
      id: 'ep-1',
      content: 'User asked about billing refund policy',
      confidence: 0.85,
      timestamp: Date.now() - 180_000,
      source: 'conversation',
      tags: ['billing'],
    },
    {
      id: 'ep-2',
      content: 'User prefers formal communication style',
      confidence: 0.72,
      timestamp: Date.now() - 900_000,
      source: 'observation',
      tags: ['style'],
    },
    {
      id: 'ep-3',
      content: 'User mentioned they are a premium subscriber',
      confidence: 0.91,
      timestamp: Date.now() - 1_800_000,
      source: 'conversation',
      tags: ['account'],
    },
  ],
  semantic: [
    {
      id: 'sem-1',
      content: 'Company refund policy allows returns within 30 days',
      confidence: 0.95,
      timestamp: Date.now() - 3_600_000,
      source: 'rag',
      tags: ['policy'],
    },
    {
      id: 'sem-2',
      content: 'Business hours are 9am-5pm EST Monday through Friday',
      confidence: 0.9,
      timestamp: Date.now() - 7_200_000,
      source: 'rag',
      tags: ['hours'],
    },
  ],
  procedural: [
    {
      id: 'proc-1',
      content: 'Always use formal greeting for this user',
      confidence: 1.0,
      timestamp: Date.now() - 86_400_000,
      source: 'learned',
      tags: ['greeting'],
    },
    {
      id: 'proc-2',
      content: 'Escalate billing disputes to human agent after 2 failed resolutions',
      confidence: 0.88,
      timestamp: Date.now() - 172_800_000,
      source: 'policy',
      tags: ['escalation'],
    },
  ],
  working: {
    tokens: 4200,
    maxTokens: 8000,
    activeTurns: 3,
    summarizedTurns: 2,
    rollingSummary:
      'User is a premium customer inquiring about refund policy for a recent charge. ' +
      'They prefer formal communication and have been with the company for 2 years.',
  },
};

/**
 * Chronological log of recent memory operations shown in the Timeline sub-view.
 */
const mockTimeline: TimelineEntry[] = [
  {
    timestamp: Date.now() - 180_000,
    operation: 'WRITE',
    category: 'episodic',
    content: 'User asked about billing refund policy',
    metadata: { confidence: 0.85 },
  },
  {
    timestamp: Date.now() - 175_000,
    operation: 'RETRIEVE',
    category: 'semantic',
    content: 'Company refund policy is 30 days',
    metadata: { relevance: 0.92, source: 'rag' },
  },
  {
    timestamp: Date.now() - 120_000,
    operation: 'WRITE',
    category: 'episodic',
    content: 'User mentioned premium subscription',
    metadata: { confidence: 0.91 },
  },
  {
    timestamp: Date.now() - 60_000,
    operation: 'SUMMARIZE',
    category: 'working',
    content: 'Compressed turns 1-5 into rolling summary',
    metadata: { tokensSaved: 2400 },
  },
  {
    timestamp: Date.now() - 30_000,
    operation: 'CONSOLIDATE',
    category: 'semantic',
    content: 'Promoted billing pattern to semantic memory',
    metadata: { fromCategory: 'episodic' },
  },
];

// ---------------------------------------------------------------------------
// Runtime helpers — attempt to extract real memory data from AgentOS
// ---------------------------------------------------------------------------

type RuntimeConversationSnapshot = {
  sessionId?: string;
  userId?: string;
  gmiInstanceId?: string;
  lastActiveAt?: number;
};

type RuntimeSnapshot = {
  conversations?: {
    items?: RuntimeConversationSnapshot[];
  };
};

type RuntimeAgentOS = {
  getRuntimeSnapshot?: () => Promise<RuntimeSnapshot>;
  getConversationHistory?: (conversationId: string, userId: string) => Promise<any>;
  getGMIManager?: () => {
    activeGMIs: Map<string, any>;
    gmiSessionMap: Map<string, string>;
  };
};

type LiveMemoryManager = {
  gmiId: string;
  sessionIds: string[];
  manager: any;
};

export type RuntimeMemoryState = {
  conversations: Array<{ sessionId: string; userId: string; context: any }>;
  liveManagers: LiveMemoryManager[];
};

export interface MemoryRoutesOptions {
  runtimeGetter?: () => Promise<RuntimeMemoryState | null>;
}

type LiveWorkingDiagnostics = {
  tokens: number;
  maxTokens: number;
  slotCount?: number;
  slotCapacity?: number;
  slotUtilization?: number;
  summaryChainNodes?: number;
  compactedMessages?: number;
  strategy?: string;
  transparencyReport?: string;
};

function mapMemorySource(sourceType: string | undefined): string {
  switch (sourceType) {
    case 'user_statement':
      return 'conversation';
    case 'observation':
      return 'observation';
    case 'external':
      return 'rag';
    case 'reflection':
      return 'policy';
    case 'tool_result':
      return 'learned';
    case 'agent_inference':
    default:
      return 'learned';
  }
}

function estimateConversationStats(
  conversations: Array<{ sessionId: string; userId: string; context: any }>
): {
  newestTimestamp: number;
  totalTokenEstimate: number;
  activeTurns: number;
  summarizedTurns: number;
  rollingSummaries: string[];
} {
  let newestTimestamp = 0;
  let totalTokenEstimate = 0;
  let activeTurns = 0;
  let summarizedTurns = 0;
  const rollingSummaries: string[] = [];

  for (const { context } of conversations) {
    const history: ReadonlyArray<any> =
      typeof context?.getHistory === 'function' ? context.getHistory() : [];
    activeTurns += history.length;

    for (const message of history) {
      const content =
        typeof message?.content === 'string'
          ? message.content
          : JSON.stringify(message?.content ?? '');
      const timestamp =
        typeof message?.timestamp === 'number'
          ? message.timestamp
          : typeof message?.createdAt === 'number'
            ? message.createdAt
            : 0;
      newestTimestamp = Math.max(newestTimestamp, timestamp);
      totalTokenEstimate += Math.ceil(content.length / 4);
    }

    const summary =
      context?.getMetadata?.('rollingSummary') ??
      context?.getMetadata?.('rollingSummaryState')?.summary ??
      '';
    if (typeof summary === 'string' && summary.trim()) {
      rollingSummaries.push(summary.trim());
      summarizedTurns += 1;
    }
  }

  return {
    newestTimestamp,
    totalTokenEstimate,
    activeTurns,
    summarizedTurns,
    rollingSummaries,
  };
}

function collectLiveTraceEntries(runtime: RuntimeMemoryState): {
  episodic: MemoryEntry[];
  semantic: MemoryEntry[];
  procedural: MemoryEntry[];
  prospective: MemoryEntry[];
  deleted: MemoryEntry[];
  timeline: TimelineEntry[];
} {
  const episodic: MemoryEntry[] = [];
  const semantic: MemoryEntry[] = [];
  const procedural: MemoryEntry[] = [];
  const prospective: MemoryEntry[] = [];
  const deleted: MemoryEntry[] = [];
  const timeline: TimelineEntry[] = [];
  const seenIds = new Set<string>();

  for (const live of runtime.liveManagers) {
    const store = live.manager.getStore?.();
    if (!store?.listTraces) {
      continue;
    }

    const traces: Array<any> = store.listTraces();
    for (const trace of traces) {
      if (!trace?.id || seenIds.has(trace.id)) {
        continue;
      }
      seenIds.add(trace.id);

      const entry: MemoryEntry = {
        id: trace.id,
        content:
          typeof trace.content === 'string' ? trace.content : JSON.stringify(trace.content ?? ''),
        confidence: Number(trace.provenance?.confidence ?? 0.8),
        timestamp: Number(trace.createdAt ?? Date.now()),
        source: mapMemorySource(trace.provenance?.sourceType),
        tags: Array.from(
          new Set([
            ...(Array.isArray(trace.tags) ? trace.tags : []),
            ...(Array.isArray(trace.entities) ? trace.entities : []),
            live.gmiId,
          ])
        ),
      };

      if (trace.isActive === false) {
        deleted.push(entry);
      } else {
        if (trace.type === 'episodic') episodic.push(entry);
        if (trace.type === 'semantic') semantic.push(entry);
        if (trace.type === 'procedural') procedural.push(entry);
        if (trace.type === 'prospective') prospective.push(entry);
      }

      timeline.push({
        timestamp: entry.timestamp,
        operation: 'WRITE',
        category: trace.type ?? 'episodic',
        content: entry.content.slice(0, 120),
        metadata: {
          confidence: entry.confidence,
          gmiId: live.gmiId,
          sourceType: trace.provenance?.sourceType,
        },
      });

      if ((trace.retrievalCount ?? 0) > 0 && trace.lastAccessedAt) {
        timeline.push({
          timestamp: trace.lastAccessedAt,
          operation: 'RETRIEVE',
          category: trace.type ?? 'episodic',
          content: entry.content.slice(0, 120),
          metadata: {
            retrievalCount: trace.retrievalCount,
            gmiId: live.gmiId,
          },
        });
      }

      if (trace.isActive === false) {
        timeline.push({
          timestamp: Number(trace.updatedAt ?? trace.createdAt ?? Date.now()),
          operation: 'DELETE',
          category: trace.type ?? 'episodic',
          content: entry.content.slice(0, 120),
          metadata: {
            gmiId: live.gmiId,
          },
        });
      }
    }
  }

  return {
    episodic,
    semantic,
    procedural,
    prospective,
    deleted,
    timeline,
  };
}

async function tryGetRuntimeMemory(): Promise<RuntimeMemoryState | null> {
  try {
    const agentos = (await getAgentOS()) as RuntimeAgentOS;
    if (
      typeof agentos.getRuntimeSnapshot !== 'function' ||
      typeof agentos.getGMIManager !== 'function' ||
      typeof agentos.getConversationHistory !== 'function'
    ) {
      return null;
    }

    const runtimeSnapshot = await agentos.getRuntimeSnapshot();
    const gmiManager = agentos.getGMIManager();
    const liveManagers: LiveMemoryManager[] = [];

    for (const [gmiId, gmi] of gmiManager.activeGMIs.entries()) {
      const manager = gmi?.getCognitiveMemoryManager?.();
      if (!manager) {
        continue;
      }
      const sessionIds = Array.from(gmiManager.gmiSessionMap.entries())
        .filter(([, mappedGmiId]) => mappedGmiId === gmiId)
        .map(([sessionId]) => sessionId);
      liveManagers.push({ gmiId, sessionIds, manager });
    }

    const conversations: Array<{ sessionId: string; userId: string; context: any }> = [];
    for (const item of runtimeSnapshot.conversations?.items ?? []) {
      if (!item?.sessionId || !item?.userId) {
        continue;
      }
      const context = await agentos
        .getConversationHistory(item.sessionId, item.userId)
        .catch(() => null);
      if (context) {
        conversations.push({
          sessionId: item.sessionId,
          userId: item.userId,
          context,
        });
      }
    }

    return { conversations, liveManagers };
  } catch (error) {
    // The routes fall back to demo data; say why, or a broken runtime looks like an absent one.
    console.warn(
      '[memory routes] live AgentOS memory unavailable, serving demo data:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function withMemoryMode<T extends Record<string, unknown>>(
  reply: FastifyReply,
  mode: MemoryWorkbenchMode,
  payload: T
): T & { mode: MemoryWorkbenchMode } {
  reply.header(WORKBENCH_MEMORY_MODE_HEADER, mode);
  return { mode, ...payload };
}

export async function deleteMemoryEntryById(
  id: string,
  runtime: RuntimeMemoryDeleteState | null,
  store: MemoryDeletionStore = mockMemoryEntries
): Promise<
  { ok: true; mode: MemoryWorkbenchMode } | { ok: false; mode: MemoryWorkbenchMode; error: string }
> {
  if (runtime) {
    for (const live of runtime.liveManagers) {
      const liveStore = live.manager.getStore?.();
      const trace = liveStore?.getTrace?.(id);
      if (trace) {
        await liveStore?.softDelete?.(id);
        return { ok: true, mode: 'runtime' };
      }
    }

    return { ok: false, mode: 'runtime', error: 'Memory entry not found' };
  }

  for (const cat of ['episodic', 'semantic', 'procedural'] as const) {
    const idx = store[cat].findIndex((entry) => entry.id === id);
    if (idx >= 0) {
      store[cat].splice(idx, 1);
      return { ok: true, mode: 'demo' };
    }
  }

  return { ok: false, mode: 'demo', error: 'Memory entry not found' };
}

function buildRealMemoryStats(runtime: RuntimeMemoryState): Record<string, unknown> {
  const traces = collectLiveTraceEntries(runtime);
  const conversationStats = estimateConversationStats(runtime.conversations);
  const workingDiagnostics = collectWorkingDiagnostics(runtime, conversationStats);

  return {
    connected: true,
    episodic: {
      count: traces.episodic.length,
      newest: conversationStats.newestTimestamp || traces.episodic[0]?.timestamp,
    },
    semantic: { count: traces.semantic.length },
    procedural: { count: traces.procedural.length },
    working: {
      tokens: workingDiagnostics.tokens,
      maxTokens: workingDiagnostics.maxTokens,
      activeSessions: runtime.conversations.length,
    },
  };
}

function buildRealWorkingMemory(runtime: RuntimeMemoryState): Record<string, unknown> {
  const conversationStats = estimateConversationStats(runtime.conversations);
  const workingDiagnostics = collectWorkingDiagnostics(runtime, conversationStats);

  return {
    connected: true,
    tokens: workingDiagnostics.tokens,
    maxTokens: workingDiagnostics.maxTokens,
    activeTurns: conversationStats.activeTurns,
    summarizedTurns: conversationStats.summarizedTurns,
    rollingSummary:
      conversationStats.rollingSummaries.length > 0
        ? conversationStats.rollingSummaries.join(' | ')
        : `${runtime.conversations.length} active session(s), ${conversationStats.activeTurns} total turns in context.`,
    activeSessions: runtime.conversations.length,
    slotCount: workingDiagnostics.slotCount,
    slotCapacity: workingDiagnostics.slotCapacity,
    slotUtilization: workingDiagnostics.slotUtilization,
    summaryChainNodes: workingDiagnostics.summaryChainNodes,
    compactedMessages: workingDiagnostics.compactedMessages,
    strategy: workingDiagnostics.strategy,
    transparencyReport: workingDiagnostics.transparencyReport,
  };
}

function buildRealTimeline(runtime: RuntimeMemoryState, sinceTs: number): TimelineEntry[] {
  const live = collectLiveTraceEntries(runtime).timeline;
  const conversationStats = estimateConversationStats(runtime.conversations);
  const summaryEntries = runtime.conversations
    .map(({ sessionId, context }) => {
      const summary =
        context?.getMetadata?.('rollingSummary') ??
        context?.getMetadata?.('rollingSummaryState')?.summary ??
        '';
      const history: ReadonlyArray<any> =
        typeof context?.getHistory === 'function' ? context.getHistory() : [];
      const timestamp =
        history.length > 0
          ? Math.max(...history.map((message) => Number(message?.timestamp ?? 0)))
          : Date.now();
      if (typeof summary !== 'string' || !summary.trim()) {
        return null;
      }
      return {
        timestamp,
        operation: 'SUMMARIZE',
        category: 'working',
        content: summary.trim().slice(0, 120),
        metadata: {
          sessionId,
          summarizedTurns: conversationStats.summarizedTurns,
        },
      } satisfies TimelineEntry;
    })
    .filter(Boolean) as TimelineEntry[];

  return [...live, ...summaryEntries]
    .filter((entry) => entry.timestamp > sinceTs)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function buildRealEntries(runtime: RuntimeMemoryState): Record<string, unknown> {
  const traces = collectLiveTraceEntries(runtime);
  return {
    connected: true,
    episodic: traces.episodic,
    semantic: traces.semantic,
    procedural: traces.procedural,
    prospective: traces.prospective,
  };
}

function collectWorkingDiagnostics(
  runtime: RuntimeMemoryState,
  conversationStats: ReturnType<typeof estimateConversationStats>
): LiveWorkingDiagnostics {
  let tokens = 0;
  let maxTokens = 0;
  let slotCount = 0;
  let slotCapacity = 0;
  let summaryChainNodes = 0;
  let compactedMessages = 0;
  const strategies = new Set<string>();
  const transparencyReports: string[] = [];

  for (const live of runtime.liveManagers) {
    const manager = live.manager;
    const workingMemory = manager.getWorkingMemory?.();
    const contextStats = manager.getContextWindowStats?.();
    const configuredMaxTokens = manager.getConfig?.()?.maxContextTokens;

    if (typeof contextStats?.currentTokens === 'number') {
      tokens += contextStats.currentTokens;
    }

    if (typeof contextStats?.maxTokens === 'number') {
      maxTokens += contextStats.maxTokens;
    } else if (typeof configuredMaxTokens === 'number') {
      maxTokens += configuredMaxTokens;
    }

    if (typeof workingMemory?.getSlotCount === 'function') {
      slotCount += Number(workingMemory.getSlotCount() ?? 0);
    }
    if (typeof workingMemory?.getCapacity === 'function') {
      slotCapacity += Number(workingMemory.getCapacity() ?? 0);
    }

    if (typeof contextStats?.summaryChainNodes === 'number') {
      summaryChainNodes += contextStats.summaryChainNodes;
    }
    if (typeof contextStats?.compactedMessageCount === 'number') {
      compactedMessages += contextStats.compactedMessageCount;
    }
    if (typeof contextStats?.strategy === 'string' && contextStats.strategy.trim()) {
      strategies.add(contextStats.strategy.trim());
    }

    const transparencyReport = manager.getContextTransparencyReport?.();
    if (typeof transparencyReport === 'string' && transparencyReport.trim()) {
      transparencyReports.push(transparencyReport.trim());
    }
  }

  const resolvedTokens = tokens > 0 ? tokens : conversationStats.totalTokenEstimate;
  const resolvedMaxTokens = maxTokens > 0 ? maxTokens : 8192;
  return {
    tokens: resolvedTokens,
    maxTokens: resolvedMaxTokens,
    slotCount: slotCapacity > 0 || slotCount > 0 ? slotCount : undefined,
    slotCapacity: slotCapacity > 0 ? slotCapacity : undefined,
    slotUtilization: slotCapacity > 0 ? slotCount / slotCapacity : undefined,
    summaryChainNodes: summaryChainNodes > 0 ? summaryChainNodes : undefined,
    compactedMessages: compactedMessages > 0 ? compactedMessages : undefined,
    strategy: strategies.size > 0 ? Array.from(strategies).join(', ') : undefined,
    transparencyReport:
      transparencyReports.length > 0 ? transparencyReports.join('\n\n') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Registers all `/api/agentos/memory` routes on the provided Fastify instance.
 *
 * Each route first attempts to extract live data from the running AgentOS
 * ConversationManager.  If the runtime is unavailable or the internal memory
 * subsystem is not reachable, the route falls back to mock demonstration data.
 *
 * Object responses include a `mode` field and all responses include an
 * `X-AgentOS-Workbench-Mode` header so the frontend can distinguish runtime
 * data from demo fallbacks without guessing from payload shape alone.
 *
 * Routes:
 *  - `GET    /memory/stats`         — aggregate counts + working memory token usage.
 *  - `GET    /memory/timeline`      — chronological operation feed, filterable by `since` ms.
 *  - `GET    /memory/entries`       — full memory store; optionally filtered by `type`.
 *  - `GET    /memory/working`       — working memory snapshot only.
 *  - `DELETE /memory/entries/:id`   — remove a long-term memory entry by id.
 *
 * @param fastify The Fastify instance passed by `fastify.register`.
 */
export default async function memoryRoutes(
  fastify: FastifyInstance,
  options: MemoryRoutesOptions = {},
): Promise<void> {
  const getRuntimeMemory = options.runtimeGetter ?? tryGetRuntimeMemory;
  /**
   * Aggregate memory statistics.
   * Returns entry counts for each long-term tier plus current working memory
   * token consumption — suitable for the Overview card summary row.
   *
   * Attempts to read from the live AgentOS ConversationManager first;
   * falls back to mock data if the runtime is unavailable.
   */
  fastify.get(
    '/memory/stats',
    {
      schema: {
        description: 'Aggregate memory statistics across all tiers',
        tags: ['Memory'],
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['runtime', 'demo'] },
              connected: { type: 'boolean' },
              episodic: {
                type: 'object',
                properties: { count: { type: 'number' }, newest: { type: 'number' } },
              },
              semantic: { type: 'object', properties: { count: { type: 'number' } } },
              procedural: { type: 'object', properties: { count: { type: 'number' } } },
              working: {
                type: 'object',
                properties: { tokens: { type: 'number' }, maxTokens: { type: 'number' } },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
    const runtime = await getRuntimeMemory();
      if (runtime) {
        try {
          return withMemoryMode(reply, 'runtime', buildRealMemoryStats(runtime));
        } catch {
          // Fall through to mock data
        }
      }
      return withMemoryMode(reply, 'demo', {
        connected: false,
        episodic: {
          count: mockMemoryEntries.episodic.length,
          newest: mockMemoryEntries.episodic[0]?.timestamp,
        },
        semantic: { count: mockMemoryEntries.semantic.length },
        procedural: { count: mockMemoryEntries.procedural.length },
        working: {
          tokens: mockMemoryEntries.working.tokens,
          maxTokens: mockMemoryEntries.working.maxTokens,
        },
      });
    }
  );

  /**
   * Memory operation timeline.
   *
   * Attempts to derive timeline events from live conversation history first;
   * falls back to mock timeline data if the runtime is unavailable.
   *
   * @param req.query.since - Optional Unix ms lower bound; only entries after this timestamp are returned.
   * @returns Array of {@link TimelineEntry} objects in chronological order.
   */
  fastify.get<{ Querystring: { since?: string } }>(
    '/memory/timeline',
    {
      schema: {
        description:
          'Chronological log of memory operations, optionally filtered by `since` timestamp (ms)',
        tags: ['Memory'],
        querystring: {
          type: 'object',
          properties: { since: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { since } = req.query;
      const sinceTs = since ? parseInt(since, 10) : 0;

    const runtime = await getRuntimeMemory();
      if (runtime) {
        try {
          const entries = buildRealTimeline(runtime, sinceTs);
          return withMemoryMode(reply, 'runtime', { connected: true, timeline: entries });
        } catch {
          // Fall through to mock data
        }
      }
      return withMemoryMode(reply, 'demo', {
        connected: false,
        timeline: mockTimeline.filter((e) => e.timestamp > sinceTs),
      });
    }
  );

  /**
   * Retrieve memory entries.
   *
   * Attempts to build entries from live conversation contexts first;
   * falls back to mock entries if the runtime is unavailable.
   *
   * @param req.query.type - Optional category filter: 'episodic' | 'semantic' | 'procedural' | 'working'.
   *                         Omit to return the full store.
   * @returns The requested category array, the working memory object, or the full store.
   */
  fastify.get<{ Querystring: { type?: string } }>(
    '/memory/entries',
    {
      schema: {
        description: 'Retrieve memory entries, optionally filtered to a single category via `type`',
        tags: ['Memory'],
        querystring: {
          type: 'object',
          properties: { type: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { type } = req.query;

    const runtime = await getRuntimeMemory();
      if (runtime) {
        try {
          if (type === 'working') {
            return withMemoryMode(reply, 'runtime', buildRealWorkingMemory(runtime));
          }
          const entries = buildRealEntries(runtime) as Record<string, unknown>;
          if (type && type in entries) {
            const scoped = entries[type];
            if (scoped && typeof scoped === 'object' && !Array.isArray(scoped)) {
              return withMemoryMode(reply, 'runtime', scoped as Record<string, unknown>);
            }
            reply.header(WORKBENCH_MEMORY_MODE_HEADER, 'runtime');
            return scoped;
          }
          return withMemoryMode(reply, 'runtime', entries);
        } catch {
          // Fall through to mock data
        }
      }

      if (type === 'working') {
        return withMemoryMode(reply, 'demo', { connected: false, ...mockMemoryEntries.working });
      }
      if (type && type in mockMemoryEntries) {
        const scoped = (mockMemoryEntries as unknown as Record<string, unknown>)[type];
        if (scoped && typeof scoped === 'object' && !Array.isArray(scoped)) {
          return withMemoryMode(reply, 'demo', scoped as Record<string, unknown>);
        }
        reply.header(WORKBENCH_MEMORY_MODE_HEADER, 'demo');
        return scoped;
      }
      return withMemoryMode(reply, 'demo', { connected: false, ...mockMemoryEntries });
    }
  );

  /**
   * Working memory snapshot.
   *
   * Attempts to build working memory stats from the live ConversationManager;
   * falls back to mock data if the runtime is unavailable.
   */
  fastify.get(
    '/memory/working',
    {
      schema: {
        description: 'Current working (context-window) memory snapshot',
        tags: ['Memory'],
      },
    },
    async (_req, reply) => {
    const runtime = await getRuntimeMemory();
      if (runtime) {
        try {
          return withMemoryMode(reply, 'runtime', buildRealWorkingMemory(runtime));
        } catch {
          // Fall through to mock data
        }
      }
      return withMemoryMode(reply, 'demo', { connected: false, ...mockMemoryEntries.working });
    }
  );

  /**
   * Delete a long-term memory entry by id.
   *
   * When the live cognitive-memory runtime is available, this soft-deletes the
   * trace from the active memory store. Otherwise it falls back to the mock data.
   *
   * @param req.params.id - The entry id to remove.
   * @returns `{ ok: true }` on success.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/memory/entries/:id',
    {
      schema: {
        description: 'Delete a long-term memory entry by id',
        tags: ['Memory'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['runtime', 'demo'] },
              ok: { type: 'boolean' },
            },
          },
          404: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['runtime', 'demo'] },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
    const result = await deleteMemoryEntryById(id, await getRuntimeMemory());
      if (result.ok) {
        return withMemoryMode(reply, result.mode, { ok: true });
      }
      return reply.code(404).send(withMemoryMode(reply, result.mode, { error: result.error }));
    }
  );
}
