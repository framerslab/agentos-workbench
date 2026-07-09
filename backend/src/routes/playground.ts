/**
 * @file playground.ts
 * @description Backend routes for the AgentPlayground and PromptWorkspace panels.
 *
 * Routes:
 *   POST /api/playground/run     — Run a single agent config + prompt, stream SSE response.
 *   POST /api/playground/compare — Run the same prompt against two configs, return both results.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAgentOS } from '../lib/agentos';
import { resolveTools, listAvailableToolNames } from '../services/toolCatalog';
import { streamText as agentosStreamText, generateText as agentosGenerateText } from '@framers/agentos';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlaygroundConfig {
  /** System instructions for the agent. */
  systemPrompt?: string;
  /** LLM model id, e.g. 'gpt-4o-mini'. */
  model?: string;
  /** Sampling temperature 0–2. */
  temperature?: number;
  /** Hard token limit for the response. */
  maxTokens?: number;
  /** Max tool-call steps before halting. */
  maxSteps?: number;
  /** Guardrail security tier. */
  guardrailTier?: 'dangerous' | 'permissive' | 'balanced' | 'strict' | 'paranoid';
  /** List of tool names to enable. */
  tools?: string[];
}

interface RunRequestBody {
  /** The user's prompt. */
  prompt: string;
  /** Full conversation history (role + content pairs). When provided, used instead of prompt. */
  messages?: { role: string; content: string }[];
  /** Agent configuration. */
  config?: PlaygroundConfig;
  /** Session identifier for tracing. */
  sessionId?: string;
}

interface CompareRequestBody {
  /** The user's prompt (same for both sides). */
  prompt: string;
  /** Left-side (A) configuration. */
  configA: PlaygroundConfig;
  /** Right-side (B) configuration. */
  configB: PlaygroundConfig;
}

interface CompareResult {
  text: string;
  toolCalls: ToolCallEntry[];
  usage: UsageInfo;
  latencyMs: number;
  runtimeMode: PlaygroundRuntimeMode;
  error?: string;
}

interface ToolCallEntry {
  name: string;
  args: unknown;
  result: unknown;
}

interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export type PlaygroundRuntimeMode = 'live' | 'stub';
type PlaygroundRuntimeMethodName = 'streamText' | 'generateText';

type PlaygroundRuntimeModule = {
  streamText: (opts: Record<string, unknown>) => {
    fullStream: AsyncIterable<Record<string, unknown>>;
    usage?: Promise<Record<string, unknown>>;
  };
  generateText: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a runtime object from the statically-imported @framers/agentos SDK
 * functions. This avoids the dynamic-import-via-new-Function trick which
 * breaks under ts-node ("A dynamic import callback was not specified").
 */
function getStaticRuntime(): PlaygroundRuntimeModule {
  return {
    streamText: agentosStreamText as unknown as PlaygroundRuntimeModule['streamText'],
    generateText: agentosGenerateText as unknown as PlaygroundRuntimeModule['generateText'],
  };
}

/** Estimate USD cost given token counts and a model id. */
function estimateCost(
  promptTokens: number,
  completionTokens: number,
  model?: string
): number {
  const INPUT_RATES: Record<string, number> = {
    'gpt-4o': 0.0025,
    'gpt-4o-mini': 0.00015,
    'gpt-4-turbo': 0.01,
    'claude-3-5-sonnet': 0.003,
    'claude-3-haiku': 0.00025,
    'claude-sonnet-4': 0.003,
  };
  const OUTPUT_RATES: Record<string, number> = {
    'gpt-4o': 0.01,
    'gpt-4o-mini': 0.0006,
    'gpt-4-turbo': 0.03,
    'claude-3-5-sonnet': 0.015,
    'claude-3-haiku': 0.00125,
    'claude-sonnet-4': 0.015,
  };
  const key = Object.keys(INPUT_RATES).find((k) => model?.includes(k)) ?? '';
  const inputRate = INPUT_RATES[key] ?? 0.0005;
  const outputRate = OUTPUT_RATES[key] ?? 0.0015;
  return (promptTokens / 1000) * inputRate + (completionTokens / 1000) * outputRate;
}

/** Build a stub response for when AgentOS is not available. */
function buildStubResponse(prompt: string, config: PlaygroundConfig) {
  const model = config.model ?? 'gpt-4o-mini';
  const sys = config.systemPrompt ?? '(no system prompt)';
  const promptTokens = Math.ceil((sys.length + prompt.length) / 4);
  const completionTokens = 64;
  return {
    text: `[Playground stub — connect AgentOS for live responses]\n\nModel: ${model}\nSystem: ${sys.slice(0, 80)}…\nPrompt: ${prompt}`,
    toolCalls: [] as ToolCallEntry[],
    runtimeMode: 'stub' as const,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: estimateCost(promptTokens, completionTokens, model),
    } satisfies UsageInfo,
  };
}

