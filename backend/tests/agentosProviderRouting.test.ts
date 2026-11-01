import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { buildWorkbenchProcessRequestInput } from '../src/routes/agentos';

// A playground turn's provider as the installed @framers/agentos routes it. A turn that names a
// model carries `options.preferredProviderId` (buildWorkbenchProcessRequestInput: the turn's
// providerId, else the provider the model's prefix names); a turn without one sends no options
// and keeps the persona's provider. agentos 0.15.71 (framerslab/agentos#680) puts it ahead of the persona's and the config's default
// provider. Each case boots the real runtime with OpenAI and Anthropic configured and answers
// their HTTP calls from a stubbed fetch, so the GMI, the provider manager and both providers run
// as published and only the network is replaced.

type AgentOSModule = typeof import('@framers/agentos');
type AgentOSInstance = Awaited<ReturnType<AgentOSModule['AgentOS']['create']>>;

// The backend is CommonJS and agentos is an ES module: load it the way src/lib/agentos.ts does.
const runtimeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<AgentOSModule>;

const onOpenAI = {
  id: 'on-openai',
  name: 'On OpenAI',
  description: 'A persona whose default provider is OpenAI.',
  version: '1.0.0',
  baseSystemPrompt: 'You are terse.',
  defaultProviderId: 'openai',
  defaultModelId: 'gpt-4o-mini',
};
const onAnthropic = {
  id: 'on-anthropic',
  name: 'On Anthropic',
  description: 'A persona whose default provider is Anthropic.',
  version: '1.0.0',
  baseSystemPrompt: 'You are terse.',
  defaultProviderId: 'anthropic',
  defaultModelId: 'claude-sonnet-4-0',
};

/** A model call that reached a provider's API: which provider, the model, and whether it streamed. */
interface ModelCall {
  provider: 'openai' | 'anthropic';
  model: string;
  streamed: boolean;
}

const REPLY_TEXT = { openai: 'From OpenAI.', anthropic: 'From Anthropic.' } as const;

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const body = events
    .map(({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function openAiReply(model: string, streamed: boolean): Response {
  const text = REPLY_TEXT.openai;
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
  if (!streamed) {
    return json({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    });
  }
  const chunk = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model };
  return sse([
    { data: { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] } },
    { data: { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    { data: { ...chunk, choices: [], usage } },
    { data: '[DONE]' },
  ]);
}

function anthropicReply(model: string, streamed: boolean): Response {
  const text = REPLY_TEXT.anthropic;
  if (!streamed) {
    return json({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  }
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg_stub', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function requestUrl(input: unknown): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input instanceof Request) return new URL(input.url);
  } catch {
    return null;
  }
  return null;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const realFetch = globalThis.fetch;
let calls: ModelCall[] = [];
let agentos: AgentOSInstance | undefined;
let keySerial = 0;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = requestUrl(input);
    const body = requestBody(init);
    const model = typeof body.model === 'string' ? body.model : '';
    const streamed = body.stream === true;
    if (url?.hostname === 'api.openai.com') {
      if (url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/responses')) {
        calls.push({ provider: 'openai', model, streamed });
        return openAiReply(model, streamed);
      }
      if (url.pathname.endsWith('/models')) {
        return json({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }, { id: 'gpt-4o', object: 'model' }] });
      }
    }
    if (url?.hostname === 'api.anthropic.com') {
      if (url.pathname.endsWith('/v1/messages')) {
        calls.push({ provider: 'anthropic', model, streamed });
        return anthropicReply(model, streamed);
      }
      if (url.pathname.includes('/v1/models')) {
        return json({ data: [{ id: 'claude-sonnet-4-0', type: 'model' }], has_more: false });
      }
    }
    // Nothing else may leave the test: an unexpected call is answered, not sent.
    return json({ error: { message: `stubbed fetch: no route for ${url?.href ?? String(input)}` } }, 404);
  }) as typeof fetch;
});

afterEach(async () => {
  if (agentos) await agentos.shutdown();
  agentos = undefined;
  globalThis.fetch = realFetch;
});

