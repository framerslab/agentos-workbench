/**
 * Who may reach the workbench backend.
 *
 * The backend has no login and runs with the developer's provider keys loaded,
 * so by default it listens on the loopback interface only and refuses three
 * kinds of request:
 *
 * - A request whose Origin header is neither one of the workbench front end's
 *   origins nor this server's own origin (a same-origin POST from the Swagger
 *   UI at /documentation carries `Origin: http://localhost:3001`).
 * - A cross-site request without an Origin header. An image, a script or a link
 *   on another site's page sends none, and a GET such as
 *   `/api/agentos/stream?messages=...` starts a model run. Browsers mark these
 *   requests `Sec-Fetch-Site: cross-site`. Browsers without Fetch Metadata
 *   (Chrome before 76, Firefox before 90, Safari before 16.4) send no such
 *   header, so this rule does not cover them: a request with neither header is
 *   served, because non-browser clients send neither.
 * - A request whose Host header names another site. A page on another site can
 *   point its own name at this machine (DNS rebinding); its requests then reach
 *   this server as same-origin requests with that site's name in the Host
 *   header. A Host that is an IP address is accepted on every listen address:
 *   a browser sends one only to a page served from that address.
 *
 * Environment:
 * - `AGENTOS_WORKBENCH_BACKEND_HOST`: the address to listen on. Default
 *   `localhost`, which Fastify binds to both 127.0.0.1 and ::1. `0.0.0.0`
 *   accepts connections from other machines.
 * - `AGENTOS_WORKBENCH_ALLOWED_ORIGINS`: comma-separated browser origins that
 *   may call the backend. Default: the front end's dev server (port 5175) and
 *   preview server (port 4173) on `localhost` and `127.0.0.1`.
 * - `AGENTOS_WORKBENCH_ALLOWED_HOSTS`: comma-separated host names the Host
 *   header may carry beside `localhost` and IP addresses, such as the name
 *   other machines use to reach this one.
 * - `AGENTOS_WORKBENCH_PUBLIC_HOST`: the host the Swagger docs advertise. Its
 *   name is allowed in the Host header too.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { isIP } from 'node:net';

declare module 'fastify' {
  interface FastifyInstance {
    /** The policy {@link registerNetworkGuards} enforces on this server; read it with {@link policyOf}. */
    networkPolicy: NetworkPolicy;
  }
}

/** The front end's dev and preview servers, which call the backend directly. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

export interface NetworkPolicy {
  /** The address the server listens on. */
  listenHost: string;
  /** Browser origins allowed to call the backend, normalized by {@link normalizeOrigin}. */
  allowedOrigins: ReadonlySet<string>;
  /** Host names the Host header may carry; an IP address is always allowed. */
  allowedHostnames: ReadonlySet<string>;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Normalizes an origin the way browsers send it: lowercase scheme and host,
 * no default port, no path. Returns null for anything that is not an http or
 * https origin, including the literal `null` origin of sandboxed documents.
 */
export function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The host name of a Host header value (`name[:port]` or `[ipv6][:port]`),
 * lowercased, without the brackets of an IPv6 address or a trailing dot.
 */
function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Whether an Origin header names the host and port the Host header names, that is, a page this server served. */
function isSameOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || normalizeOrigin(origin) === null) {
    return false;
  }
  try {
    return new URL(origin).host === new URL(`http://${hostHeader}`).host;
  } catch {
    return false;
  }
}

/** Builds the policy from environment variables; see the module comment for each one. */
export function resolveNetworkPolicy(env: NodeJS.ProcessEnv = process.env): NetworkPolicy {
  const listenHost = env.AGENTOS_WORKBENCH_BACKEND_HOST?.trim() || 'localhost';

  const configuredOrigins = splitList(env.AGENTOS_WORKBENCH_ALLOWED_ORIGINS);
  const allowedOrigins = new Set(
    (configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS)
      .map(normalizeOrigin)
      .filter((origin): origin is string => origin !== null),
  );

  const allowedHostnames = new Set(['localhost']);
  const publicHost = env.AGENTOS_WORKBENCH_PUBLIC_HOST?.trim();
  for (const host of [...splitList(env.AGENTOS_WORKBENCH_ALLOWED_HOSTS), ...(publicHost ? [publicHost] : [])]) {
    const hostname = hostnameOf(host);
    if (hostname) {
      allowedHostnames.add(hostname);
    }
  }

  return { listenHost, allowedOrigins, allowedHostnames };
}

