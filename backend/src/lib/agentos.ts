import * as path from 'path';
import * as dotenv from 'dotenv';
import { createWorkbenchCognitiveMemoryFactory } from './workbenchCognitiveMemory';
import { workbenchTools } from './workbenchTools';
import {
  WORKBENCH_RUNTIME_RAG_CHUNK_OVERLAP,
  WORKBENCH_RUNTIME_RAG_CHUNK_SIZE,
  WORKBENCH_RUNTIME_RAG_DATA_SOURCE_ID,
  WORKBENCH_RUNTIME_RAG_VECTOR_PERSIST_PATH,
  WORKBENCH_RUNTIME_RAG_PROVIDER_ID,
} from './workbenchRuntimeRag';

dotenv.config();

type AgentOSInstance = {
  initialize: (config: unknown) => Promise<void>;
  processRequest: (input: unknown) => AsyncGenerator<any>;
  listAvailablePersonas: (userId?: string) => Promise<unknown[]>;
  listWorkflowDefinitions: () => unknown[];
  getConversationHistory?: (conversationId: string, userId: string) => Promise<unknown>;
  getRuntimeSnapshot?: () => Promise<unknown>;
  getConversationManager?: () => unknown;
  getGMIManager?: () => unknown;
  getExtensionManager?: () => unknown;
  getToolOrchestrator?: () => unknown;
  getModelProviderManager?: () => unknown;
  shutdown?: () => Promise<void>;
};

type WorkbenchRetrievalAugmentor = {
  checkHealth?: () => Promise<unknown>;
  retrieveContext?: (queryText: string, options?: unknown) => Promise<unknown>;
  ingestDocuments?: (documents: unknown, options?: unknown) => Promise<unknown>;
  deleteDocuments?: (documentIds: string[], dataSourceId?: string, options?: unknown) => Promise<unknown>;
};

type WorkbenchVectorStoreManager = {
  listDataSourceIds?: () => string[];
  checkHealth?: (providerId?: string) => Promise<unknown>;
  getProvider?: (providerId: string) => unknown;
};

type WorkbenchModelProviderManager = {
  getDefaultProvider?: () => unknown;
  getProvider?: (providerId: string) => unknown;
};

// Mock Services
const mockAuthService = {
  validateToken: async (token: string) => ({ id: 'user-123' }),
};

const mockSubscriptionService = {
  getUserSubscription: async (userId: string) => ({ name: 'pro', level: 1, isActive: true }),
  validateAccess: async (userId: string, feature: string) => true,
};

const mockStorageAdapter = {
  run: async (sql: string, params: any) => ({ rows: [], columns: [] }),
  get: async (sql: string, params: any) => undefined,
  all: async (sql: string, params: any) => [],
  exec: async (sql: string) => {},
  close: async () => {},
  transaction: async (fn: any) => fn({
    run: async (sql: string, params: any) => ({ rows: [], columns: [] }),
    get: async (sql: string, params: any) => undefined,
    all: async (sql: string, params: any) => [],
    exec: async (sql: string) => {},
  }),
};

const mockPrisma = {} as any;

let agentosInstance: AgentOSInstance | null = null;
let initializationPromise: Promise<void> | null = null;
const runtimeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<{
  AgentOS: new () => AgentOSInstance;
} & Pick<typeof import('@framers/agentos'), 'createCurrentDateTimeTool' | 'DEFAULT_PROMPT_PROFILE_CONFIG'>>;

function hasUsableApiKey(value: string | undefined): boolean {
  const apiKey = value?.trim();
  return Boolean(apiKey && apiKey !== 'dummy-key');
}

export function resolveWorkbenchDefaultLlm(): { providerId: string; modelId: string } {
  if (hasUsableApiKey(process.env.OPENAI_API_KEY)) {
    return { providerId: 'openai', modelId: 'gpt-4o' };
  }

  if (hasUsableApiKey(process.env.ANTHROPIC_API_KEY)) {
    return { providerId: 'anthropic', modelId: 'claude-sonnet-4-0' };
  }

  if (hasUsableApiKey(process.env.GEMINI_API_KEY)) {
    return { providerId: 'google', modelId: 'gemini-2.0-flash' };
  }

  return { providerId: 'openai', modelId: 'gpt-4o' };
}

function shouldEnableWorkbenchRuntimeRag(): boolean {
  const runtimeToggle = (process.env.AGENTOS_WORKBENCH_ENABLE_RUNTIME_RAG ?? 'true').trim().toLowerCase();
  if (runtimeToggle === 'false' || runtimeToggle === '0' || runtimeToggle === 'off') {
    return false;
  }

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  return Boolean(openAiKey && openAiKey !== 'dummy-key');
}

