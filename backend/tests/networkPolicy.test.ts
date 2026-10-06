import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import test from 'node:test';

import { buildServer } from '../src/index';
import {
  DEFAULT_ALLOWED_ORIGINS,
  applyStreamCorsHeaders,
  resolveNetworkPolicy,
} from '../src/lib/networkPolicy';

const FRONT_END = 'http://localhost:5175';
const OTHER_SITE = 'https://attacker.example';

type Server = Awaited<ReturnType<typeof buildServer>>;

async function withServer(env: NodeJS.ProcessEnv, run: (app: Server) => Promise<void>): Promise<void> {
  const app = await buildServer({ policy: resolveNetworkPolicy(env), logger: false, port: 3001 });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('the default policy listens on localhost and allows the front end origins', () => {
  const policy = resolveNetworkPolicy({});
  assert.equal(policy.listenHost, 'localhost');
  for (const origin of DEFAULT_ALLOWED_ORIGINS) {
    assert.ok(policy.allowedOrigins.has(origin), origin);
  }
  assert.ok(policy.allowedHostnames?.has('localhost'));
  assert.ok(policy.allowedHostnames?.has('::1'));
});

test('a request without an Origin header is served without CORS headers', async () => {
  await withServer({}, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});

test('the front end origin is served with credentials', async () => {
  await withServer({}, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { origin: FRONT_END } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], FRONT_END);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
  });
});

test('a request from another site is refused before the route runs', async () => {
  await withServer({}, async (app) => {
    // A form post needs no preflight, so the browser sends it; the route must not run.
    const refused = await app.inject({
      method: 'POST',
      url: '/api/agentos/skills/enable',
      headers: { origin: OTHER_SITE, 'content-type': 'text/plain' },
      payload: '{"name":"web-search"}',
    });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(refused.json(), { error: 'Origin not allowed' });
    assert.equal(refused.headers['access-control-allow-origin'], undefined);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/agentos/skills/enable',
      headers: { origin: FRONT_END },
      payload: { name: 'web-search' },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), { ok: true });
  });
});

test('a preflight from another site is refused, and one from the front end is answered', async () => {
  await withServer({}, async (app) => {
    const refused = await app.inject({
      method: 'OPTIONS',
      url: '/api/agentos/skills/enable',
      headers: { origin: OTHER_SITE, 'access-control-request-method': 'POST' },
    });
    assert.equal(refused.statusCode, 403);

    const answered = await app.inject({
      method: 'OPTIONS',
      url: '/api/agentos/skills/enable',
      headers: { origin: FRONT_END, 'access-control-request-method': 'POST' },
    });
    assert.equal(answered.statusCode, 204);
    assert.equal(answered.headers['access-control-allow-origin'], FRONT_END);
  });
});

test('the null origin of a sandboxed document is refused', async () => {
  await withServer({}, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'null' } });
    assert.equal(response.statusCode, 403);
  });
});

test('a Host header naming another site is refused while the backend listens on loopback', async () => {
  await withServer({}, async (app) => {
    // DNS rebinding: another site's name resolves to 127.0.0.1 and its pages call this server.
    const rebound = await app.inject({ method: 'GET', url: '/health', headers: { host: 'attacker.example:3001' } });
    assert.equal(rebound.statusCode, 403);
    assert.deepEqual(rebound.json(), { error: 'Host not allowed' });

    for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001']) {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      assert.equal(response.statusCode, 200, host);
    }
  });
});

test('listening on all interfaces turns the Host check off unless allowed hosts are listed', async () => {
  await withServer({ AGENTOS_WORKBENCH_BACKEND_HOST: '0.0.0.0' }, async (app) => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'workbench.lan:3001' } });
    assert.equal(response.statusCode, 200);
  });

  await withServer(
    { AGENTOS_WORKBENCH_BACKEND_HOST: '0.0.0.0', AGENTOS_WORKBENCH_ALLOWED_HOSTS: 'workbench.lan' },
    async (app) => {
      const listed = await app.inject({ method: 'GET', url: '/health', headers: { host: 'workbench.lan:3001' } });
      assert.equal(listed.statusCode, 200);
      const unlisted = await app.inject({ method: 'GET', url: '/health', headers: { host: 'attacker.example:3001' } });
      assert.equal(unlisted.statusCode, 403);
    },
  );
});

test('AGENTOS_WORKBENCH_ALLOWED_ORIGINS replaces the default list', async () => {
  await withServer({ AGENTOS_WORKBENCH_ALLOWED_ORIGINS: 'https://workbench.example.com/, HTTP://Tools.Example.com' }, async (app) => {
    const listed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://workbench.example.com' },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.headers['access-control-allow-origin'], 'https://workbench.example.com');

    const normalized = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://tools.example.com' } });
    assert.equal(normalized.statusCode, 200);

    const defaultOrigin = await app.inject({ method: 'GET', url: '/health', headers: { origin: FRONT_END } });
    assert.equal(defaultOrigin.statusCode, 403);
  });
});

test('streaming responses echo only an allowed origin', () => {
  const policy = resolveNetworkPolicy({});
  const capture = () => {
    const headers: Record<string, string> = {};
    const raw = {
      setHeader(name: string, value: string) {
        headers[name] = value;
        return raw;
      },
    } as unknown as ServerResponse;
    return { headers, raw };
  };

  const allowed = capture();
  applyStreamCorsHeaders(FRONT_END, allowed.raw, policy);
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], FRONT_END);
  assert.equal(allowed.headers['Access-Control-Allow-Credentials'], 'true');

  const other = capture();
  applyStreamCorsHeaders(OTHER_SITE, other.raw, policy);
  assert.deepEqual(other.headers, {});

  const none = capture();
  applyStreamCorsHeaders(undefined, none.raw, policy);
  assert.deepEqual(none.headers, {});
});