let cachedPolicy: NetworkPolicy | null = null;

/** The policy for this process, read from the environment on first use. */
export function getNetworkPolicy(): NetworkPolicy {
  cachedPolicy ??= resolveNetworkPolicy();
  return cachedPolicy;
}

/**
 * The policy a server enforces: the one {@link registerNetworkGuards} stored on
 * it, or the process policy for an instance built without the guards (a test
 * that registers a single route plugin).
 */
export function policyOf(app: FastifyInstance): NetworkPolicy {
  return app.hasDecorator('networkPolicy') ? app.networkPolicy : getNetworkPolicy();
}

/**
 * Whether a request's Origin header is allowed. A request without one is
 * allowed here: browsers omit it on same-origin GET requests, and non-browser
 * clients do not send it. {@link registerNetworkGuards} refuses the cross-site
 * requests among those.
 */
export function isOriginAllowed(origin: string | undefined, policy: NetworkPolicy): boolean {
  if (origin === undefined) {
    return true;
  }
  const normalized = normalizeOrigin(origin);
  return normalized !== null && policy.allowedOrigins.has(normalized);
}

/**
 * Whether a request's Host header names this server: an IP address, or a host
 * name the policy lists (`localhost` by default). DNS rebinding needs a name
 * the attacker's DNS answers for, so an IP address is safe. A request without a
 * Host header is allowed; browsers always send one.
 */
export function isHostAllowed(hostHeader: string | undefined, policy: NetworkPolicy): boolean {
  if (hostHeader === undefined) {
    return true;
  }
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && (isIP(hostname) !== 0 || policy.allowedHostnames.has(hostname));
}

/**
 * Refuses, with 403, every request the policy does not allow (see the module
 * comment), and stores the policy on the server for {@link policyOf}. Register
 * it before the CORS plugin and the routes, so the refusal comes before a
 * preflight answer, before body parsing, and before any route runs. Refusing
 * outright matters beyond CORS: a browser sends some cross-site requests (a
 * form post, an image) without a preflight, and CORS only stops the page from
 * reading the response.
 */
export function registerNetworkGuards(app: FastifyInstance, policy: NetworkPolicy): void {
  app.decorate('networkPolicy', policy);
  app.addHook('onRequest', async (request, reply) => {
    if (!isHostAllowed(request.headers.host, policy)) {
      return reply.code(403).send({ error: 'Host not allowed' });
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string') {
      // The Host check above has passed, so a same-origin request comes from a page this server served.
      if (!isOriginAllowed(origin, policy) && !isSameOrigin(origin, request.headers.host)) {
        return reply.code(403).send({ error: 'Origin not allowed' });
      }
    } else if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Cross-site request not allowed' });
    }
  });
}

/**
 * Sets the CORS headers on a raw streaming response, which the CORS plugin
 * does not reach. Only an allowed origin is echoed back; a request without an
 * Origin header gets no CORS headers. Pass the server's policy:
 * `applyStreamCorsHeaders(request.headers.origin, reply.raw, policyOf(request.server))`.
 */
export function applyStreamCorsHeaders(
  origin: string | string[] | undefined,
  raw: Pick<ServerResponse, 'setHeader'>,
  policy: NetworkPolicy,
): void {
  if (typeof origin !== 'string' || !isOriginAllowed(origin, policy)) {
    return;
  }
  raw.setHeader('Access-Control-Allow-Origin', origin);
  raw.setHeader('Access-Control-Allow-Credentials', 'true');
  raw.setHeader('Vary', 'Origin');
}