function buildWorkbenchRagConfig() {
  if (!shouldEnableWorkbenchRuntimeRag()) {
    return undefined;
  }

  return {
    enabled: true,
    embeddingManagerConfig: {
      embeddingModels: [
        {
          modelId: 'text-embedding-3-small',
          providerId: 'openai',
          dimension: 1536,
          isDefault: true,
        },
      ],
    },
    vectorStoreManagerConfig: {
      managerId: 'agentos-workbench-rag-vsm',
      providers: [
        {
          id: WORKBENCH_RUNTIME_RAG_PROVIDER_ID,
          type: 'in_memory',
          persistPath: WORKBENCH_RUNTIME_RAG_VECTOR_PERSIST_PATH,
          defaultEmbeddingDimension: 1536,
          similarityMetric: 'cosine',
        },
      ],
      defaultProviderId: WORKBENCH_RUNTIME_RAG_PROVIDER_ID,
      defaultEmbeddingDimension: 1536,
    },
    dataSourceConfigs: [
      {
        dataSourceId: WORKBENCH_RUNTIME_RAG_DATA_SOURCE_ID,
        displayName: 'Workbench Runtime RAG',
        description: 'Runtime-backed retrieval snippets ingested from the AgentOS Workbench.',
        vectorStoreProviderId: WORKBENCH_RUNTIME_RAG_PROVIDER_ID,
        actualNameInProvider: WORKBENCH_RUNTIME_RAG_DATA_SOURCE_ID,
        embeddingDimension: 1536,
        isDefaultIngestionSource: true,
        isDefaultQuerySource: true,
      },
    ],
    retrievalAugmentorConfig: {
      defaultDataSourceId: WORKBENCH_RUNTIME_RAG_DATA_SOURCE_ID,
      defaultEmbeddingModelId: 'text-embedding-3-small',
      defaultQueryEmbeddingModelId: 'text-embedding-3-small',
      defaultChunkingStrategy: {
        type: 'fixed_size',
        chunkSize: WORKBENCH_RUNTIME_RAG_CHUNK_SIZE,
        chunkOverlap: WORKBENCH_RUNTIME_RAG_CHUNK_OVERLAP,
      },
      globalDefaultRetrievalOptions: {
        topK: 5,
        strategy: 'similarity',
      },
      categoryBehaviors: [],
    },
  };
}

async function createAgentOS(): Promise<AgentOSInstance> {
  const module = await runtimeImport('@framers/agentos');
  return new module.AgentOS() as AgentOSInstance;
}

export async function getAgentOS(): Promise<AgentOSInstance> {
  if (!agentosInstance) {
    agentosInstance = await createAgentOS();
  }
  return agentosInstance;
}

