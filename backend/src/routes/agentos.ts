import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FastifyInstance } from 'fastify';
import { getAgentOS } from '../lib/agentos';
import { planningStore, type PlanStatus, type PlanStepRecord, type PlanStepStatus } from '../services/planningStore';
import {
  graphRunStore,
  type GraphRunCheckpointRecord,
  type GraphRunRecord,
  type GraphRunTaskRecord,
} from '../services/graphRunStore';
import {
  mockModels,
  mockExecutions
} from '../mockData';
import {
  isGuardrailPackInstalled,
  listGuardrailExtensions,
  listWorkbenchExtensions,
  listWorkbenchSkills,
  listWorkbenchTools,
} from '../lib/registryCatalog';

const TEXT_DELTA_CHUNK_TYPE = 'text_delta';
const ERROR_CHUNK_TYPE = 'error';
const GUARDRAIL_PACK_ORDER = [
  'pii-redaction',
  'ml-classifiers',
  'topicality',
  'code-safety',
  'grounding-guard',
] as const;

type GuardrailPackId = typeof GUARDRAIL_PACK_ORDER[number];
type GuardrailTier = 'dangerous' | 'permissive' | 'balanced' | 'strict' | 'paranoid';
type AgentOSModuleExports = {
  agent?: unknown;
  generateText?: unknown;
  streamText?: unknown;
  generateImage?: unknown;
  AgentGraph?: unknown;
  workflow?: unknown;
  mission?: unknown;
  GraphRuntime?: unknown;
  InMemoryCheckpointStore?: unknown;
};

const TIER_GUARDRAIL_DEFAULTS: Record<GuardrailTier, Record<GuardrailPackId, boolean>> = {
  dangerous: {
    'pii-redaction': false,
    'ml-classifiers': false,
    topicality: false,
    'code-safety': false,
    'grounding-guard': false,
  },
  permissive: {
    'pii-redaction': false,
    'ml-classifiers': false,
    topicality: false,
    'code-safety': true,
    'grounding-guard': false,
  },
  balanced: {
    'pii-redaction': true,
    'ml-classifiers': false,
    topicality: false,
    'code-safety': true,
    'grounding-guard': false,
  },
  strict: {
    'pii-redaction': true,
    'ml-classifiers': true,
    topicality: false,
    'code-safety': true,
    'grounding-guard': false,
  },
  paranoid: {
    'pii-redaction': true,
    'ml-classifiers': true,
    topicality: true,
    'code-safety': true,
    'grounding-guard': true,
  },
};

const runtimeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<AgentOSModuleExports>;

type WorkbenchWorkflowRequest = {
  definitionId: string;
  workflowId?: string;
  conversationId?: string;
  context?: Record<string, unknown>;
  roleAssignments?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

type WorkbenchAgencyRequest = {
  agencyId?: string;
  workflowId?: string;
  goal?: string;
  participants?: Array<{ roleId: string; personaId?: string }>;
  metadata?: Record<string, unknown>;
};

type AgencyRoleDescriptor = {
  roleId: string;
  personaId?: string;
  instruction?: string;
  priority?: number;
};

type PendingWorkflowExecution = {
  executionId: string;
  userId?: string;
  workflowId: string;
  topic: string;
  outputFormat?: string;
  conversationId: string;
  roles: AgencyRoleDescriptor[];
};

type WorkflowTaskSnapshotRecord = {
  status?: string;
  assignedRoleId?: string;
  assignedExecutorId?: string;
  output?: unknown;
  error?: { message?: string };
  metadata?: Record<string, unknown>;
};

function parseJsonValue<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function inferProviderId(model: string): string | undefined {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('llama') || model.startsWith('mixtral')) return 'groq';
  return undefined;
}

export function buildWorkbenchProcessRequestInput(input: {
  userId?: string;
  sessionId?: string;
  conversationId?: string;
  selectedPersonaId?: string;
  textInput?: string | null;
  model?: string;
  providerId?: string;
  workflowRequest?: WorkbenchWorkflowRequest;
  agencyRequest?: WorkbenchAgencyRequest;
}) {
  return {
    userId: input.userId || 'anonymous',
    sessionId: input.sessionId || input.conversationId || `session-${Date.now()}`,
    textInput: input.textInput ?? '',
    selectedPersonaId: input.selectedPersonaId,
    conversationId: input.conversationId,
    workflowRequest: input.workflowRequest,
    agencyRequest: input.agencyRequest,
    options: input.model
      ? {
          preferredModelId: input.model,
          preferredProviderId: input.providerId ?? inferProviderId(input.model),
        }
      : undefined,
  };
}

function buildAgencyRequestFromRoles(input: {
  agencyId?: string;
  workflowId?: string;
  goal?: string;
  outputFormat?: string;
  roles?: AgencyRoleDescriptor[];
}) {
  const roles = Array.isArray(input.roles) ? input.roles : [];
  return {
    agencyRequest: {
      agencyId: input.agencyId,
      workflowId: input.workflowId,
      goal: input.goal,
      participants: roles.map((role) => ({
        roleId: role.roleId,
        personaId: role.personaId,
      })),
      metadata: {
        outputFormat: input.outputFormat,
        roleInstructions: roles
          .filter((role) => typeof role.instruction === 'string' && role.instruction.trim().length > 0)
          .map((role) => ({
            roleId: role.roleId,
            instruction: role.instruction,
            priority: role.priority,
          })),
      },
    },
    selectedPersonaId: roles.find((role) => typeof role.personaId === 'string' && role.personaId.trim().length > 0)?.personaId,
  };
}

function coerceTextInput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const pendingWorkflowExecutions = new Map<string, PendingWorkflowExecution>();

function toPlanStepStatus(status: unknown): PlanStepStatus {
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'pending';
  if (normalized === 'running') return 'in_progress';
  if (normalized === 'complete') return 'completed';
  if (normalized === 'errored' || normalized === 'error') return 'failed';
  if (normalized === 'awaiting_input') return 'pending';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'skipped';
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'skipped'
  ) {
    return normalized;
  }
  return 'pending';
}

function toPlanStatus(status: unknown): PlanStatus {
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'executing';
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'awaiting_input') {
    return 'executing';
  }
  if (normalized === 'complete') return 'completed';
  if (normalized === 'errored' || normalized === 'error') return 'failed';
  if (
    normalized === 'draft' ||
    normalized === 'executing' ||
    normalized === 'paused' ||
    normalized === 'completed' ||
    normalized === 'failed'
  ) {
    return normalized;
  }
  return 'executing';
}

