/**
 * @file forge.ts
 * @description Emergent tool forge backend endpoints.
 *
 * Routes:
 *   `POST /api/agency/forge`
 *     Body:     `{ description: string, parametersSchema?: string }`
 *     Response: `{ requestId, status, verdict: JudgeVerdict, tool: ForgedTool | null }`
 *     Generates a stub implementation, judges it (correctness/safety/efficiency),
 *     and registers the tool in the Session tier if approved.
 *
 *   `GET /api/agency/forged-tools`
 *     Response: `{ tools: SerializedForgedTool[] }`
 *     Lists all in-memory forged tools with computed avgLatencyMs and successRate.
 *
 *   `POST /api/agency/forged-tools/:id/run`
 *     Body:     arbitrary JSON input
 *     Response: tool execution result (200) or error (404/500).
 *     Evaluates the tool's stub implementation via `new Function()`.
 *     Tracks callCount, successCount, and totalLatencyMs for usage stats.
 *
 * Judge scoring heuristic (dev stub):
 *   - correctness: 50 + (wordCount * 2), capped at 100.
 *   - safety: fixed 95 %.
 *   - efficiency: 60 + wordCount, capped at 100.
 *   - Approval threshold: correctness >= 60 AND safety >= 80.
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import {
  registerForgedTool,
  listForgedTools,
  recordForgedToolUse,
  type PersistedForgedTool,
} from '../services/toolCatalog';

// ---------------------------------------------------------------------------
// Forged tool registry — backed by persistent JSON file via toolCatalog
// ---------------------------------------------------------------------------

type ForgedTool = PersistedForgedTool;

interface JudgeVerdict {
  requestId: string;
  toolId: string;
  toolName: string;
  status: 'approved' | 'rejected';
  scores: {
    correctness: number;
    safety: number;
    efficiency: number;
  };
  reasoning: string;
  verdictAt: number;
}

type ForgeWorkbenchMode = 'demo';

export const WORKBENCH_FORGE_MODE_HEADER = 'X-AgentOS-Workbench-Mode';

function markForgeReply(reply: FastifyReply, mode: ForgeWorkbenchMode = 'demo'): void {
  reply.header(WORKBENCH_FORGE_MODE_HEADER, mode);
}

// toolRegistry is now backed by the persistent toolCatalog service.
// Use listForgedTools() to read and registerForgedTool() to write.

function generateId(): string {
  return `forge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isCoinGeckoPriceTool(description: string): boolean {
  const normalized = description.toLowerCase();
  return normalized.includes('coingecko') && normalized.includes('price');
}

function inferDefaultCoinId(description: string): string {
  const normalized = description.toLowerCase();
  if (normalized.includes('btc') || normalized.includes('bitcoin')) return 'bitcoin';
  if (normalized.includes('eth') || normalized.includes('ethereum')) return 'ethereum';
  if (normalized.includes('sol') || normalized.includes('solana')) return 'solana';
  return 'bitcoin';
}

function inferForgedToolName(description: string): string {
  if (isCoinGeckoPriceTool(description)) {
    const coinId = inferDefaultCoinId(description);
    if (coinId === 'bitcoin') return 'btc_price_retriever';
    if (coinId === 'ethereum') return 'eth_price_retriever';
    if (coinId === 'solana') return 'sol_price_retriever';
    return `${coinId}_price_retriever`;
  }

  return description
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'forged_tool';
}

/**
 * Encode text as a JavaScript string literal for generated code.
 *
 * `JSON.stringify` escapes quotes, backslashes and line breaks, so the text
 * stays one string value in the code and never ends a comment or a string.
 */
function codeLiteral(text: string): string {
  return JSON.stringify(text);
}

