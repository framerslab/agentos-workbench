/**
 * @file events.ts
 * @description Server-Sent Events (SSE) event bus route for the AgentOS Workbench.
 *
 * Routes:
 *   `GET /events` -- persistent SSE connection.  Clients stay connected
 *     indefinitely.  Heartbeat `: ping\n\n` every 20 s keeps proxies open.
 *     Initial event: `{ event: '__connected__', data: { message, ts } }`.
 *
 *   `POST /events/emit` -- broadcast a custom event to all connected SSE clients.
 *     Body:     `{ event: string, data: unknown }`
 *     Response: `{ ok: true, clients: number }`
 *
 * Event envelope format (JSON in SSE data field):
 * ```
 * data: {"event":"hitl:approval-needed","data":{...}}
 * ```
 *
 * Supported event types:
 *   - `voice:transcript`        -- live transcription update
 *   - `hitl:approval-needed`    -- new HITL approval request
 *   - `forge:verdict`           -- tool forge judge verdict
 *   - `channel:message`         -- incoming channel message
 *   - `agency:agent-start`      -- agency sub-agent started
 *   - `agency:agent-end`        -- agency sub-agent finished
 *   - `error`                   -- server-side error notification
 *
 * Demo heartbeat:
 *   When at least one client is connected, the server emits synthetic events
 *   every 4 s so the UI can exercise live mode during development.
 *
 * The frontend connects via {@link EventSource} and the `useEventBus` hook.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { applyStreamCorsHeaders, policyOf } from '../lib/networkPolicy';

// ---------------------------------------------------------------------------
// Broadcaster singleton
// ---------------------------------------------------------------------------

type SseClient = {
  id: string;
  reply: FastifyReply;
};

type WorkbenchEventSourceMode = 'runtime' | 'demo' | 'mixed' | 'local';

function withEventSourceMetadata<T extends Record<string, unknown>>(
  data: T,
  sourceMode: WorkbenchEventSourceMode,
  synthetic = false
): T & { sourceMode: WorkbenchEventSourceMode; synthetic?: boolean } {
  return {
    ...data,
    sourceMode,
    ...(synthetic ? { synthetic: true } : {}),
  };
}

/**
 * Shared broadcaster that any route or service can import to push events to
 * all connected SSE clients.
 */
export class EventBroadcaster {
  private clients: Map<string, SseClient> = new Map();

  /** Register a new SSE client connection. */
  addClient(id: string, reply: FastifyReply): () => void {
    const client: SseClient = { id, reply };
    this.clients.set(id, client);
    return () => {
      this.clients.delete(id);
    };
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcast(event: string, data: unknown): void {
    const payload = `data: ${JSON.stringify({ event, data })}\n\n`;
    for (const [id, client] of this.clients) {
      try {
        client.reply.raw.write(payload);
      } catch {
        // Client disconnected — remove it
        this.clients.delete(id);
      }
    }
  }

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }
}

/** Singleton broadcaster imported by other route modules. */
export const eventBroadcaster = new EventBroadcaster();

// ---------------------------------------------------------------------------
// Demo heartbeat — emits synthetic events so the UI can exercise live mode
// ---------------------------------------------------------------------------

let heartbeatStarted = false;