export async function initializeAgentOS() {
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  initializationPromise = (async () => {
    console.log('Initializing AgentOS...');

    // Resolve path to personas directory relative to this file
    // Assumes this file is in src/lib/ or dist/lib/ and personas is in backend/personas
    const personasPath = path.resolve(__dirname, '../../personas');
    console.log(`Loading personas from: ${personasPath}`);

    const agentos = await getAgentOS();
    const { createCurrentDateTimeTool, DEFAULT_PROMPT_PROFILE_CONFIG } = await runtimeImport('@framers/agentos');
    const ragConfig = buildWorkbenchRagConfig();
    const defaultLlm = resolveWorkbenchDefaultLlm();
    if (ragConfig) {
      console.log('AgentOS Workbench: runtime RAG bootstrap enabled.');
    } else {
      console.log('AgentOS Workbench: runtime RAG bootstrap disabled (missing key or env toggle).');
    }

    await agentos.initialize({
      authService: mockAuthService as any,
      subscriptionService: mockSubscriptionService as any,
      storageAdapter: mockStorageAdapter as any,
      prisma: mockPrisma,
      gmiManagerConfig: {
        personaLoaderConfig: {
          loaderType: 'file_system',
          personaSource: personasPath,
          personaDefinitionPath: personasPath,
        } as any,
        defaultGMIBaseConfigDefaults: {
          defaultLlmProviderId: defaultLlm.providerId,
          defaultLlmModelId: defaultLlm.modelId,
        },
        cognitiveMemoryFactory: createWorkbenchCognitiveMemoryFactory(),
      },
      orchestratorConfig: {
        promptProfileConfig: DEFAULT_PROMPT_PROFILE_CONFIG,
      },
      promptEngineConfig: {
        defaultTemplateName: 'default',
        availableTemplates: {
          default: async (components: any) => {
            const messages = [];
            if (components.systemPrompts && components.systemPrompts.length > 0) {
              messages.push({
                role: 'system' as const,
                content: components.systemPrompts.map((p: any) => p.content).join('\n'),
              });
            }
            if (components.conversationHistory) {
              for (const msg of components.conversationHistory) {
                if (msg.role === 'summary') continue;
                messages.push({
                  role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
                  content: msg.content,
                });
              }
            }
            if (components.userInput) {
              messages.push({ role: 'user' as const, content: components.userInput });
            }
            return messages;
          },
          // Override the built-in anthropic_messages template to return a flat
          // ChatMessage[] array that AnthropicProvider.buildRequestPayload expects,
          // instead of the { messages, system } object the built-in template returns.
          anthropic_messages: async (components: any) => {
            const messages: Array<{ role: string; content: any }> = [];
            if (components.systemPrompts && components.systemPrompts.length > 0) {
              messages.push({
                role: 'system',
                content: components.systemPrompts.map((p: any) => p.content).join('\n\n'),
              });
            }
            if (components.conversationHistory) {
              for (const msg of components.conversationHistory) {
                if (msg.role === 'summary') continue;
                messages.push({
                  role: msg.role === 'assistant' ? 'assistant' : 'user',
                  content: msg.content,
                });
              }
            }
            if (components.userInput) {
              messages.push({ role: 'user', content: components.userInput });
            }
            return messages;
          },
        },
        tokenCounting: {
          strategy: 'estimated',
        },
        performance: {
          enableCaching: false,
          cacheTimeoutSeconds: 0,
        },
        historyManagement: {
          defaultMaxMessages: 10,
          maxTokensForHistory: 2048,
          summarizationTriggerRatio: 0.8,
          preserveImportantMessages: true,
        },
        contextManagement: {
          maxRAGContextTokens: 2048,
          summarizationQualityTier: 'balanced',
          preserveSourceAttributionInSummary: true,
        },
        contextualElementSelection: {
          maxElementsPerType: {},
          defaultMaxElementsPerType: 3,
          priorityResolutionStrategy: 'highest_first',
          conflictResolutionStrategy: 'skip_conflicting',
        },
      },
      tools: {
        ...workbenchTools,
        getCurrentDateTime: createCurrentDateTimeTool(),
      },
      toolOrchestratorConfig: {} as any,
      toolPermissionManagerConfig: {} as any,
      conversationManagerConfig: {} as any,
      streamingManagerConfig: {} as any,
      ragConfig,
      defaultPersonaId: 'default',
      modelProviderManagerConfig: {
        providers: [
          {
            providerId: 'openai',
            enabled: true,
            config: {
              apiKey: process.env.OPENAI_API_KEY || 'dummy-key',
            },
            isDefault: !process.env.ANTHROPIC_API_KEY,
          },
          ...(process.env.ANTHROPIC_API_KEY ? [{
            providerId: 'anthropic' as const,
            enabled: true,
            config: {
              apiKey: process.env.ANTHROPIC_API_KEY,
            },
            isDefault: false,
          }] : []),
          ...(process.env.GEMINI_API_KEY ? [{
            providerId: 'google' as const,
            enabled: true,
            config: {
              apiKey: process.env.GEMINI_API_KEY,
            },
            isDefault: false,
          }] : []),
          ...(process.env.GROQ_API_KEY ? [{
            providerId: 'groq' as const,
            enabled: true,
            config: {
              apiKey: process.env.GROQ_API_KEY,
            },
            isDefault: false,
          }] : []),
        ],
      },
    });

    console.log('AgentOS Initialized');
  })();

  await initializationPromise;
}

export async function getAgentOSRagRuntime(): Promise<{
  agentos: AgentOSInstance;
  retrievalAugmentor: WorkbenchRetrievalAugmentor | null;
  vectorStoreManager: WorkbenchVectorStoreManager | null;
  modelProviderManager: WorkbenchModelProviderManager | null;
}> {
  const agentos = await getAgentOS();
  const runtime = agentos as AgentOSInstance & {
    retrievalAugmentor?: WorkbenchRetrievalAugmentor;
    ragVectorStoreManager?: WorkbenchVectorStoreManager;
  };

  return {
    agentos,
    retrievalAugmentor: runtime.retrievalAugmentor ?? null,
    vectorStoreManager: runtime.ragVectorStoreManager ?? null,
    modelProviderManager:
      typeof agentos.getModelProviderManager === 'function'
        ? (agentos.getModelProviderManager() as WorkbenchModelProviderManager)
        : null,
  };
}

export async function persistAgentOSRuntimeRag(): Promise<void> {
  const { vectorStoreManager } = await getAgentOSRagRuntime();
  const provider = vectorStoreManager?.getProvider?.(WORKBENCH_RUNTIME_RAG_PROVIDER_ID) as
    | {
        saveToFile?: (filePath: string) => Promise<void>;
      }
    | undefined;

  if (provider?.saveToFile) {
    await provider.saveToFile(WORKBENCH_RUNTIME_RAG_VECTOR_PERSIST_PATH);
  }
}

export async function shutdownAgentOS(): Promise<void> {
  if (!agentosInstance?.shutdown) {
    return;
  }
  await agentosInstance.shutdown();
}