async function boot(): Promise<AgentOSInstance> {
  const { AgentOS } = await runtimeImport('@framers/agentos');
  keySerial += 1;
  agentos = await AgentOS.create({
    modelProviderManagerConfig: {
      providers: [
        { providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: `sk-openai-routing-${keySerial}` } },
        { providerId: 'anthropic', enabled: true, config: { apiKey: `sk-ant-routing-${keySerial}` } },
      ],
    },
    turnPlanning: { enabled: false },
    personas: [onOpenAI, onAnthropic],
  } as never);
  return agentos;
}

async function turn(runtime: AgentOSInstance, input: Parameters<typeof buildWorkbenchProcessRequestInput>[0]) {
  let text: string | null | undefined;
  const errors: unknown[] = [];
  const request = buildWorkbenchProcessRequestInput({ userId: 'workbench-user', textInput: 'Hello?', ...input });
  for await (const chunk of runtime.processRequest(request as never)) {
    const record = chunk as { type?: string; finalResponseText?: string | null };
    if (record.type === 'final_response') text = record.finalResponseText;
    if (record.type === 'error') errors.push(chunk);
  }
  return { text, errors };
}

/** The streamed model calls: every GMI turn streams its model call. */
const served = () => calls.filter((call) => call.streamed).map(({ provider, model }) => `${provider}:${model}`);

test("a Claude model picked in the playground goes to Anthropic, over the persona's OpenAI default", async () => {
  const runtime = await boot();

  const result = await turn(runtime, { sessionId: 's-claude', selectedPersonaId: 'on-openai', model: 'claude-sonnet-4-0' });

  assert.deepEqual(result.errors, []);
  assert.equal(result.text, REPLY_TEXT.anthropic);
  assert.deepEqual(served(), ['anthropic:claude-sonnet-4-0']);
  assert.equal(calls.filter((call) => call.provider === 'openai').length, 0, 'no model call reached OpenAI');
});

test("a GPT model picked in the playground goes to OpenAI, over the persona's Anthropic default", async () => {
  const runtime = await boot();

  const result = await turn(runtime, { sessionId: 's-gpt', selectedPersonaId: 'on-anthropic', model: 'gpt-4o-mini' });

  assert.deepEqual(result.errors, []);
  assert.equal(result.text, REPLY_TEXT.openai);
  assert.deepEqual(served(), ['openai:gpt-4o-mini']);
  assert.equal(calls.filter((call) => call.provider === 'anthropic').length, 0, 'no model call reached Anthropic');
});

test('an explicit provider override wins over the provider the model name suggests', async () => {
  const runtime = await boot();

  // The model name reads as OpenAI's; the request names Anthropic, and agentos follows the request.
  const result = await turn(runtime, {
    sessionId: 's-override',
    selectedPersonaId: 'on-openai',
    model: 'gpt-4o-mini',
    providerId: 'anthropic',
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.text, REPLY_TEXT.anthropic);
  assert.deepEqual(served(), ['anthropic:gpt-4o-mini']);
});

test("a turn with no model picked keeps the persona's provider and model", async () => {
  const runtime = await boot();

  const plain = await turn(runtime, { sessionId: 's-plain-openai', selectedPersonaId: 'on-openai' });
  const onClaude = await turn(runtime, { sessionId: 's-plain-anthropic', selectedPersonaId: 'on-anthropic' });

  assert.deepEqual(plain, { text: REPLY_TEXT.openai, errors: [] });
  assert.deepEqual(onClaude, { text: REPLY_TEXT.anthropic, errors: [] });
  assert.deepEqual(served(), ['openai:gpt-4o-mini', 'anthropic:claude-sonnet-4-0']);
});

test("a later turn of the same session with no model picked goes back to the persona's provider", async () => {
  const runtime = await boot();

  const named = await turn(runtime, { sessionId: 's-same', selectedPersonaId: 'on-openai', model: 'claude-sonnet-4-0' });
  const unnamed = await turn(runtime, { sessionId: 's-same', selectedPersonaId: 'on-openai' });

  assert.equal(named.text, REPLY_TEXT.anthropic);
  assert.equal(unnamed.text, REPLY_TEXT.openai);
  assert.deepEqual(served(), ['anthropic:claude-sonnet-4-0', 'openai:gpt-4o-mini']);
});