/**
 * Resolve the playground runtime, preferring module-level exports.
 *
 * Contract (exercised by tests/playgroundRoutes.test.ts):
 * 1. `loadModule` is consulted first — when it yields a runtime whose
 *    top-level exports include a callable `generateText` or `streamText`,
 *    that runtime wins and the legacy `loadRuntime` getter is never invoked.
 * 2. Otherwise the legacy `loadRuntime` getter is awaited and its result
 *    returned as-is.
 * 3. Any loader failure resolves to null so callers fall back to the stub.
 */
export async function resolvePlaygroundRuntime(
  loadRuntime: () => Promise<unknown>,
  loadModule: () => Promise<unknown>,
): Promise<PlaygroundRuntimeModule | null> {
  try {
    const moduleRuntime = (await loadModule()) as PlaygroundRuntimeModule | null;
    if (
      moduleRuntime &&
      (typeof moduleRuntime.generateText === 'function' ||
        typeof moduleRuntime.streamText === 'function')
    ) {
      return moduleRuntime;
    }
    return ((await loadRuntime()) as PlaygroundRuntimeModule | null) ?? null;
  } catch {
    return null;
  }
}

/** Return the static @framers/agentos runtime (streamText / generateText). */
async function resolveAgentOS(): Promise<PlaygroundRuntimeModule | null> {
  return resolvePlaygroundRuntime(
    // No legacy runtime getter in the static-import world — the module
    // exports below are the only source.
    async () => null,
    async () => getStaticRuntime(),
  );
}

async function collectPlaygroundResult(
  iterator: AsyncIterable<Record<string, unknown>>,
  config: PlaygroundConfig,
  runtimeMode: PlaygroundRuntimeMode,
  startMs: number
): Promise<CompareResult> {
  let fullText = '';
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of iterator) {
    const chunkType = String(chunk.type ?? '');
    if (chunkType === 'text_delta' && chunk.textDelta) {
      fullText += String(chunk.textDelta);
    } else if (chunkType === 'final_response') {
      const finalText = chunk.finalResponseText ?? chunk.finalResponseTextPlain ?? '';
      if (finalText) {
        fullText += String(finalText);
      }
    } else if (chunkType === 'usage') {
      promptTokens = Number(chunk.promptTokens ?? 0);
      completionTokens = Number(chunk.completionTokens ?? 0);
    } else if (chunkType === 'error') {
      throw new Error(String(chunk.message ?? chunk.error ?? 'Unknown error'));
    }
  }

  return {
    text: fullText,
    toolCalls: [],
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: estimateCost(promptTokens, completionTokens, config.model),
    },
    latencyMs: Date.now() - startMs,
    runtimeMode,
  };
}