function syncPlanningStoreFromWorkflowSnapshot(input: {
  planId: string;
  goal: string;
  workflowId?: string;
  conversationId?: string;
  source: 'compose' | 'agency' | 'workflow';
  workflow: {
    status?: string;
    tasks?: Record<string, {
      status?: string;
      assignedRoleId?: string;
      assignedExecutorId?: string;
      output?: unknown;
      error?: { message?: string };
      metadata?: Record<string, unknown>;
    }>;
  };
}) {
  const tasks = input.workflow.tasks ?? {};
  const steps: PlanStepRecord[] = Object.entries(tasks).map(([taskId, taskSnapshot]) => ({
    stepId: taskId,
    description:
      typeof taskSnapshot.metadata?.displayName === 'string'
        ? taskSnapshot.metadata.displayName
        : taskId,
    actionType: 'gmi_action',
    status: toPlanStepStatus(taskSnapshot.status),
    confidence: typeof taskSnapshot.metadata?.confidence === 'number' ? taskSnapshot.metadata.confidence : 0.8,
    output: taskSnapshot.output,
    error: taskSnapshot.error?.message,
  }));

  planningStore.syncRuntimePlan({
    planId: input.planId,
    goal: input.goal,
    status: toPlanStatus(input.workflow.status),
    steps,
    conversationId: input.conversationId,
    workflowId: input.workflowId,
  });

  graphRunStore.syncWorkflowSnapshot({
    runId: input.planId,
    source: input.source,
    goal: input.goal,
    workflowId: input.workflowId,
    conversationId: input.conversationId,
    workflow: input.workflow,
  });
}

function mapGraphRunTasksToPlanSteps(tasks: GraphRunTaskRecord[]): PlanStepRecord[] {
  return tasks.map((task, index) => ({
    stepId: task.taskId,
    description: task.description,
    actionType:
      typeof task.metadata?.actionType === 'string'
        ? (task.metadata.actionType as PlanStepRecord['actionType'])
        : 'gmi_action',
    toolId: typeof task.metadata?.toolId === 'string' ? task.metadata.toolId : undefined,
    status: toPlanStepStatus(task.status),
    confidence: typeof task.metadata?.confidence === 'number' ? task.metadata.confidence : 0.8,
    output: task.output,
    error: task.error,
    durationMs: typeof task.metadata?.durationMs === 'number' ? task.metadata.durationMs : undefined,
    estimatedTokens:
      typeof task.metadata?.estimatedTokens === 'number'
        ? task.metadata.estimatedTokens
        : 450 + index * 100,
  }));
}

function syncExistingRuntimePlanFromGraphRun(run: GraphRunRecord): void {
  if (!planningStore.getPlan(run.runId)) {
    return;
  }
  planningStore.syncRuntimePlan({
    planId: run.runId,
    goal: run.goal,
    status: toPlanStatus(run.status),
    steps: mapGraphRunTasksToPlanSteps(run.tasks),
    conversationId: run.conversationId,
    workflowId: run.workflowId,
  });
}

function createManualPlanFromGraphCheckpoint(input: {
  run: GraphRunRecord;
  checkpoint: GraphRunCheckpointRecord;
}) {
  return planningStore.createPlan({
    goal: `${input.run.goal} (graph checkpoint fork)`,
    steps: input.checkpoint.tasks.map((task) => ({
      description: task.description,
      actionType:
        typeof task.metadata?.actionType === 'string'
          ? (task.metadata.actionType as PlanStepRecord['actionType'])
          : 'gmi_action',
      toolId: typeof task.metadata?.toolId === 'string' ? task.metadata.toolId : undefined,
      estimatedTokens:
        typeof task.metadata?.estimatedTokens === 'number'
          ? task.metadata.estimatedTokens
          : undefined,
      confidence:
        typeof task.metadata?.confidence === 'number'
          ? task.metadata.confidence
          : undefined,
    })),
  });
}

async function loadAgentOSModuleExports(): Promise<AgentOSModuleExports | null> {
  const sourceEntry = path.resolve(__dirname, '../../../../../packages/agentos/src/index.ts');
  try {
    return await runtimeImport(pathToFileURL(sourceEntry).href);
  } catch {
    // fall through
  }
  try {
    return await runtimeImport('@framers/agentos');
  } catch {
    try {
      const fallbackEntry = path.resolve(__dirname, '../../../../../packages/agentos/dist/index.js');
      return await runtimeImport(pathToFileURL(fallbackEntry).href);
    } catch {
      return null;
    }
  }
}