/**
 * Stub implementation generator.
 *
 * In production this would call the LLM to synthesise a real implementation.
 * The stub always returns a descriptive echo that lets the UI exercise all flows.
 * Request text enters the code only through `codeLiteral`, as string data.
 *
 * @param description - Natural-language description of the desired tool.
 * @param parametersSchema - Optional JSON Schema string for tool parameters.
 * @returns A JS function body string that can be evaluated via `new Function()`.
 */
function generateImplementation(description: string, parametersSchema: string): string {
  if (isCoinGeckoPriceTool(description)) {
    const defaultCoinId = inferDefaultCoinId(description);
    return `
// Generated demo CoinGecko price tool.
const toolDescription = ${codeLiteral(description)};
async function run(params) {
  const symbolToId = {
    btc: 'bitcoin',
    bitcoin: 'bitcoin',
    eth: 'ethereum',
    ethereum: 'ethereum',
    sol: 'solana',
    solana: 'solana',
  };

  const requested = typeof params?.coin === 'string'
    ? params.coin
    : typeof params?.symbol === 'string'
      ? params.symbol
      : typeof params?.asset === 'string'
        ? params.asset
        : ${codeLiteral(defaultCoinId)};

  const normalized = String(requested).trim().toLowerCase();
  const coinId = symbolToId[normalized] || normalized || ${codeLiteral(defaultCoinId)};
  const vsCurrency = typeof params?.vs_currency === 'string' && params.vs_currency.trim()
    ? params.vs_currency.trim().toLowerCase()
    : 'usd';
  const demoPrices = {
    bitcoin: { usd: 67245.13, eur: 61890.42 },
    ethereum: { usd: 3248.77, eur: 2989.14 },
    solana: { usd: 142.58, eur: 131.92 },
  };
  const fallbackPrice = { usd: 100, eur: 92 };
  const coinPrices = demoPrices[coinId] || fallbackPrice;
  const price = coinPrices[vsCurrency] || coinPrices.usd || 100;

  return {
    ok: true,
    coinId,
    vsCurrency,
    price,
    source: 'demo-coingecko',
    asOf: '2026-04-08T00:00:00Z',
  };
}
`.trim();
  }

  return `
// Generated stub.
const toolDescription = ${codeLiteral(description)};
const toolParametersSchema = ${codeLiteral(parametersSchema || '(none)')};
async function run(params) {
  return { ok: true, result: \`Tool executed with params: \${JSON.stringify(params)}\` };
}
`.trim();
}

/**
 * Evaluate the stub for safety and completeness, returning a synthetic score.
 *
 * A real judge would invoke an LLM or a static analysis pass.  This dev stub
 * uses description word count as a proxy for implementation quality.
 *
 * @param description - The tool description to score.
 * @returns A {@link JudgeVerdict} with synthetic scores (requestId left blank for caller).
 */
