import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import Fastify from 'fastify';

// The tool catalog reads its store path once, when it loads, so the path is set
// before the routes are imported. The tests then write a temp file, never the
// store in the working copy.
const storeDir = mkdtempSync(path.join(tmpdir(), 'workbench-forge-test-'));
const storePath = path.join(storeDir, 'forged-tools.json');
process.env.AGENTOS_WORKBENCH_FORGE_PERSIST_PATH = storePath;

after(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

async function loadForgeRoutes() {
  const { default: forgeRoutes, WORKBENCH_FORGE_MODE_HEADER } = await import('../src/routes/forge');
  return { forgeRoutes, WORKBENCH_FORGE_MODE_HEADER };
}

function storedImplementation(toolId: string): string {
  const stored = JSON.parse(readFileSync(storePath, 'utf-8')) as Array<{
    id: string;
    implementation: string;
  }>;
  const tool = stored.find((entry) => entry.id === toolId);
  assert.ok(tool, `tool ${toolId} is in the temp store`);
  return tool.implementation;
}

test('forge routes expose explicit demo mode metadata across forge, registry, and test-run flows', async () => {
  const { forgeRoutes, WORKBENCH_FORGE_MODE_HEADER } = await loadForgeRoutes();
  const app = Fastify();
  await app.register(forgeRoutes, { prefix: '/api/agency' });

  try {
    const forgeResponse = await app.inject({
      method: 'POST',
      url: '/api/agency/forge',
      payload: {
        description: 'A tool that summarizes a JSON payload.',
        parametersSchema: '{"type":"object"}',
      },
    });
    assert.equal(forgeResponse.statusCode, 200);
    assert.equal(forgeResponse.headers[WORKBENCH_FORGE_MODE_HEADER.toLowerCase()], 'demo');

    const forgePayload = forgeResponse.json();
    assert.equal(forgePayload.mode, 'demo');
    assert.equal(forgePayload.status, 'approved');
    assert.ok(forgePayload.tool?.id);

    const toolsResponse = await app.inject({
      method: 'GET',
      url: '/api/agency/forged-tools',
    });
    assert.equal(toolsResponse.statusCode, 200);
    assert.equal(toolsResponse.headers[WORKBENCH_FORGE_MODE_HEADER.toLowerCase()], 'demo');

    const toolsPayload = toolsResponse.json();
    assert.equal(toolsPayload.mode, 'demo');
    assert.ok(Array.isArray(toolsPayload.tools));
    assert.ok(toolsPayload.tools.length > 0);

    const toolId = forgePayload.tool.id;
    const runResponse = await app.inject({
      method: 'POST',
      url: `/api/agency/forged-tools/${encodeURIComponent(toolId)}/run`,
      payload: {
        city: 'San Francisco',
      },
    });
    assert.equal(runResponse.statusCode, 200);
    assert.equal(runResponse.headers[WORKBENCH_FORGE_MODE_HEADER.toLowerCase()], 'demo');

    const runPayload = runResponse.json();
    assert.equal(runPayload.mode, 'demo');
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.result.ok, true);
    assert.equal(runPayload.result.result, 'Tool executed with params: {"city":"San Francisco"}');
  } finally {
    await app.close();
  }
});

test('forge can generate a real CoinGecko-backed price tool implementation', async () => {
  const { forgeRoutes } = await loadForgeRoutes();
  const app = Fastify();
  await app.register(forgeRoutes, { prefix: '/api/agency' });

  try {
    const forgeResponse = await app.inject({
      method: 'POST',
      url: '/api/agency/forge',
      payload: {
        description: 'A tool that gets the current price of BTC from CoinGecko.',
      },
    });

    assert.equal(forgeResponse.statusCode, 200);
    const forgePayload = forgeResponse.json();
    assert.equal(forgePayload.status, 'approved');
    assert.ok(forgePayload.tool?.id);

    const runResponse = await app.inject({
      method: 'POST',
      url: `/api/agency/forged-tools/${encodeURIComponent(forgePayload.tool.id)}/run`,
      payload: {},
    });

    assert.equal(runResponse.statusCode, 200);
    const runPayload = runResponse.json();
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.result.ok, true);
    assert.equal(runPayload.result.coinId, 'bitcoin');
    assert.equal(runPayload.result.vsCurrency, 'usd');
    assert.equal(runPayload.result.price, 67245.13);
    assert.equal(runPayload.result.source, 'demo-coingecko');
    assert.equal(runPayload.result.asOf, '2026-04-08T00:00:00Z');
  } finally {
    await app.close();
  }
});

test('forge keeps request text out of the code it generates and runs', async () => {
  const { forgeRoutes } = await loadForgeRoutes();
  const app = Fastify();
  await app.register(forgeRoutes, { prefix: '/api/agency' });
  const globals = globalThis as Record<string, unknown>;

  // Each request ends a line of its text with a line break and puts a
  // statement after it. The statement sets a marker if it ever runs as code.
  const requests = [
    {
      field: 'the description in the echo template',
      marker: 'forgeDescriptionMarker',
      payload: {
        description: 'A tool that adds two numbers together\nglobalThis.forgeDescriptionMarker = true',
      },
    },
    {
      field: 'the parameters schema in the echo template',
      marker: 'forgeSchemaMarker',
      payload: {
        description: 'A tool that multiplies two numbers together',
        parametersSchema: '{"type":"object"}\nglobalThis.forgeSchemaMarker = true',
      },
    },
    {
      field: 'the description in the price template',
      marker: 'forgePriceMarker',
      payload: {
        description:
          'A tool that gets the current price of ETH from CoinGecko.\nglobalThis.forgePriceMarker = true',
      },
    },
  ];

  try {
    for (const request of requests) {
      const statement = `globalThis.${request.marker} = true`;

      const forgeResponse = await app.inject({
        method: 'POST',
        url: '/api/agency/forge',
        payload: request.payload,
      });
      assert.equal(forgeResponse.statusCode, 200, request.field);
      const forgePayload = forgeResponse.json();
      assert.equal(forgePayload.status, 'approved', request.field);
      assert.ok(forgePayload.tool?.id, request.field);

      const codeLines = storedImplementation(forgePayload.tool.id)
        .split('\n')
        .map((line) => line.trim());
      assert.ok(
        !codeLines.includes(statement),
        `${request.field}: the stored code holds the request's statement as a line of code`,
      );

      const runResponse = await app.inject({
        method: 'POST',
        url: `/api/agency/forged-tools/${encodeURIComponent(forgePayload.tool.id)}/run`,
        payload: {},
      });
      assert.equal(runResponse.statusCode, 200, request.field);
      const runPayload = runResponse.json();
      assert.equal(runPayload.ok, true, request.field);
      assert.equal(runPayload.result.ok, true, request.field);
      assert.equal(
        globals[request.marker],
        undefined,
        `${request.field}: running the tool ran the request's statement`,
      );
    }
  } finally {
    for (const request of requests) delete globals[request.marker];
    await app.close();
  }
});
