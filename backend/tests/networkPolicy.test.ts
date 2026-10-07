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
// A streaming route that answers an unknown execution with an error event, so it runs no model.
const STREAM_URL = '/api/agentos/agency/workflow/stream?executionId=missing';

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
  assert.deepEqual([...policy.allowedHostnames], ['localhost']);
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

test("a same-origin request from a page this server served is allowed", async () => {
  await withServer({}, async (app) => {
    // The Swagger UI at /documentation posts to the API with the backend's own origin.
    const response = await app.inject({
      method: 'POST',
      url: '/api/agentos/skills/enable',
      headers: { host: 'localhost:3001', origin: 'http://localhost:3001' },
      payload: { name: 'web-search' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });

    // Another port, or another scheme, on the same host is another origin. Both https://localhost
    // and http://localhost omit their default port.
    for (const [host, origin] of [
      ['localhost:3001', 'http://localhost:8080'],
      ['localhost', 'https://localhost'],
      ['localhost:3001', 'https://localhost:3001'],
    ]) {
      const other = await app.inject({
        method: 'POST',
        url: '/api/agentos/skills/enable',
        headers: { host, origin },
        payload: { name: 'web-search' },
      });
      assert.equal(other.statusCode, 403, `${origin} on ${host}`);
    }
  });
});

test('a cross-origin request without an Origin header is refused before the route runs', async () => {
  await withServer({}, async (app) => {
    // An image or a link on another site's page, or on a page from another port of this host
    // (same-site), sends no Origin header, and a GET to a streaming route starts a model run.
    for (const site of ['cross-site', 'same-site']) {
      const embedded = await app.inject({
        method: 'GET',
        url: STREAM_URL,
        headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' },
      });
      assert.equal(embedded.statusCode, 403, site);
      assert.deepEqual(embedded.json(), { error: 'Cross-origin request not allowed' });
    }

    // The front end's dev proxy forwards same-origin requests, and a typed URL is 'none'.
    for (const site of ['same-origin', 'none']) {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { 'sec-fetch-site': site } });
      assert.equal(response.statusCode, 200, site);
    }

    // With an allowed Origin header, a cross-site request (front end on 127.0.0.1, backend on localhost) is served.
    const frontEnd = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://127.0.0.1:5175', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(frontEnd.statusCode, 200);
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

test('a Host header naming another site is refused', async () => {
  await withServer({}, async (app) => {
    // DNS rebinding: another site's name resolves to 127.0.0.1 and its pages call this server.
    for (const host of ['attacker.example:3001', 'localhost.attacker.example:3001', 'localhost@attacker.example:3001']) {
      const rebound = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      assert.equal(rebound.statusCode, 403, host);
      assert.deepEqual(rebound.json(), { error: 'Host not allowed' });
    }

    for (const host of ['localhost:3001', 'LOCALHOST:3001', 'localhost.:3001', '127.0.0.1:3001', '[::1]:3001']) {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      assert.equal(response.statusCode, 200, host);
    }
  });
});

test('on every listen address the Host header must be localhost, an IP address or a listed name', async () => {
  for (const listen of ['0.0.0.0', '::', '127.0.0.2']) {
    await withServer({ AGENTOS_WORKBENCH_BACKEND_HOST: listen }, async (app) => {
      for (const host of ['192.168.1.20:3001', '[fe80::1]:3001', 'localhost:3001']) {
        const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
        assert.equal(response.statusCode, 200, `${listen} ${host}`);
      }
      for (const host of ['attacker.example:3001', 'workbench.lan:3001']) {
        const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
        assert.equal(response.statusCode, 403, `${listen} ${host}`);
      }
    });
  }

  await withServer(
    {
      AGENTOS_WORKBENCH_BACKEND_HOST: '0.0.0.0',
      AGENTOS_WORKBENCH_ALLOWED_HOSTS: 'workbench.lan',
      AGENTOS_WORKBENCH_PUBLIC_HOST: 'docs.workbench.lan:3001',
    },
    async (app) => {
      for (const host of ['workbench.lan:3001', 'docs.workbench.lan:3001']) {
        const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
        assert.equal(response.statusCode, 200, host);
      }
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

test('a streaming route sends CORS headers for the origins of the policy the server was built with', async () => {
  // The process policy does not list this origin; the route must use the server's policy.
  const origin = 'https://workbench.example.com';
  await withServer({ AGENTOS_WORKBENCH_ALLOWED_ORIGINS: origin }, async (app) => {
    const response = await app.inject({ method: 'GET', url: STREAM_URL, headers: { origin } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(response.payload, /Workflow execution not found/);
  });

  await withServer({}, async (app) => {
    const response = await app.inject({ method: 'GET', url: STREAM_URL, headers: { origin: FRONT_END } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], FRONT_END);
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