function judgeImplementation(description: string): JudgeVerdict & { toolId: string } {
  const toolId = generateId();
  // Score heuristic: description length proxy for quality
  const descWords = description.trim().split(/\s+/).length;
  const correctness = Math.min(100, 50 + descWords * 2);
  const safety = 95;
  const efficiency = Math.min(100, 60 + descWords);
  const approved = correctness >= 60 && safety >= 80;

  return {
    requestId: '', // filled by caller
    toolId,
    toolName: inferForgedToolName(description),
    status: approved ? 'approved' : 'rejected',
    scores: { correctness, safety, efficiency },
    reasoning: approved
      ? `Stub implementation passed correctness (${correctness}%), safety (${safety}%), and efficiency (${efficiency}%) thresholds.`
      : `Implementation scored below the 60% correctness threshold (got ${correctness}%). Refine the description and resubmit.`,
    verdictAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default async function forgeRoutes(fastify: FastifyInstance): Promise<void> {
  /** Submit a forge request and receive a verdict + forged tool. */
  fastify.post<{
    Body: { description: string; parametersSchema?: string };
  }>(
    '/forge',
    {
      schema: {
        description: 'Submit a tool forge request',
        tags: ['Forge'],
        body: {
          type: 'object',
          required: ['description'],
          properties: {
            description: { type: 'string' },
            parametersSchema: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              requestId: { type: 'string' },
              status: { type: 'string' },
              verdict: { type: 'object', additionalProperties: true },
              tool: {
                anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
              },
            },
            required: ['mode', 'requestId', 'status', 'verdict', 'tool'],
          },
        },
      },
    },
    async (req, reply) => {
      const { description, parametersSchema = '' } = req.body;
      const requestId = generateId();

      const judgeResult = judgeImplementation(description);
      judgeResult.requestId = requestId;

      if (judgeResult.status === 'rejected') {
        markForgeReply(reply);
        return reply.code(200).send({
          mode: 'demo',
          requestId,
          status: 'rejected',
          verdict: judgeResult,
          tool: null,
        });
      }

      const impl = generateImplementation(description, parametersSchema);
      const tool: ForgedTool = {
        id: judgeResult.toolId,
        name: judgeResult.toolName,
        description,
        implementation: impl,
        tier: 'session',
        callCount: 0,
        successCount: 0,
        totalLatencyMs: 0,
        createdAt: Date.now(),
      };
      registerForgedTool(tool);

      markForgeReply(reply);
      return reply.code(200).send({
        mode: 'demo',
        requestId,
        status: 'approved',
        verdict: judgeResult,
        tool: serializeTool(tool),
      });
    }
  );

  /** List all forged tools. */
  fastify.get(
    '/forged-tools',
    {
      schema: {
        description: 'List all forged tools',
        tags: ['Forge'],
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              tools: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
              },
            },
            required: ['mode', 'tools'],
          },
        },
      },
    },
    async (_req, reply) => {
      markForgeReply(reply);
      return {
        mode: 'demo' as const,
        tools: listForgedTools().map(serializeTool),
      };
    }
  );

  /** Run a forged tool with arbitrary JSON input. */
  fastify.post<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>(
    '/forged-tools/:id/run',
    {
      schema: {
        description: 'Run a forged tool with test input',
        tags: ['Forge'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: { type: 'object', additionalProperties: true },
        response: {
          200: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              ok: { type: 'boolean' },
              result: {},
            },
            required: ['mode', 'ok', 'result'],
          },
          404: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['mode', 'error'],
          },
          500: {
            type: 'object',
            properties: {
              mode: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['mode', 'error'],
          },
        },
      },
    },
    async (req, reply) => {
      const tool = listForgedTools().find((t) => t.id === req.params.id);
      if (!tool) {
        markForgeReply(reply);
        return reply.code(404).send({ mode: 'demo', error: 'Tool not found' });
      }

      const startMs = Date.now();

      // Evaluate the stub implementation safely
      let result: unknown;
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('params', `${tool.implementation}\nreturn run(params);`);
        result = await Promise.resolve(fn(req.body));
        recordForgedToolUse(tool.id, true, Date.now() - startMs);
      } catch (err) {
        recordForgedToolUse(tool.id, false, Date.now() - startMs);
        markForgeReply(reply);
        return reply.code(500).send({
          mode: 'demo',
          error: err instanceof Error ? err.message : 'Tool execution failed',
        });
      }

      markForgeReply(reply);
      return reply.code(200).send({
        mode: 'demo',
        ok: true,
        result,
      });
    }
  );
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise a {@link ForgedTool} for the API response, computing derived
 * fields (avgLatencyMs, successRate) from raw counters.
 */
function serializeTool(tool: ForgedTool) {
  const avgLatencyMs = tool.callCount > 0 ? Math.round(tool.totalLatencyMs / tool.callCount) : 0;
  const successRate =
    tool.callCount > 0 ? Math.round((tool.successCount / tool.callCount) * 100) : 100;
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
    callCount: tool.callCount,
    successRate,
    avgLatencyMs,
    createdAt: tool.createdAt,
  };
}
