import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import agentosRoutes from './routes/agentos';
import systemRoutes from './routes/system';
import evaluationRoutes from './routes/evaluation';
import planningRoutes from './routes/planning';
import marketplaceRoutes from './routes/marketplace';
import userRoutes from './routes/user';
import skillRoutes from './routes/skills';
import memoryRoutes from './routes/memory';
import voiceRoutes from './routes/voice';
import approvalsRoutes from './routes/approvals';
import discoveryRoutes from './routes/discovery';
import workflowRoutes from './routes/workflow';
import forgeRoutes from './routes/forge';
import channelRoutes from './routes/channels';
import socialRoutes from './routes/social';
import guardrailRoutes from './routes/guardrails';
import observabilityRoutes from './routes/observability';
import ragRoutes from './routes/rag';
import ragRuntimeRoutes from './routes/ragRuntime';
import eventsRoutes from './routes/events';
import playgroundRoutes from './routes/playground';
import { initializeAgentOS, persistAgentOSRuntimeRag, shutdownAgentOS } from './lib/agentos';
import { WORKBENCH_RUNTIME_RAG_DOCUMENT_PERSIST_PATH } from './lib/workbenchRuntimeRag';
import { runtimeRagDocumentStore } from './services/runtimeRagDocumentStore';
import { getNetworkPolicy, registerNetworkGuards, type NetworkPolicy } from './lib/networkPolicy';
import { config } from 'dotenv';
config()

/** The port to listen on, from the environment. */
function resolvePort(): number {
  const configuredPort = Number(
    process.env.AGENTOS_WORKBENCH_BACKEND_PORT ?? process.env.PORT ?? 3001
  );
  return Number.isFinite(configuredPort) ? configuredPort : 3001;
}

export interface BuildServerOptions {
  /** Who may reach the server; defaults to the policy read from the environment. */
  policy?: NetworkPolicy;
  /** Fastify's request logger; on by default. */
  logger?: boolean;
  /** The port reported by `/health` and advertised in the API docs. */
  port?: number;
}

/**
 * Builds the server with its plugins and routes. It neither starts AgentOS nor
 * listens; `main()` does both, and tests inject requests into the result.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const policy = options.policy ?? getNetworkPolicy();
  const port = options.port ?? resolvePort();
  const swaggerHost = process.env.AGENTOS_WORKBENCH_PUBLIC_HOST?.trim() || `localhost:${port}`;
  const server = fastify({
    logger: options.logger ?? true
  });

  // Refuse a disallowed Host or Origin before any other hook or route runs.
  registerNetworkGuards(server, policy);

  // Register Swagger
  await server.register(swagger, {
    swagger: {
      info: {
        title: 'AgentOS Workbench API',
        description: 'API documentation for the AgentOS Workbench backend',
        version: '1.0.0'
      },
      host: swaggerHost,
      schemes: ['http'],
      consumes: ['application/json'],
      produces: ['application/json']
    }
  });

  await server.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false
    },
    staticCSP: true,
    transformStaticCSP: (header) => header
  });

  // Register CORS for the allowed origins only
  await server.register(cors, {
    origin: [...policy.allowedOrigins],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  });

  await server.register(multipart, {
    limits: {
      fileSize: 18 * 1024 * 1024,
      files: 1,
      parts: 10,
    },
  });

  // Register Rate Limit
  await server.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute'
  });

  // Register Routes
  server.register(agentosRoutes, { prefix: '/api/agentos' });
  server.register(systemRoutes, { prefix: '/api/system' });
  server.register(evaluationRoutes, { prefix: '/api/evaluation' });
  server.register(planningRoutes, { prefix: '/api/planning' });
  server.register(marketplaceRoutes, { prefix: '/api/marketplace' });
  server.register(userRoutes, { prefix: '/api/user' });
  server.register(skillRoutes, { prefix: '/api/agentos' });
  server.register(memoryRoutes, { prefix: '/api/agentos' });
  server.register(ragRuntimeRoutes, { prefix: '/api/agentos' });
  server.register(voiceRoutes, { prefix: '/api/voice' });
  server.register(approvalsRoutes, { prefix: '/api/agency' });
  server.register(discoveryRoutes, { prefix: '/api/agency' });
  server.register(workflowRoutes, { prefix: '/api/agency' });
  server.register(forgeRoutes, { prefix: '/api/agency' });
  server.register(channelRoutes, { prefix: '/api/channels' });
  server.register(socialRoutes, { prefix: '/api/social' });
  server.register(guardrailRoutes, { prefix: '/api/guardrails' });
  server.register(observabilityRoutes, { prefix: '/api/observability' });
  server.register(ragRoutes, { prefix: '/api/rag' });
  server.register(eventsRoutes, { prefix: '/api' });
  server.register(playgroundRoutes, { prefix: '/api/playground' });

  // Health check
  server.get('/health', {
    schema: {
      description: 'Health check endpoint',
      tags: ['System'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            port: { type: 'number' }
          }
        }
      }
    }
  }, async () => {
    return { status: 'ok', port };
  });

  return server;
}

/**
 * Starts AgentOS, builds the server and listens.
 */
async function main() {
  await initializeAgentOS();
  await runtimeRagDocumentStore.initialize(WORKBENCH_RUNTIME_RAG_DOCUMENT_PERSIST_PATH);
  const port = resolvePort();
  const policy = getNetworkPolicy();
  const server = await buildServer({ policy, port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.log.info({ signal }, 'Shutting down AgentOS Workbench backend');
    try {
      await runtimeRagDocumentStore.persist();
      await persistAgentOSRuntimeRag();
      await shutdownAgentOS();
      await server.close();
      process.exit(0);
    } catch (error) {
      server.log.error({ err: error, signal }, 'Failed during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await server.listen({ port, host: policy.listenHost });
    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Start only when run as the entry point, so tests can import buildServer.
if (require.main === module) {
  void main();
}