function startDemoHeartbeat(): void {
  if (heartbeatStarted) return;
  heartbeatStarted = true;

  const DEMO_AGENTS = ['researcher', 'writer', 'planner', 'analyst'];
  const DEMO_CHANNELS = ['slack', 'discord', 'telegram', 'webhook'];

  setInterval(() => {
    if (eventBroadcaster.clientCount === 0) return;

    const roll = Math.random();

    if (roll < 0.25) {
      eventBroadcaster.broadcast(
        'voice:transcript',
        withEventSourceMetadata(
          {
            callId: 'call-demo',
            speaker: roll < 0.125 ? 'Agent' : 'Caller',
            text: 'Live transcription stream…',
            timestamp: new Date().toISOString(),
          },
          'demo',
          true
        )
      );
    } else if (roll < 0.45) {
      const channel = DEMO_CHANNELS[Math.floor(Math.random() * DEMO_CHANNELS.length)];
      eventBroadcaster.broadcast(
        'channel:message',
        withEventSourceMetadata(
          {
            channel,
            from: 'demo-user',
            text: `Incoming ${channel} message at ${new Date().toLocaleTimeString()}`,
            timestamp: new Date().toISOString(),
          },
          'demo',
          true
        )
      );
    } else if (roll < 0.55) {
      const agent = DEMO_AGENTS[Math.floor(Math.random() * DEMO_AGENTS.length)];
      eventBroadcaster.broadcast(
        'agency:agent-start',
        withEventSourceMetadata(
          {
            agentId: agent,
            input: 'Working on task…',
            timestamp: new Date().toISOString(),
          },
          'demo',
          true
        )
      );
    } else if (roll < 0.65) {
      const agent = DEMO_AGENTS[Math.floor(Math.random() * DEMO_AGENTS.length)];
      eventBroadcaster.broadcast(
        'agency:agent-end',
        withEventSourceMetadata(
          {
            agentId: agent,
            output: 'Task complete.',
            timestamp: new Date().toISOString(),
          },
          'demo',
          true
        )
      );
    }
  }, 4_000);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /events — Server-Sent Events stream.
   *
   * Clients stay connected indefinitely.  The server sends a heartbeat comment
   * every 20 s to keep proxies and load balancers from closing the connection.
   */
  fastify.get('/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // reply.raw bypasses the CORS plugin, so the stream sets its own CORS headers.
    applyStreamCorsHeaders(request.headers.origin, reply.raw, policyOf(request.server));
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    reply.raw.flushHeaders();

    // Send initial connected event
    reply.raw.write(
      `data: ${JSON.stringify({
        event: '__connected__',
        data: withEventSourceMetadata(
          {
            message: 'AgentOS event bus connected',
            ts: Date.now(),
          },
          'mixed'
        ),
      })}\n\n`
    );

    const removeClient = eventBroadcaster.addClient(clientId, reply);

    // Heartbeat ping every 20 s (SSE comment line)
    const pingInterval = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(pingInterval);
      }
    }, 20_000);

    // Clean up when client disconnects
    request.raw.on('close', () => {
      clearInterval(pingInterval);
      removeClient();
    });

    startDemoHeartbeat();

    // Keep the handler alive — Fastify should not close the response
    await new Promise<void>((resolve) => {
      request.raw.on('close', resolve);
    });
  });

  /**
   * POST /events/emit — REST endpoint to broadcast an arbitrary event.
   *
   * Useful for testing the event bus and for other backend services to
   * trigger frontend notifications.
   */
  fastify.post<{
    Body: {
      event: string;
      data: Record<string, unknown>;
      sourceMode?: WorkbenchEventSourceMode;
      synthetic?: boolean;
    };
  }>(
    '/events/emit',
    {
      schema: {
        description: 'Broadcast a custom event to all connected SSE clients',
        tags: ['Events'],
        body: {
          type: 'object',
          required: ['event', 'data'],
          properties: {
            event: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
            sourceMode: { type: 'string' },
            synthetic: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              clients: { type: 'number' },
              mode: { type: 'string' },
            },
            required: ['ok', 'clients', 'mode'],
          },
        },
      },
    },
    async (request, reply) => {
      const { event, data, sourceMode = 'runtime', synthetic = false } = request.body;
      reply.header('X-AgentOS-Workbench-Mode', 'mixed');
      eventBroadcaster.broadcast(event, withEventSourceMetadata(data, sourceMode, synthetic));
      return reply.send({ ok: true, clients: eventBroadcaster.clientCount, mode: 'mixed' });
    }
  );
}