export function getPlaygroundRuntimeMode(
  runtime: PlaygroundRuntimeModule | null,
  methodName: PlaygroundRuntimeMethodName
): PlaygroundRuntimeMode {
  return runtime && typeof runtime[methodName] === 'function' ? 'live' : 'stub';
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default async function playgroundRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/playground/tools
   *
   * Returns the list of all available tool names (built-in + forged).
   * The frontend uses this to populate the tool checkbox list dynamically.
   */
  fastify.get(
    '/tools',
    {
      schema: {
        description: 'List all available tool names for the playground',
        tags: ['Playground'],
        response: {
          200: {
            type: 'object',
            properties: {
              tools: { type: 'array', items: { type: 'string' } },
            },
            required: ['tools'],
          },
        },
      },
    },
    async () => ({ tools: listAvailableToolNames() }),
  );

  /**
   * POST /api/playground/run
   *
   * Accepts a config + prompt and streams an SSE response with text chunks,
   * tool call events, and a final `done` event carrying usage stats.
   */
  fastify.post<{ Body: RunRequestBody }>(
    '/run',
    {
      schema: {
        description: 'Run an agent config against a prompt and stream the response via SSE',
        tags: ['Playground'],
        body: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  content: { type: 'string' },
                },
              },
            },
            config: { type: 'object', additionalProperties: true },
            sessionId: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: RunRequestBody }>, reply: FastifyReply) => {
      const { prompt, messages, config = {}, sessionId } = request.body;
      const startMs = Date.now();
      const agentos = await resolveAgentOS();
      const runtimeMode = getPlaygroundRuntimeMode(agentos, 'streamText');

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.setHeader('X-AgentOS-Playground-Mode', runtimeMode);
      reply.raw.flushHeaders();

      function send(event: string, data: unknown) {
        reply.raw.write(`data: ${JSON.stringify({ type: event, ...( typeof data === 'object' && data ? data : { data }) })}\n\n`);
      }

      try {
        if (runtimeMode === 'live') {
          const streamFn = agentos!.streamText;

          const systemPrompt = config.systemPrompt ?? 'You are a helpful AI assistant.';
          const toolCalls: ToolCallEntry[] = [];

          // Resolve tool name strings to executable tool definitions.
          const tools = config.tools?.length
            ? resolveTools(config.tools, { includeAllForged: true })
            : undefined;

          const streamResult = streamFn({
            model: config.model ?? 'gpt-4o-mini',
            system: systemPrompt,
            ...(messages?.length
              ? { messages: messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })) }
              : { prompt }),
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            maxSteps: config.maxSteps ?? 5,
            tools,
          });

          for await (const chunk of streamResult.fullStream) {
            const chunkType = chunk.type as string;
            if (chunkType === 'text') {
              send('text_delta', { text: chunk.text });
            } else if (chunkType === 'tool-call') {
              const entry: ToolCallEntry = {
                name: String(chunk.toolName ?? ''),
                args: chunk.args,
                result: undefined,
              };
              toolCalls.push(entry);
              send('tool_call', entry);
            } else if (chunkType === 'tool-result') {
              const entry: ToolCallEntry = {
                name: String(chunk.toolName ?? ''),
                args: undefined,
                result: chunk.result,
              };
              toolCalls.push(entry);
            }
          }

          const usageObj = (await streamResult.usage) ?? {};
          const promptTokens = Number(usageObj.promptTokens ?? 0);
          const completionTokens = Number(usageObj.completionTokens ?? 0);

          const latencyMs = Date.now() - startMs;
          const usage: UsageInfo = {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            estimatedCostUsd: estimateCost(promptTokens, completionTokens, config.model),
          };
          send('done', { toolCalls, usage, latencyMs, sessionId, runtimeMode });
        } else {
          // AgentOS not available — emit stub chunks
          const stub = buildStubResponse(prompt, config);
          // Simulate streaming character by character in chunks
          const words = stub.text.split(' ');
          for (const word of words) {
            send('text_delta', { text: word + ' ' });
            await new Promise((r) => setTimeout(r, 5));
          }
          const latencyMs = Date.now() - startMs;
          send('done', {
            toolCalls: stub.toolCalls,
            usage: stub.usage,
            latencyMs,
            sessionId,
            runtimeMode: stub.runtimeMode,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send('error', { message, runtimeMode });
      } finally {
        reply.raw.end();
      }
    }
  );

  /**
   * POST /api/playground/compare
   *
   * Runs the same prompt against two different configs and returns both
   * results in a single JSON response (no streaming).
   */
  fastify.post<{ Body: CompareRequestBody }>(
    '/compare',
    {
      schema: {
        description: 'Run the same prompt against two agent configs and return both results',
        tags: ['Playground'],
        body: {
          type: 'object',
          required: ['prompt', 'configA', 'configB'],
          properties: {
            prompt: { type: 'string' },
            configA: { type: 'object', additionalProperties: true },
            configB: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CompareRequestBody }>, reply: FastifyReply) => {
      const { prompt, configA, configB } = request.body;
      const agentos = await resolveAgentOS();
      const runtimeMode = getPlaygroundRuntimeMode(agentos, 'generateText');
      reply.header('X-AgentOS-Playground-Mode', runtimeMode);

      async function runConfig(config: PlaygroundConfig): Promise<CompareResult> {
        const startMs = Date.now();
        try {
          if (runtimeMode === 'live') {
            const genFn = agentos!.generateText;
            const compareTools = config.tools?.length
              ? resolveTools(config.tools, { includeAllForged: true })
              : undefined;
            const result = await genFn({
              model: config.model ?? 'gpt-4o-mini',
              system: config.systemPrompt ?? 'You are a helpful AI assistant.',
              prompt,
              temperature: config.temperature,
              maxTokens: config.maxTokens,
              tools: compareTools,
            });
            const text = String(result.text ?? '');
            const usageObj = (result.usage ?? {}) as Record<string, unknown>;
            const promptTokens = Number(usageObj.promptTokens ?? 0);
            const completionTokens = Number(usageObj.completionTokens ?? 0);
            return {
              text,
              toolCalls: [],
              usage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
                estimatedCostUsd: estimateCost(promptTokens, completionTokens, config.model),
              },
              latencyMs: Date.now() - startMs,
              runtimeMode,
            };
          }
          // Stub path
          const stub = buildStubResponse(prompt, config);
          return { ...stub, latencyMs: Date.now() - startMs };
        } catch (err: unknown) {
          return {
            text: '',
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
            latencyMs: Date.now() - startMs,
            runtimeMode,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const [resultA, resultB] = await Promise.all([runConfig(configA), runConfig(configB)]);
      return reply.send({ resultA, resultB });
    }
  );
}
