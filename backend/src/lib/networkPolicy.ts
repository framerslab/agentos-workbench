/**
 * Who may reach the workbench backend.
 *
 * The backend has no login and runs with the developer's provider keys loaded,
 * so by default it listens on the loopback interface only, answers browser
 * requests only from the workbench front end's own origins, and refuses a
 * request whose Host header names another site. A page on another site can
 * point its own name at 127.0.0.1 (DNS rebinding); its requests then reach
 * this server with that site's name in the Host header.
 *
 * Environment:
 * - `AGENTOS_WORKBENCH_BACKEND_HOST`: the address to listen on. Default
 *   `localhost`, which Fastify binds to both 127.0.0.1 and ::1. `0.0.0.0`
 *   accepts connections from other machines.
 * - `AGENTOS_WORKBENCH_ALLOWED_ORIGINS`: comma-separated browser origins that
 *   may call the backend. Default: the front end's dev server (port 5175) and
 *   preview server (port 4173) on `localhost` and `127.0.0.1`.
 * - `AGENTOS_WORKBENCH_ALLOWED_HOSTS`: comma-separated host names the Host
 *   header may carry beside the loopback names. The Host check applies while
 *   the backend listens on a loopback address, or when this variable is set.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

/** The front end's dev and preview servers, which call the backend directly. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '::1'];

export interface NetworkPolicy {
  /** The address the server listens on. */
  listenHost: string;
  /** Browser origins allowed to call the backend, normalized by {@link normalizeOrigin}. */
  allowedOrigins: ReadonlySet<string>;
  /** Host names the Host header may carry, or null when the Host check is off. */
  allowedHostnames: ReadonlySet<string> | null;
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

/** The host name of a Host header value (`name[:port]` or `[ipv6][:port]`), lowercased. */
function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
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

  const extraHostnames = splitList(env.AGENTOS_WORKBENCH_ALLOWED_HOSTS)
    .map((host) => hostnameOf(host))
    .filter((host): host is string => host !== null);
  const listenHostname = hostnameOf(listenHost) ?? listenHost.toLowerCase();
  const listensOnLoopback = LOOPBACK_HOSTNAMES.includes(listenHostname);

  let allowedHostnames: Set<string> | null = null;
  if (listensOnLoopback || extraHostnames.length > 0) {
    allowedHostnames = new Set([...LOOPBACK_HOSTNAMES, ...extraHostnames]);
    const publicHost = env.AGENTOS_WORKBENCH_PUBLIC_HOST?.trim();
    const publicHostname = publicHost ? hostnameOf(publicHost) : null;
    if (publicHostname) {
      allowedHostnames.add(publicHostname);
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
 * Whether a request's Origin header is allowed. A request without one is
 * allowed: browsers omit it on same-origin GET requests, and non-browser
 * clients do not send it.
 */
export function isOriginAllowed(origin: string | undefined, policy: NetworkPolicy): boolean {
  if (origin === undefined) {
    return true;
  }
  const normalized = normalizeOrigin(origin);
  return normalized !== null && policy.allowedOrigins.has(normalized);
}

/** Whether a request's Host header names this server. */
export function isHostAllowed(hostHeader: string | undefined, policy: NetworkPolicy): boolean {
  if (policy.allowedHostnames === null || hostHeader === undefined) {
    return true;
  }
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && policy.allowedHostnames.has(hostname);
}

/**
 * Refuses, with 403, every request whose Host or Origin header the policy does
 * not allow. Register it before the CORS plugin and the routes, so the refusal
 * comes before a preflight answer, before body parsing, and before any route
 * runs. Refusing a disallowed origin outright matters beyond CORS: a browser
 * sends some cross-site requests (a form post, for example) without a
 * preflight, and CORS only stops the page from reading the response.
 */
export function registerNetworkGuards(app: FastifyInstance, policy: NetworkPolicy): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isHostAllowed(request.headers.host, policy)) {
      return reply.code(403).send({ error: 'Host not allowed' });
    }
    const origin = request.headers.origin;
    if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined, policy)) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }
  });
}

/**
 * Sets the CORS headers on a raw streaming response, which the CORS plugin
 * does not reach. Only an allowed origin is echoed back; a request without an
 * Origin header gets no CORS headers.
 */
export function applyStreamCorsHeaders(
  origin: string | string[] | undefined,
  raw: Pick<ServerResponse, 'setHeader'>,
  policy: NetworkPolicy = getNetworkPolicy(),
): void {
  if (typeof origin !== 'string' || !isOriginAllowed(origin, policy)) {
    return;
  }
  raw.setHeader('Access-Control-Allow-Origin', origin);
  raw.setHeader('Access-Control-Allow-Credentials', 'true');
  raw.setHeader('Vary', 'Origin');
}