async function readAgentOSPackageVersion(): Promise<string | null> {
  try {
    const packageJsonPath = path.resolve(__dirname, '../../../../../packages/agentos/package.json');
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function serializeConversation(conversation: unknown): Record<string, unknown> | null {
  if (!conversation || typeof conversation !== 'object') {
    return null;
  }

  const source = conversation as {
    toJSON?: () => unknown;
    getHistory?: (limit?: number) => unknown[];
    getAllMetadata?: () => Record<string, unknown>;
    getLastMessage?: () => { timestamp?: number } | undefined;
    sessionId?: string;
    createdAt?: number;
    userId?: string;
    gmiInstanceId?: string;
    activePersonaId?: string;
    currentLanguage?: string;
    messages?: unknown[];
    sessionMetadata?: Record<string, unknown>;
    config?: Record<string, unknown>;
  };

  const base =
    typeof source.toJSON === 'function'
      ? source.toJSON()
      : {
          sessionId: source.sessionId,
          createdAt: source.createdAt,
          messages: typeof source.getHistory === 'function' ? source.getHistory() : source.messages,
          sessionMetadata:
            typeof source.getAllMetadata === 'function'
              ? source.getAllMetadata()
              : source.sessionMetadata,
          config: source.config,
        };

  if (!base || typeof base !== 'object') {
    return null;
  }

  const json = base as {
    sessionId?: string;
    createdAt?: number;
    messages?: Array<{ timestamp?: number }>;
    sessionMetadata?: Record<string, unknown>;
    config?: Record<string, unknown>;
  };
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const lastMessageTimestamp = messages.reduce((latest, message) => {
    const timestamp =
      typeof message?.timestamp === 'number'
        ? message.timestamp
        : latest;
    return Math.max(latest, timestamp);
  }, 0);

  return {
    sessionId: json.sessionId ?? source.sessionId ?? null,
    createdAt: json.createdAt ?? source.createdAt ?? null,
    userId:
      typeof source.userId === 'string'
        ? source.userId
        : json.sessionMetadata?.userId ?? null,
    gmiInstanceId:
      typeof source.gmiInstanceId === 'string'
        ? source.gmiInstanceId
        : json.sessionMetadata?.gmiInstanceId ?? null,
    activePersonaId:
      typeof source.activePersonaId === 'string'
        ? source.activePersonaId
        : json.sessionMetadata?.activePersonaId ?? null,
    currentLanguage:
      typeof source.currentLanguage === 'string'
        ? source.currentLanguage
        : json.sessionMetadata?.currentLanguage ?? null,
    messages,
    messageCount: messages.length,
    lastActiveAt:
      lastMessageTimestamp ||
      (typeof source.getLastMessage === 'function' ? source.getLastMessage()?.timestamp ?? null : null) ||
      (json.sessionMetadata?._lastAccessed ?? null),
    sessionMetadata: json.sessionMetadata ?? {},
    config: json.config ?? {},
  };
}

/**
 * Registers AgentOS routes.
 * @param fastify The Fastify instance.
 */
export default async function agentosRoutes(fastify: FastifyInstance) {
  const sessionInstalledExtensions = new Set<string>();
  
  /**
   * Chat endpoint.
   * Accepts a POST request with a message and returns a simulated response.
   */
  fastify.post('/chat', {
    schema: {
      description: 'Send a single message to the agent and wait for the full response',
      tags: ['AgentOS'],
      body: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          personaId: { type: 'string' },
          input: { type: 'string' },
          conversationId: { type: 'string' },
          model: { type: 'string' },
          workflowRequest: { type: 'object', additionalProperties: true },
          agencyRequest: { type: 'object', additionalProperties: true },
        },
        required: ['input']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            content: { type: 'string' },
            created: { type: 'number' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const agentos = await getAgentOS();
    const { userId, personaId, input, conversationId, model, workflowRequest, agencyRequest } = request.body as any;
    
    // We consume the generator to return a simple response
    // In a real non-streaming scenario, we might wait for the full response.
    // For now, we'll just gather the text.
    let fullText = '';
    const iterator = agentos.processRequest(
      buildWorkbenchProcessRequestInput({
        userId,
        sessionId: conversationId,
        conversationId,
        selectedPersonaId: personaId,
        textInput: input,
        model,
        workflowRequest,
        agencyRequest,
      })
    );

    for await (const chunk of iterator) {
        if (chunk.type === TEXT_DELTA_CHUNK_TYPE && chunk.textDelta) {
            fullText += chunk.textDelta;
        }
        // Handle error chunks
        if (chunk.type === ERROR_CHUNK_TYPE) {
            throw chunk; 
        }
    }

    return {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: fullText,
      created: Date.now()
    };
  });

  /**
   * Stream endpoint (SSE).
   * Streams a simulated response line by line.
   */
  
  fastify.get('/stream', {
    schema: {
      description: 'Stream agent response via Server-Sent Events',
      tags: ['AgentOS'],
      querystring: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          mode: { type: 'string', description: 'Persona ID' },
          conversationId: { type: 'string' },
          messages: { type: 'string', description: 'JSON string of message history' },
          model: { type: 'string' },
          workflowRequest: { type: 'string', description: 'JSON string of workflow invocation request' },
          agencyRequest: { type: 'string', description: 'JSON string of agency invocation request' },
        }
      }
    }
  }, async (request, reply) => {
    const agentos = await getAgentOS();
    const { userId, mode, conversationId, messages, model, workflowRequest, agencyRequest } = request.query as any;
    
    // Manually set CORS headers because we are using reply.raw
    const origin = request.headers.origin || 'http://localhost:5175';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    let textInput = '';
    if (messages) {
        try {
            const parsedMessages = JSON.parse(messages);
            if (Array.isArray(parsedMessages) && parsedMessages.length > 0) {
                const lastMsg = parsedMessages[parsedMessages.length - 1];
                textInput = lastMsg.content;
            }
        } catch (e) {
            console.error('Failed to parse messages param', e);
        }
    }

    const parsedWorkflowRequest = parseJsonValue<WorkbenchWorkflowRequest>(workflowRequest);
    const parsedAgencyRequest = parseJsonValue<WorkbenchAgencyRequest>(agencyRequest);
    const runId =
      parsedWorkflowRequest?.workflowId ??
      parsedAgencyRequest?.workflowId ??
      parsedAgencyRequest?.agencyId ??
      conversationId;
    if (runId && (parsedWorkflowRequest || parsedAgencyRequest)) {
      graphRunStore.beginRun({
        runId,
        source: parsedAgencyRequest ? 'agency' : 'compose',
        goal:
          parsedAgencyRequest?.goal ??
          String(textInput || parsedWorkflowRequest?.metadata?.goal || 'Workbench stream'),
        workflowId: parsedWorkflowRequest?.definitionId ?? parsedAgencyRequest?.workflowId,
        conversationId,
      });
    }

    try {
        const iterator = agentos.processRequest(
          buildWorkbenchProcessRequestInput({
            userId,
            sessionId: conversationId,
            conversationId,
            selectedPersonaId: mode,
            textInput,
            model,
            workflowRequest: parsedWorkflowRequest,
            agencyRequest: parsedAgencyRequest,
          })
        );

        for await (const chunk of iterator) {
            if (chunk.type === 'workflow_update' && chunk.workflow) {
                syncPlanningStoreFromWorkflowSnapshot({
                  planId:
                    parsedWorkflowRequest?.workflowId ??
                    chunk.workflow.workflowId ??
                    conversationId ??
                    `workflow-${Date.now()}`,
                  goal:
                    parsedAgencyRequest?.goal ??
                    String((chunk.workflow.metadata?.goal ?? textInput) || 'Runtime workflow'),
                  workflowId: chunk.workflow.definitionId ?? parsedWorkflowRequest?.definitionId,
                  conversationId,
                  source: 'compose',
                  workflow: chunk.workflow,
                });
            }
            if (chunk.type === 'tool_call_request' && Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0 && runId) {
                graphRunStore.appendEvent(runId, {
                  type: 'tool_call_request',
                  summary: `Calling ${chunk.toolCalls[0]?.name ?? 'tool'}`,
                  payload: {
                    toolName: chunk.toolCalls[0]?.name ?? null,
                  },
                });
            }
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        if (runId) {
            graphRunStore.completeRun(runId);
        }
        reply.raw.write('event: done\ndata: {}\n\n');
    } catch (error: any) {
        console.error("Stream error:", error);
        if (runId) {
            graphRunStore.failRun(runId, error.message || 'Unknown error');
        }
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error.message || 'Unknown error' })}\n\n`);
    } finally {
        reply.raw.end();
    }
  });

  /**
   * List personas.
   */
  fastify.get('/personas', {
    schema: {
      description: 'List available personas',
      tags: ['AgentOS'],
      querystring: {
        type: 'object',
        properties: {
          userId: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            personas: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        }
      }
    }
  }, async (request) => {
    const agentos = await getAgentOS();
    const { userId } = request.query as any;
    const personas = await agentos.listAvailablePersonas(userId);
    return { personas };
  });

  fastify.get<{ Params: { conversationId: string }; Querystring: { userId?: string } }>('/conversations/:conversationId', {
    schema: {
      description: 'Get conversation history for a conversation id',
      tags: ['AgentOS'],
      params: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
        },
        required: ['conversationId'],
      },
      querystring: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          properties: {
            conversation: { type: ['object', 'null'], additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const agentos = await getAgentOS();
    const agentosWithHistory = agentos as unknown as {
      getConversationHistory?: (conversationId: string, userId: string) => Promise<unknown>;
    };

    if (typeof agentosWithHistory.getConversationHistory !== 'function') {
      return { conversation: null, unsupported: true };
    }

    try {
      const conversation = await agentosWithHistory.getConversationHistory(
        request.params.conversationId,
        request.query.userId || 'agentos-workbench-user'
      );

      return {
        conversation: serializeConversation(conversation),
        connected: true,
      };
    } catch (error) {
      return reply.code(200).send({
        conversation: null,
        connected: false,
        error: error instanceof Error ? error.message : 'Failed to fetch conversation history',
      });
    }
  });

  /**
   * List workflow definitions.
   */
  fastify.get('/workflows/definitions', {
    schema: {
      description: 'List available workflow definitions',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'object',
          properties: {
            definitions: { type: 'array', items: { type: 'object', additionalProperties: true } }
          }
        }
      }
    }
  }, async () => {
    const agentos = await getAgentOS();
    const definitions = agentos.listWorkflowDefinitions();
    return { definitions };
  });

  /**
   * Execute agency.
   */
  fastify.post('/agency/execute', {
    schema: {
      description: 'Execute an agency with multiple agents',
      tags: ['AgentOS'],
      body: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          agencyId: { type: 'string' },
          workflowId: { type: 'string' },
          agencyConfig: { type: 'object', additionalProperties: true },
          goal: { type: 'string' },
          input: {},
          outputFormat: { type: 'string' },
          participants: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            agencyId: { type: 'string' },
            content: { type: 'string' },
          }
        }
      }
    }
  }, async (request) => {
    const agentos = await getAgentOS();
    const body = request.body as {
      userId?: string;
      agencyId?: string;
      workflowId?: string;
      agencyConfig?: Record<string, unknown>;
      goal?: string;
      input?: unknown;
      outputFormat?: string;
      participants?: AgencyRoleDescriptor[];
    };
    const participants =
      Array.isArray(body.participants)
        ? body.participants
        : Array.isArray(body.agencyConfig?.participants)
          ? (body.agencyConfig?.participants as AgencyRoleDescriptor[])
          : [];
    const goal =
      typeof body.goal === 'string'
        ? body.goal
        : typeof body.agencyConfig?.goal === 'string'
          ? (body.agencyConfig.goal as string)
          : undefined;
    const { agencyRequest, selectedPersonaId } = buildAgencyRequestFromRoles({
      agencyId: body.agencyId ?? (typeof body.agencyConfig?.agencyId === 'string' ? (body.agencyConfig.agencyId as string) : undefined),
      workflowId: body.workflowId ?? (typeof body.agencyConfig?.workflowId === 'string' ? (body.agencyConfig.workflowId as string) : undefined),
      goal,
      outputFormat: body.outputFormat,
      roles: participants,
    });

    let fullText = '';
    const iterator = agentos.processRequest(
      buildWorkbenchProcessRequestInput({
        userId: body.userId,
        sessionId: undefined,
        conversationId: undefined,
        selectedPersonaId,
        textInput: coerceTextInput(body.input ?? goal),
        agencyRequest,
      })
    );

    for await (const chunk of iterator) {
      if (chunk.type === TEXT_DELTA_CHUNK_TYPE && chunk.textDelta) {
        fullText += chunk.textDelta;
      }
      if (chunk.type === ERROR_CHUNK_TYPE) {
        throw chunk;
      }
    }

    return {
      status: 'completed',
      agencyId: agencyRequest.agencyId ?? 'agency-workbench',
      content: fullText,
    };
  });

  /**
   * Stream agency execution (SSE).
   */
  fastify.get('/agency/stream', {
    schema: {
      description: 'Stream agency execution events via Server-Sent Events',
      tags: ['AgentOS'],
      querystring: {
        type: 'object',
        properties: {
          agencyId: { type: 'string' },
          userId: { type: 'string' },
          goal: { type: 'string' },
          conversationId: { type: 'string' },
          workflowId: { type: 'string' },
          roles: { type: 'string', description: 'JSON string of role descriptors' },
          outputFormat: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const agentos = await getAgentOS();
    const { agencyId, userId, goal, conversationId, workflowId, roles, outputFormat } = request.query as any;
    const parsedRoles = parseJsonValue<AgencyRoleDescriptor[]>(roles) ?? [];
    const { agencyRequest, selectedPersonaId } = buildAgencyRequestFromRoles({
      agencyId,
      workflowId,
      goal,
      outputFormat,
      roles: parsedRoles,
    });
    const origin = request.headers.origin || 'http://localhost:5175';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const agencyRunId = agencyRequest.workflowId ?? agencyRequest.agencyId ?? conversationId;
    if (agencyRunId) {
      graphRunStore.beginRun({
        runId: agencyRunId,
        source: 'agency',
        goal: goal ?? agencyRequest.goal ?? 'Agency execution',
        workflowId: agencyRequest.workflowId,
        conversationId,
      });
    }

    try {
      const iterator = agentos.processRequest(
        buildWorkbenchProcessRequestInput({
          userId,
          sessionId: conversationId,
          conversationId,
          selectedPersonaId,
          textInput: goal ?? '',
          agencyRequest,
        })
      );

      for await (const chunk of iterator) {
        if (chunk.type === 'workflow_update' && chunk.workflow) {
          syncPlanningStoreFromWorkflowSnapshot({
            planId: agencyRequest.workflowId ?? agencyRequest.agencyId ?? `agency-${Date.now()}`,
            goal: goal ?? agencyRequest.goal ?? 'Agency execution',
            workflowId: chunk.workflow.definitionId ?? agencyRequest.workflowId,
            conversationId,
            source: 'agency',
            workflow: chunk.workflow,
          });
        }
        if (chunk.type === 'tool_call_request' && Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0 && agencyRunId) {
          graphRunStore.appendEvent(agencyRunId, {
            type: 'tool_call_request',
            summary: `Calling ${chunk.toolCalls[0]?.name ?? 'tool'}`,
            payload: {
              toolName: chunk.toolCalls[0]?.name ?? null,
            },
          });
        }
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (agencyRunId) {
        graphRunStore.completeRun(agencyRunId);
      }
      reply.raw.write('event: done\ndata: {}\n\n');
    } catch (error: any) {
      if (agencyRunId) {
        graphRunStore.failRun(agencyRunId, error?.message || 'Unknown error');
      }
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error?.message || 'Unknown error' })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  /**
   * Stream agency workflow execution (SSE).
   */
  fastify.get('/agency/workflow/stream', {
    schema: {
      description: 'Stream agency workflow execution events via Server-Sent Events',
      tags: ['AgentOS'],
      querystring: {
        type: 'object',
        properties: {
          executionId: { type: 'string' },
          workflowId: { type: 'string' },
          userId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const agentos = await getAgentOS();
    const { executionId, workflowId, userId } = request.query as {
      executionId?: string;
      workflowId?: string;
      userId?: string;
    };
    const execution =
      (executionId ? pendingWorkflowExecutions.get(executionId) : undefined) ??
      (workflowId
        ? Array.from(pendingWorkflowExecutions.values()).find((candidate) => candidate.workflowId === workflowId)
        : undefined);
    const origin = request.headers.origin || 'http://localhost:5175';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    if (!execution) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: 'Workflow execution not found' })}\n\n`);
      reply.raw.end();
      return;
    }

    const { agencyRequest, selectedPersonaId } = buildAgencyRequestFromRoles({
      agencyId: execution.executionId,
      workflowId: execution.workflowId,
      goal: execution.topic,
      outputFormat: execution.outputFormat,
      roles: execution.roles,
    });
    const workflowRequest = {
      definitionId: execution.workflowId,
      workflowId: execution.executionId,
      conversationId: execution.conversationId,
      metadata: {
        source: 'agentos-workbench-parallel-demo',
      },
    };

    let lastWorkflowTasks: Record<string, string> = {};

    try {
      const iterator = agentos.processRequest(
        buildWorkbenchProcessRequestInput({
          userId: execution.userId ?? userId,
          sessionId: execution.conversationId,
          conversationId: execution.conversationId,
          selectedPersonaId,
          textInput: execution.topic,
          workflowRequest,
          agencyRequest,
        })
      );

      for await (const chunk of iterator) {
        if (chunk.type === 'workflow_update' && chunk.workflow?.tasks) {
          syncPlanningStoreFromWorkflowSnapshot({
            planId: execution.executionId,
            goal: execution.topic,
            workflowId: chunk.workflow.definitionId ?? execution.workflowId,
            conversationId: execution.conversationId,
            source: 'workflow',
            workflow: chunk.workflow,
          });
          const taskEntries = Object.entries(chunk.workflow.tasks) as Array<[string, WorkflowTaskSnapshotRecord]>;
          const completedCount = taskEntries.filter(([, task]) => {
            const status = String(task.status ?? '').toLowerCase();
            return status === 'completed' || status === 'complete';
          }).length;
          const progress = taskEntries.length > 0 ? Math.round((completedCount / taskEntries.length) * 100) : 0;

          for (const [taskId, taskSnapshot] of taskEntries) {
            const nextStatus = String(taskSnapshot.status ?? '').toLowerCase();
            const previousStatus = lastWorkflowTasks[taskId];
            if (nextStatus === previousStatus) {
              continue;
            }
            lastWorkflowTasks[taskId] = nextStatus;

            if (nextStatus === 'running' || nextStatus === 'in_progress') {
              reply.raw.write(
                `data: ${JSON.stringify({
                  type: 'task_start',
                  taskId,
                  executor: taskSnapshot.assignedRoleId ?? taskSnapshot.assignedExecutorId,
                  taskName: taskId,
                  progress,
                })}\n\n`
              );
            } else if (nextStatus === 'completed' || nextStatus === 'complete') {
              reply.raw.write(
                `data: ${JSON.stringify({
                  type: 'task_complete',
                  taskId,
                  executor: taskSnapshot.assignedRoleId ?? taskSnapshot.assignedExecutorId,
                  taskName: taskId,
                  progress,
                })}\n\n`
              );
            } else if (nextStatus === 'failed' || nextStatus === 'errored' || nextStatus === 'error') {
              reply.raw.write(
                `data: ${JSON.stringify({
                  type: 'task_error',
                  taskId,
                  executor: taskSnapshot.assignedRoleId ?? taskSnapshot.assignedExecutorId,
                  taskName: taskId,
                  error: taskSnapshot.error?.message ?? 'Task failed',
                  progress,
                })}\n\n`
              );
            }
          }
        }

        if (chunk.type === 'tool_call_request' && Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0) {
          graphRunStore.appendEvent(execution.executionId, {
            type: 'tool_call_request',
            summary: `Calling ${chunk.toolCalls[0]?.name ?? 'tool'}`,
            payload: {
              toolName: chunk.toolCalls[0]?.name ?? null,
            },
          });
          reply.raw.write(
            `data: ${JSON.stringify({
              type: 'agent_action',
              agentId: 'signals_researcher',
              action: `Calling ${chunk.toolCalls[0]?.name ?? 'tool'}`,
            })}\n\n`
          );
        }
      }

      graphRunStore.completeRun(execution.executionId);
      reply.raw.write(`data: ${JSON.stringify({ type: 'workflow_complete', progress: 100 })}\n\n`);
      reply.raw.write('event: done\ndata: {}\n\n');
    } catch (error: any) {
      graphRunStore.failRun(execution.executionId, error?.message || 'Unknown error');
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error?.message || 'Unknown error' })}\n\n`);
    } finally {
      pendingWorkflowExecutions.delete(execution.executionId);
      reply.raw.end();
    }
  });

  /**
   * List extensions.
   */
  fastify.get('/extensions', {
    schema: {
      description: 'List all available extensions',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              package: { type: 'string' },
              version: { type: 'string' },
              description: { type: 'string' },
              category: { type: 'string' },
              verified: { type: 'boolean' },
              installed: { type: 'boolean' },
              tools: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      }
    }
  }, async () => {
    const extensions = await listWorkbenchExtensions();
    return extensions.map((extension) => ({
      ...extension,
      installed: extension.installed || sessionInstalledExtensions.has(extension.id),
    }));
  });

  /**
   * List tools.
   */
  fastify.get('/extensions/tools', {
    schema: {
      description: 'List all available tools from extensions',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              extension: { type: 'string' },
              hasSideEffects: { type: 'boolean' }
            }
          }
        }
      }
    }
  }, async () => {
    return listWorkbenchTools();
  });

  /**
   * Install extension.
   *
   * In connected mode this would delegate to the AgentOS extension loader
   * (`npm install @framers/agentos-ext-{name}` or dynamic import).  In
   * standalone mode the install is simulated — the extension id is tracked
   * in an in-memory set so subsequent list calls reflect the new state.
   *
   * The response includes a `mode` field ('standalone' | 'connected') so
   * the frontend can display appropriate messaging about the install scope.
   */
  fastify.post('/extensions/install', {
    schema: {
      description: 'Install an extension (simulated in standalone mode, real in connected mode)',
      tags: ['AgentOS'],
      body: {
        type: 'object',
        properties: {
          extensionId: { type: 'string' },
          package: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            installed: { type: 'boolean' },
            mode: { type: 'string' },
            message: { type: 'string' },
          }
        }
      }
    }
  }, async (request) => {
    const body = request.body as { extensionId?: string; package?: string };
    const extensions = await listWorkbenchExtensions();
    const extension = extensions.find((entry) =>
      entry.id === body.extensionId ||
      entry.package === body.package
    );

    if (!extension) {
      return { success: false, installed: false, mode: 'standalone', message: 'Extension not found in registry.' };
    }

    // Attempt real runtime integration — check if the AgentOS instance has
    // an extension loader we can delegate to.
    try {
      const agentos = await getAgentOS();
      const extensionManager = typeof agentos.getExtensionManager === 'function'
        ? (agentos.getExtensionManager() as any)
        : null;
      if (extensionManager && typeof extensionManager.loadPackFromPackage === 'function') {
        await extensionManager.loadPackFromPackage(extension.package);
        return {
          success: true,
          installed: true,
          mode: 'connected',
          message: `Extension ${extension.name} loaded via AgentOS runtime.`,
        };
      }
    } catch {
      // Runtime not available or extension manager not exposed — fall through
    }

    // Standalone fallback: track install in session memory
    sessionInstalledExtensions.add(extension.id);
    return {
      success: true,
      installed: extension.installed || sessionInstalledExtensions.has(extension.id),
      mode: 'standalone',
      message: `Extension ${extension.name} marked as installed (simulated — standalone mode).`,
    };
  });

  /**
   * Execute tool.
   *
   * Attempts to delegate to the real AgentOS ToolOrchestrator.processToolCall()
   * when the runtime is available and the tool is registered.  Falls back to a
   * stub response in standalone mode.
   *
   * The response includes a `mode` field ('standalone' | 'connected') so the
   * frontend can distinguish between real and simulated execution results.
   */
  fastify.post('/tools/execute', {
    schema: {
      description: 'Execute a specific tool via the AgentOS runtime or return a stub in standalone mode',
      tags: ['AgentOS'],
      body: {
        type: 'object',
        properties: {
          toolId: { type: 'string' },
          params: { type: 'object', additionalProperties: true },
          input: { type: 'object', additionalProperties: true },
        },
        required: ['toolId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            result: {},
            toolId: { type: 'string' },
            mode: { type: 'string' },
            isError: { type: 'boolean' },
            echoedInput: { type: 'object', additionalProperties: true },
          }
        }
      }
    }
  }, async (request) => {
    const body = request.body as { toolId: string; params?: Record<string, unknown>; input?: Record<string, unknown> };
    const args = body.input ?? body.params ?? {};

    // Attempt real tool execution via the AgentOS ToolOrchestrator
    try {
      const agentos = await getAgentOS();
      const toolOrchestrator = typeof agentos.getToolOrchestrator === 'function'
        ? (agentos.getToolOrchestrator() as any)
        : null;
      if (toolOrchestrator && typeof toolOrchestrator.processToolCall === 'function') {
        const result = await toolOrchestrator.processToolCall({
          toolCallRequest: {
            id: `workbench-${Date.now()}`,
            name: body.toolId,
            arguments: args,
          },
          gmiId: 'workbench',
          personaId: 'default',
          personaCapabilities: {},
          userContext: { userId: 'workbench-user' },
        });

        return {
          result: result.output ?? result.errorDetails?.message ?? null,
          toolId: body.toolId,
          mode: 'connected',
          isError: Boolean(result.isError),
          echoedInput: args,
        };
      }
    } catch {
      // Runtime not available or tool orchestrator not exposed — fall through
    }

    // Standalone fallback
    return {
      result: 'Tool execution is stubbed in standalone mode.  Connect an AgentOS runtime with registered tools to enable live execution.',
      toolId: body.toolId,
      mode: 'standalone',
      isError: false,
      echoedInput: args,
    };
  });

  fastify.get('/graph-runs', {
    schema: {
      description: 'List persisted graph/workflow run records mirrored from AgentOS runtime streams',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
  }, async () => {
    return graphRunStore.listRuns();
  });

  fastify.get<{ Params: { runId: string } }>('/graph-runs/:runId', {
    schema: {
      description: 'Get a single graph/workflow run record by id',
      tags: ['AgentOS'],
      params: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
        },
        required: ['runId'],
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const run = graphRunStore.getRun(request.params.runId);
    if (!run) {
      return reply.status(404).send({ message: 'Graph run not found' });
    }
    return run;
  });

  fastify.post<{ Params: { runId: string; checkpointId: string } }>('/graph-runs/:runId/checkpoints/:checkpointId/restore', {
    schema: {
      description: 'Restore a persisted graph-run record to a recorded checkpoint snapshot',
      tags: ['AgentOS'],
      params: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          checkpointId: { type: 'string' },
        },
        required: ['runId', 'checkpointId'],
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const existing = graphRunStore.getRun(request.params.runId);
    if (!existing) {
      return reply.status(404).send({ message: 'Graph run not found' });
    }
    if (!graphRunStore.getCheckpoint(request.params.runId, request.params.checkpointId)) {
      return reply.status(404).send({ message: 'Checkpoint not found' });
    }
    const restored = graphRunStore.restoreCheckpoint(request.params.runId, request.params.checkpointId);
    if (!restored) {
      return reply.status(404).send({ message: 'Checkpoint not found' });
    }
    syncExistingRuntimePlanFromGraphRun(restored);
    return restored;
  });

  fastify.post<{ Params: { runId: string; checkpointId: string } }>('/graph-runs/:runId/checkpoints/:checkpointId/fork', {
    schema: {
      description: 'Fork a graph-run checkpoint into a new editable manual plan',
      tags: ['AgentOS'],
      params: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          checkpointId: { type: 'string' },
        },
        required: ['runId', 'checkpointId'],
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const run = graphRunStore.getRun(request.params.runId);
    if (!run) {
      return reply.status(404).send({ message: 'Graph run not found' });
    }
    const checkpoint = graphRunStore.getCheckpoint(request.params.runId, request.params.checkpointId);
    if (!checkpoint) {
      return reply.status(404).send({ message: 'Checkpoint not found' });
    }
    return createManualPlanFromGraphCheckpoint({ run, checkpoint });
  });

  fastify.get('/runtime', {
    schema: {
      description: 'Inspect AgentOS runtime availability, latest API exports, and workbench service wiring',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  }, async () => {
    const [moduleExports, packageVersion, extensions, tools, skills, guardrailExtensions] = await Promise.all([
      loadAgentOSModuleExports(),
      readAgentOSPackageVersion(),
      listWorkbenchExtensions(),
      listWorkbenchTools(),
      listWorkbenchSkills(),
      listGuardrailExtensions(),
    ]);
    const installedExtensionIds = new Set(
      extensions
        .filter((extension) => extension.installed)
        .map((extension) => extension.id)
    );
    for (const extensionId of sessionInstalledExtensions) {
      installedExtensionIds.add(extensionId);
    }

    let runtimeStatus: Record<string, unknown> = {
      connected: false,
      mode: 'standalone',
      services: {
        conversationManager: false,
        extensionManager: false,
        toolOrchestrator: false,
        modelProviderManager: false,
        retrievalAugmentor: false,
      },
      conversationManager: {
        activeConversations: 0,
      },
      providers: {
        configured: [],
        defaultProvider: null,
      },
    };

    try {
      const agentos = await getAgentOS();
      const runtimeSnapshot = typeof agentos.getRuntimeSnapshot === 'function'
        ? (await agentos.getRuntimeSnapshot() as any)
        : null;
      const conversationManager = typeof agentos.getConversationManager === 'function'
        ? (agentos.getConversationManager() as any)
        : null;
      const modelProviderManager = typeof agentos.getModelProviderManager === 'function'
        ? (agentos.getModelProviderManager() as any)
        : null;
      const defaultProvider = modelProviderManager?.getDefaultProvider?.() as { providerId?: string } | undefined;
      const conversationConfig = (conversationManager as any)?.config;
      const retrievalConnected =
        Boolean(runtimeSnapshot?.services.retrievalAugmentor) &&
        Boolean(defaultProvider?.providerId);

      runtimeStatus = {
        connected: Boolean(runtimeSnapshot),
        mode: 'connected',
        services: {
          conversationManager: runtimeSnapshot?.services.conversationManager ?? Boolean(conversationManager),
          extensionManager: runtimeSnapshot?.services.extensionManager ?? false,
          toolOrchestrator: runtimeSnapshot?.services.toolOrchestrator ?? false,
          modelProviderManager: runtimeSnapshot?.services.modelProviderManager ?? Boolean(modelProviderManager),
          retrievalAugmentor: retrievalConnected,
        },
        conversationManager: {
          managerId: (conversationManager as any)?.managerId ?? null,
          persistenceEnabled: conversationConfig?.persistenceEnabled ?? null,
          appendOnlyPersistence: conversationConfig?.appendOnlyPersistence ?? null,
          maxActiveConversationsInMemory:
            conversationConfig?.maxActiveConversationsInMemory ?? null,
          activeConversations: runtimeSnapshot?.conversations.activeCount ?? 0,
        },
        providers: {
          configured: runtimeSnapshot?.providers.configured ?? [],
          defaultProvider:
            runtimeSnapshot?.providers.defaultProvider ??
            defaultProvider?.providerId ??
            null,
        },
        capabilities: {
          processRequest: typeof agentos.processRequest === 'function',
          listAvailablePersonas: typeof agentos.listAvailablePersonas === 'function',
          listWorkflowDefinitions: typeof agentos.listWorkflowDefinitions === 'function',
          getConversationHistory: typeof agentos.getConversationHistory === 'function',
        },
        gmis: runtimeSnapshot?.gmis ?? { activeCount: 0, items: [] },
        extensions: runtimeSnapshot?.extensions ?? { loadedPacks: [], toolCount: 0, workflowCount: 0, guardrailCount: 0 },
      };
    } catch {
      // keep standalone fallback
    }

    return {
      packageVersion,
      modernApi: {
        generateText: typeof moduleExports?.generateText === 'function',
        streamText: typeof moduleExports?.streamText === 'function',
        generateImage: typeof moduleExports?.generateImage === 'function',
        agentFactory: typeof moduleExports?.agent === 'function',
      },
      orchestrationApi: {
        agentGraph: typeof moduleExports?.AgentGraph === 'function',
        workflowBuilder: typeof moduleExports?.workflow === 'function',
        missionBuilder: typeof moduleExports?.mission === 'function',
        graphRuntime: typeof moduleExports?.GraphRuntime === 'function',
        checkpointStore: typeof moduleExports?.InMemoryCheckpointStore === 'function',
      },
      catalogs: {
        skills: skills.length,
        extensions: extensions.length,
        installedExtensions: installedExtensionIds.size,
        tools: tools.length,
        guardrailPacksInstalled: guardrailExtensions.filter((extension) => extension.installed).length,
      },
      runtime: runtimeStatus,
      workbenchIntegration: {
        workflowDefinitions: true,
        workflowExecution: true,
        agencyExecution: true,
        planningDashboardBackedByRuntime: true,
        graphRunRecords: true,
        graphInspectionUi: true,
        checkpointResumeUi: true,
        note:
          'Compose streaming, /agency/stream, and the demo /agency/workflow/* routes forward workflow and agency context into AgentOS. The backend persists graph-run records from those streams, and the Planning panel can inspect runtime runs directly, restore persisted graph-run checkpoints, and fork them into editable manual plans. Graph-native authoring and true GraphRuntime pause/resume controls are still missing.',
      },
    };
  });

  /**
   * Start agency workflow.
   */
  fastify.post('/agency/workflow/start', {
    schema: {
      description: 'Start a new agency workflow',
      tags: ['AgentOS'],
      body: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          userId: { type: 'string' },
          input: {},
          config: { type: 'object', additionalProperties: true }
        },
        required: ['workflowId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            executionId: { type: 'string' },
            workflowId: { type: 'string' },
            conversationId: { type: 'string' },
          }
        }
      }
    }
  }, async (request) => {
    const body = request.body as {
      workflowId?: string;
      userId?: string;
      input?: Record<string, unknown>;
      config?: Record<string, unknown>;
    };
    const executionId = `workflow-exec-${Date.now()}`;
    const conversationId = `${executionId}-conversation`;
    const topic =
      typeof body.input?.topic === 'string'
        ? body.input.topic
        : typeof body.input?.goal === 'string'
          ? body.input.goal
          : 'Research and summarize the requested topic';
    const roles: AgencyRoleDescriptor[] = [
      {
        roleId: 'signals_researcher',
        personaId: 'v_researcher',
        instruction: 'Gather the most relevant signals and summarize them.',
        priority: 1,
      },
      {
        roleId: 'publishing_editor',
        personaId: 'v_researcher',
        instruction: 'Draft a crisp report from the gathered evidence.',
        priority: 2,
      },
    ];

    pendingWorkflowExecutions.set(executionId, {
      executionId,
      userId: body.userId,
      workflowId: body.workflowId ?? 'local.research-and-publish',
      topic,
      outputFormat: typeof body.input?.outputFormat === 'string' ? body.input.outputFormat : undefined,
      conversationId,
      roles,
    });
    graphRunStore.beginRun({
      runId: executionId,
      source: 'workflow',
      goal: topic,
      workflowId: body.workflowId ?? 'local.research-and-publish',
      conversationId,
    });

    return {
      status: 'started',
      executionId,
      workflowId: body.workflowId ?? 'local.research-and-publish',
      conversationId,
    };
  });



  /**
   * List models.
   */
  fastify.get('/models', {
    schema: {
      description: 'List all available LLM models',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'object',
          properties: {
            models: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  displayName: { type: 'string' },
                  provider: { type: 'string' },
                  pricing: {
                    type: 'object',
                    properties: {
                      inputCostPer1K: { type: 'number' },
                      outputCostPer1K: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async () => {
    return { models: mockModels };
  });

  // ---------------------------------------------------------------------------
  // Guardrail Pack endpoints
  // ---------------------------------------------------------------------------

  /**
   * In-memory guardrail configuration store.
   *
   * Holds the active security tier and the per-pack enable/disable state.
   * Persisted only for the lifetime of the process; a real implementation
   * would back this with a database row.
   */
  let guardrailTier: GuardrailTier = 'balanced';
  let guardrailPackState: Record<GuardrailPackId, boolean> = {
    ...TIER_GUARDRAIL_DEFAULTS.balanced,
  };

  /**
   * GET /guardrails — returns the current guardrail tier + pack configuration.
   */
  fastify.get('/guardrails', {
    schema: {
      description: 'Get the current guardrail tier and 5-pack configuration',
      tags: ['AgentOS'],
      response: {
        200: {
          type: 'object',
          properties: {
            tier:  { type: 'string' },
            packs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:          { type: 'string' },
                  name:        { type: 'string' },
                  package:     { type: 'string' },
                  description: { type: 'string' },
                  installed:   { type: 'boolean' },
                  enabled:     { type: 'boolean' },
                  verified:    { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const extensions = await listGuardrailExtensions();
    const packs = GUARDRAIL_PACK_ORDER.map((packId) => {
      const extension = extensions.find((entry) => entry.package.endsWith(packId));
      return {
        id: packId,
        package: extension?.package ?? `@framers/agentos-ext-${packId}`,
        name: extension?.name ?? packId,
        description: extension?.description ?? '',
        // Packs that migrated to standalone packages are absent from the
        // extensions registry — probe the standalone locations too.
        installed: isGuardrailPackInstalled(packId, extension?.installed),
        enabled: guardrailPackState[packId],
        verified: extension?.verified ?? false,
      };
    });

    return {
      tier: guardrailTier,
      packs,
    };
  });

  /**
   * POST /guardrails/configure — update the active tier and/or individual pack
   * enable states.
   *
   * Body fields are both optional:
   * - `tier`  — new security tier string
   * - `packs` — map of camelCase pack key → enabled boolean
   *             (e.g. `{ "piiRedaction": true, "codeSafety": false }`)
   *
   * Pack keys are matched by converting each pack's kebab-case id to camelCase
   * (e.g. `pii-redaction` → `piiRedaction`).
   */
  fastify.post('/guardrails/configure', {
    schema: {
      description: 'Update the guardrail tier and/or individual pack toggles',
      tags: ['AgentOS'],
      body: {
        type: 'object',
        properties: {
          tier:  { type: 'string' },
          packs: { type: 'object', additionalProperties: { type: 'boolean' } },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
  }, async (req) => {
    const body = req.body as { tier?: GuardrailTier; packs?: Record<string, boolean> };

    if (body.tier && body.tier in TIER_GUARDRAIL_DEFAULTS) {
      guardrailTier = body.tier;
      if (!body.packs) {
        guardrailPackState = { ...TIER_GUARDRAIL_DEFAULTS[body.tier] };
      }
    }

    if (body.packs) {
      for (const packId of GUARDRAIL_PACK_ORDER) {
        // Convert kebab-case id to camelCase to look up the incoming key.
        // e.g. "pii-redaction" → "piiRedaction"
        const camelKey = packId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        if (camelKey in body.packs) {
          guardrailPackState[packId] = body.packs[camelKey];
        }
      }
    }

    return { ok: true };
  });

  /**
   * List agency executions.
   */
  fastify.get('/agency/executions', {
    schema: {
      description: 'List all agency execution records',
      tags: ['AgentOS'],
      querystring: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          status: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            executions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agencyId: { type: 'string' },
                  workflowId: { type: 'string' },
                  userId: { type: 'string' },
                  status: { type: 'string' },
                  createdAt: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, async () => {
    return { executions: mockExecutions };
  });

  /**
   * Get specific agency execution.
   */
  fastify.get('/agency/executions/:agencyId', {
    schema: {
      description: 'Get details of a specific agency execution',
      tags: ['AgentOS'],
      params: {
        type: 'object',
        properties: {
          agencyId: { type: 'string' }
        },
        required: ['agencyId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            execution: {
              type: 'object',
              properties: {
                agencyId: { type: 'string' },
                workflowId: { type: 'string' },
                userId: { type: 'string' },
                status: { type: 'string' },
                createdAt: { type: 'string' }
              }
            },
            seats: { type: 'array', items: { type: 'object' } }
          }
        },
        404: {
          type: 'object',
          properties: {
            statusCode: { type: 'number' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, async (request) => {
    const { agencyId } = request.params as { agencyId: string };
    const execution = mockExecutions.find(e => e.agencyId === agencyId);
    if (!execution) {
      throw { statusCode: 404, message: 'Execution not found' };
    }
    return { execution, seats: [] };
  });

  // ---------------------------------------------------------------------------
  // Telemetry stubs — the frontend client expects these endpoints
  // ---------------------------------------------------------------------------

  /** GET /api/agentos/telemetry/task-outcomes — rolling window summaries */
  fastify.get('/telemetry/task-outcomes', async (request) => {
    const qs = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(qs.limit) || 10, 100);
    const page = Math.max(Number(qs.page) || 1, 1);
    return {
      windows: [],
      pagination: {
        page,
        limit,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        sortBy: qs.sortBy || 'updated_at',
        sortDir: qs.sortDir || 'desc',
      },
      totals: {
        windowCount: 0,
        returnedWindowCount: 0,
        sampleCount: 0,
        successCount: 0,
        partialCount: 0,
        failedCount: 0,
        successRate: 1,
        averageScore: 1,
        weightedSuccessRate: 1,
      },
      filters: {
        scopeMode: qs.scopeMode || null,
        organizationId: qs.organizationId || null,
        personaId: qs.personaId || null,
        scopeContains: qs.scopeContains || null,
        limit,
        page,
        sortBy: qs.sortBy || 'updated_at',
        sortDir: qs.sortDir || 'desc',
        includeEntries: qs.includeEntries === 'true',
      },
    };
  });

  /** GET /api/agentos/telemetry/config — runtime config */
  fastify.get('/telemetry/config', async () => {
    return {
      source: 'workbench-stub',
      tenantRouting: {
        mode: 'single_tenant',
        defaultOrganizationId: 'workbench',
        strictOrganizationIsolation: false,
      },
      taskOutcomeTelemetry: {
        enabled: true,
        rollingWindowSize: 20,
        scope: 'global',
        emitAlerts: true,
        alertBelowWeightedSuccessRate: 0.5,
        alertMinSamples: 3,
        alertCooldownMs: 60000,
      },
      adaptiveExecution: {
        enabled: false,
        minSamples: 5,
        minWeightedSuccessRate: 0.6,
        forceAllToolsWhenDegraded: false,
      },
      turnPlanning: {
        enabled: false,
      },
    };
  });

  /** GET /api/agentos/telemetry/alerts — paginated alert history */
  fastify.get('/telemetry/alerts', async (request) => {
    const qs = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(qs.limit) || 8, 100);
    const page = Math.max(Number(qs.page) || 1, 1);
    return {
      alerts: [],
      pagination: {
        page,
        limit,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        sortBy: qs.sortBy || 'alert_timestamp',
        sortDir: qs.sortDir || 'desc',
      },
      totals: {
        alertCount: 0,
        acknowledgedCount: 0,
        unacknowledgedCount: 0,
        criticalCount: 0,
      },
      filters: {
        scopeMode: qs.scopeMode || null,
        organizationId: qs.organizationId || null,
        personaId: qs.personaId || null,
        scopeContains: qs.scopeContains || null,
        severity: qs.severity || null,
        acknowledged: qs.acknowledged != null ? qs.acknowledged === 'true' : null,
        limit,
        page,
        sortBy: qs.sortBy || 'alert_timestamp',
        sortDir: qs.sortDir || 'desc',
      },
    };
  });

  /** POST /api/agentos/telemetry/alerts/:alertId/acknowledge */
  fastify.post('/telemetry/alerts/:alertId/acknowledge', async (request) => {
    const { alertId } = request.params as { alertId: string };
    const body = request.body as { acknowledged?: boolean; userId?: string } | undefined;
    return {
      alert: {
        alertId,
        scopeKey: 'global',
        scopeMode: 'global',
        organizationId: null,
        personaId: null,
        severity: 'info',
        reason: 'stub',
        threshold: 0,
        value: 0,
        sampleCount: 0,
        alertTimestamp: new Date().toISOString(),
        streamId: null,
        sessionId: null,
        gmiInstanceId: null,
        personaStreamId: null,
        acknowledgedAt: body?.acknowledged ? new Date().toISOString() : null,
        acknowledgedBy: body?.userId || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  });

  /** GET /api/agentos/telemetry/alerts/retention */
  fastify.get('/telemetry/alerts/retention', async () => {
    return {
      config: {
        enabled: true,
        retentionDays: 30,
        maxRows: 10000,
        pruneIntervalMs: 3600000,
      },
      lastPruneAt: null,
      pruneInFlight: false,
      lastSummary: null,
    };
  });

  /** POST /api/agentos/telemetry/alerts/prune */
  fastify.post('/telemetry/alerts/prune', async () => {
    const now = new Date().toISOString();
    const config = {
      enabled: true,
      retentionDays: 30,
      maxRows: 10000,
      pruneIntervalMs: 3600000,
    };
    return {
      summary: {
        config,
        deletedByAge: 0,
        deletedByOverflow: 0,
        totalDeleted: 0,
        remainingRows: 0,
        prunedAt: now,
      },
      status: {
        config,
        lastPruneAt: now,
        pruneInFlight: false,
        lastSummary: null,
      },
    };
  });
}
