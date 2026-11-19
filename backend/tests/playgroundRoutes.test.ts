import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimateCost,
  getPlaygroundRuntimeMode,
  resolvePlaygroundRuntime,
} from '../src/routes/playground';

test('resolvePlaygroundRuntime awaits the runtime getter result', async () => {
  const runtime = {
    async *streamText() {
      yield { type: 'text_delta', text: 'hello' };
    },
  };

  const resolved = await resolvePlaygroundRuntime(async () => runtime, async () => null);

  assert.equal(resolved, runtime);
});

test('resolvePlaygroundRuntime prefers module exports when generateText is exported at top level', async () => {
  let getterCalled = false;
  const moduleRuntime = {
    async generateText() {
      return { text: 'live' };
    },
  };

  const resolved = await resolvePlaygroundRuntime(
    async () => {
      getterCalled = true;
      return { legacy: true };
    },
    async () => moduleRuntime,
  );

  assert.equal(resolved, moduleRuntime);
  assert.equal(getterCalled, false);
});

test('resolvePlaygroundRuntime returns null when runtime loading fails', async () => {
  const resolved = await resolvePlaygroundRuntime(
    async () => {
      throw new Error('runtime unavailable');
    },
    async () => null,
  );

  assert.equal(resolved, null);
});

test('getPlaygroundRuntimeMode reports live only when the required method exists', () => {
  assert.equal(getPlaygroundRuntimeMode({ streamText() {} }, 'streamText'), 'live');
  assert.equal(getPlaygroundRuntimeMode({ generateText() {} }, 'generateText'), 'live');
  assert.equal(getPlaygroundRuntimeMode({}, 'streamText'), 'stub');
  assert.equal(getPlaygroundRuntimeMode(null, 'generateText'), 'stub');
});

test('estimateCost prices the GPT-6 models at their published per-1M rates', () => {
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  // Input and output separately, so a swap between the two rates fails.
  close(estimateCost(1_000_000, 0, 'gpt-6.2-sol'), 2.0);
  close(estimateCost(0, 1_000_000, 'gpt-6.2-sol'), 10.0);
  close(estimateCost(1_000_000, 0, 'gpt-6.2-astra'), 8.0);
  close(estimateCost(0, 1_000_000, 'gpt-6.2-astra'), 40.0);
  close(estimateCost(1_000_000, 0, 'gpt-6-luna'), 0.1);
  close(estimateCost(0, 1_000_000, 'gpt-6-luna'), 0.5);
});
