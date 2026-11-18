import { agentOSConfig } from "@/lib/env";
import type { AgentOSPersonaSummary, AgentOSResponse } from "@/types/agentos";
import type { WorkflowDefinition } from "@/types/workflow";
import type {
  AgentOSStreamHandlers,
  AgentOSStreamParams,
  ConversationMessage,
  ListPersonaFilters
} from "@/lib/agentosTransport";
import { LOCAL_WORKFLOW_DEFINITIONS, createLocalWorkflowPack } from "@/lib/localWorkflowLibrary";
import { AgentOS, createCurrentDateTimeTool, DEFAULT_PROMPT_PROFILE_CONFIG } from "@framers/agentos";
import type {
  AgentOSConfig as CoreAgentOSConfig,
  AgentOSInput,
  AgentOSOrchestratorConfig,
  AIModelProviderManagerConfig,
  ConversationManagerConfig,
  GMIManagerConfig,
  PromptEngineConfig,
  StreamingManagerConfig,
  ToolOrchestratorConfig,
  ToolPermissionManagerConfig
} from "@framers/agentos";
import type { ExtensionManifest } from "@framers/agentos/extensions/manifest";
import type { IPersonaDefinition } from "@framers/agentos/cognition/substrate/personas/IPersonaDefinition";
import type { IPersonaLoader, PersonaLoaderConfig } from "@framers/agentos/cognition/substrate/personas/IPersonaLoader";
import { BUILT_IN_PERSONAS } from "@framers/agentos/cognition/substrate/personas/definitions";
import type { IAuthService, ISubscriptionService, ISubscriptionTier } from "@framers/agentos/services/user_auth/types";
import { PrismaClient } from "@prisma/client";
import { createDatabase, type StorageAdapter } from "@framers/sql-storage-adapter";

const DEFAULT_PERSONA_ID = "v_researcher";
const DEFAULT_USER_ID = agentOSConfig.defaultUserId ?? "agentos-workbench-user";

class LocalAuthService implements IAuthService {
  async validateToken(token: string): Promise<{ id: string } | null> {
    return { id: token || DEFAULT_USER_ID };
  }
}

class LocalSubscriptionService implements ISubscriptionService {
  private readonly tier: ISubscriptionTier = {
    name: "local",
    level: 0,
    features: ["local-runtime"],
    isActive: true
  };

  async getUserSubscription(): Promise<ISubscriptionTier> {
    return this.tier;
  }

  async validateAccess(): Promise<boolean> {
    return true;
  }
}

class EmbeddedPersonaLoader implements IPersonaLoader {
  private personas = new Map<string, IPersonaDefinition>();

  async initialize(_config: PersonaLoaderConfig): Promise<void> {
    this.personas = new Map(
      BUILT_IN_PERSONAS.map((definition) => [definition.id, JSON.parse(JSON.stringify(definition))])
    );
  }

  async loadPersonaById(personaId: string): Promise<IPersonaDefinition | undefined> {
    const definition = this.personas.get(personaId);
    return definition ? JSON.parse(JSON.stringify(definition)) : undefined;
  }

  async loadAllPersonaDefinitions(): Promise<IPersonaDefinition[]> {
    return Array.from(this.personas.values()).map((definition) => JSON.parse(JSON.stringify(definition)));
  }
}

const isBrowser = typeof window !== "undefined";

const buildProviderConfig = (secrets: Record<string, string>): AIModelProviderManagerConfig => {
  const entries: AIModelProviderManagerConfig["providers"] = [];

  if (secrets["openrouter.apiKey"]) {
    entries.push({
      providerId: "openrouter",
      enabled: true,
      isDefault: true,
      config: {
        apiKey: secrets["openrouter.apiKey"],
        baseURL: "https://openrouter.ai/api/v1",
        defaultModelId: "openrouter/google/gemini-flash-1.5"
      }
    });
  }

  if (secrets["openai.apiKey"]) {
    entries.push({
      providerId: "openai",
      enabled: true,
      config: {
        apiKey: secrets["openai.apiKey"],
        baseURL: "https://api.openai.com/v1",
        defaultModelId: "gpt-4o"
      }
    });
  }

  if (secrets["anthropic.apiKey"]) {
    entries.push({
      providerId: "anthropic",
      enabled: true,
      config: {
        apiKey: secrets["anthropic.apiKey"],
        baseURL: "https://api.anthropic.com",
        defaultModelId: "claude-sonnet-4-0"
      }
    });
  }

  if (!entries.some((entry) => entry.enabled)) {
    throw new Error(
      "Add at least one API key (OpenRouter, OpenAI, or Anthropic) in the Credentials panel to run the embedded runtime."
    );
  }

  if (!entries.some((entry) => entry.isDefault)) {
    entries[0]!.isDefault = true;
  }

  return { providers: entries };
};

const orchestratorConfig: AgentOSOrchestratorConfig = {
  maxToolCallIterations: 8,
  defaultAgentTurnTimeoutMs: 120_000,
  enableConversationalPersistence: true,
  promptProfileConfig: DEFAULT_PROMPT_PROFILE_CONFIG
};

const conversationManagerConfig: ConversationManagerConfig = {
  defaultConversationContextConfig: {
    maxHistoryLengthMessages: 50,
    enableAutomaticSummarization: true
  },
  maxActiveConversationsInMemory: 50,
  persistenceEnabled: true
};

const toolOrchestratorConfig: ToolOrchestratorConfig = {
  orchestratorId: "agentos-workbench-local",
  defaultToolCallTimeoutMs: 25_000,
  maxConcurrentToolCalls: 4,
  logToolCalls: false,
  globalDisabledTools: [],
  toolRegistrySettings: {
    allowDynamicRegistration: true,
    persistRegistry: false
  }
};

const toolPermissionManagerConfig: ToolPermissionManagerConfig = {
  strictCapabilityChecking: false,
  logToolCalls: false,
  toolToSubscriptionFeatures: {}
};

const promptEngineConfig: PromptEngineConfig = {
  defaultTemplateName: "openai_chat",
  availableTemplates: {},
  tokenCounting: {
    strategy: "estimated",
    estimationModel: "gpt-3.5-turbo"
  },
  historyManagement: {
    defaultMaxMessages: 40,
    maxTokensForHistory: 8_192,
    summarizationTriggerRatio: 0.8,
    preserveImportantMessages: true
  },
  contextManagement: {
    maxRAGContextTokens: 1_200,
    summarizationQualityTier: "balanced",
    preserveSourceAttributionInSummary: true
  },
  contextualElementSelection: {
    defaultMaxElementsPerType: 3,
    maxElementsPerType: {},
    priorityResolutionStrategy: "highest_first",
    conflictResolutionStrategy: "skip_conflicting"
  },
  performance: {
    enableCaching: true,
    cacheTimeoutSeconds: 120
  }
};

const streamingManagerConfig: StreamingManagerConfig = {
  maxConcurrentStreams: 16,
  defaultStreamInactivityTimeoutMs: 120_000,
  maxClientsPerStream: 2,
  onClientSendErrorBehavior: "log_and_continue"
};

const localWorkflowManifest: ExtensionManifest = {
  packs: [
    {
      factory: async () => createLocalWorkflowPack()
    }
  ]
};

const cloneWorkflowDefinitions = (): WorkflowDefinition[] =>
  LOCAL_WORKFLOW_DEFINITIONS.map((definition) => JSON.parse(JSON.stringify(definition)));

class EmbeddedRuntimeHost {
  private agentos: AgentOS | null = null;
  private storage: StorageAdapter | null = null;
  private initializing: Promise<void> | null = null;
  private configHash: string | null = null;

  private readonly authService: IAuthService = new LocalAuthService();
  private readonly subscriptionService: ISubscriptionService = new LocalSubscriptionService();
  private readonly prismaClient = new PrismaClient();
  private readonly personaLoader = new EmbeddedPersonaLoader();

  public openStream(params: AgentOSStreamParams, handlers: AgentOSStreamHandlers): () => void {
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    const boot = async () => {
      try {
        await this.ensureInitialized(params.userApiKeys ?? {});
        if (cancelled) {
          return;
        }
        cleanup = this.startStreaming(params, handlers);
      } catch (error) {
        if (!cancelled) {
          handlers.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    void boot();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }

  public listWorkflowDefinitions(): WorkflowDefinition[] {
    return cloneWorkflowDefinitions();
  }

  private async ensureInitialized(secrets: Record<string, string>): Promise<void> {
    const fingerprint = JSON.stringify(
      Object.entries(secrets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value?.trim() || ""])
    );

    if (this.agentos && this.configHash === fingerprint) {
      return;
    }

    if (this.initializing) {
      await this.initializing;
      if (this.agentos && this.configHash === fingerprint) {
        return;
      }
    }

    this.initializing = this.initializeRuntime(secrets, fingerprint);
    await this.initializing;
    this.initializing = null;
  }

  private async initializeRuntime(secrets: Record<string, string>, fingerprint: string): Promise<void> {
    await this.teardown();

    const storage = await createDatabase({
      priority: isBrowser ? ["indexeddb", "sqljs", "memory"] : ["memory"]
    });
    this.storage = storage;

    const providerConfig = buildProviderConfig(secrets);
    const defaultProvider =
      providerConfig.providers.find((entry) => entry.isDefault) ?? providerConfig.providers[0]!;
    const defaultModelId =
      typeof (defaultProvider.config as Record<string, unknown> | undefined)?.defaultModelId === "string"
        ? ((defaultProvider.config as Record<string, unknown>).defaultModelId as string)
        : undefined;

    const agentos = new AgentOS();
    const config: CoreAgentOSConfig = {
      gmiManagerConfig: this.buildGmiConfig(defaultProvider.providerId, defaultModelId),
      orchestratorConfig,
      promptEngineConfig,
      tools: [createCurrentDateTimeTool()],
      toolOrchestratorConfig,
      toolPermissionManagerConfig,
      conversationManagerConfig,
      streamingManagerConfig,
      modelProviderManagerConfig: providerConfig,
      defaultPersonaId: DEFAULT_PERSONA_ID,
      prisma: this.prismaClient,
      authService: this.authService,
      subscriptionService: this.subscriptionService,
      extensionManifest: localWorkflowManifest,
      extensionSecrets: Object.keys(secrets).length ? secrets : undefined,
      storageAdapter: storage,
      personaLoader: this.personaLoader
    };

    await agentos.initialize(config);
    this.agentos = agentos;
    this.configHash = fingerprint;
  }

  private buildGmiConfig(defaultProviderId: string, defaultModelId?: string): GMIManagerConfig {
    return {
      personaLoaderConfig: { personaSource: "embedded", loaderType: "in_memory" },
      defaultGMIBaseConfigDefaults: {
        defaultLlmProviderId: defaultProviderId,
        defaultLlmModelId: defaultModelId ?? "gpt-4o"
      }
    };
  }

  private startStreaming(params: AgentOSStreamParams, handlers: AgentOSStreamHandlers): () => void {
    const agentos = this.agentos!;
    const iterator = agentos.processRequest(this.buildAgentInput(params));
    let stopped = false;

    (async () => {
      try {
        for await (const chunk of iterator) {
          if (stopped) {
            break;
          }
          handlers.onChunk(chunk as AgentOSResponse);
        }
        if (!stopped) {
          handlers.onDone();
        }
      } catch (error) {
        handlers.onError(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return () => {
      stopped = true;
      void iterator.return?.();
    };
  }

  private buildAgentInput(params: AgentOSStreamParams): AgentOSInput {
    const latestMessage: ConversationMessage | undefined = params.messages[params.messages.length - 1];
    return {
      userId: params.userId ?? DEFAULT_USER_ID,
      sessionId: params.sessionId,
      conversationId: params.sessionId,
      selectedPersonaId: params.personaId ?? DEFAULT_PERSONA_ID,
      textInput: latestMessage?.content ?? null,
      userApiKeys: params.userApiKeys,
      workflowRequest: params.workflowRequest,
      agencyRequest: params.agencyRequest,
      options: {
        streamUICommands: true
      }
    };
  }

  private async teardown(): Promise<void> {
    if (this.agentos) {
      try {
        await this.agentos.shutdown();
      } catch (error) {
        console.warn("[AgentOS Client] Failed shutting down runtime", error);
      }
      this.agentos = null;
    }

    if (this.storage) {
      try {
        await this.storage.close();
      } catch (error) {
        console.warn("[AgentOS Client] Failed closing storage adapter", error);
      }
      this.storage = null;
    }
  }
}

const runtimeHost = new EmbeddedRuntimeHost();

export const openLocalAgentStream = (params: AgentOSStreamParams, handlers: AgentOSStreamHandlers): (() => void) => {
  const cleanup = runtimeHost.openStream(params, handlers);
  return cleanup;
};

const personaSummaries: AgentOSPersonaSummary[] = BUILT_IN_PERSONAS.map((definition) => ({
  id: definition.id,
  name: definition.name,
  displayName: definition.name,
  description: definition.description,
  tags: definition.tags,
  allowedCapabilities: definition.capabilities as string[] | undefined,
  requiredSecrets: definition.requiredSecrets,
  metadata: definition.metadata
}));

const matchesFilter = (summary: AgentOSPersonaSummary, filters?: ListPersonaFilters): boolean => {
  if (!filters) {
    return true;
  }

  if (filters.search) {
    const haystack = [summary.displayName, summary.description, summary.tags?.join(" ") ?? ""]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) {
      return false;
    }
  }

  if (filters.capability) {
    const required = Array.isArray(filters.capability) ? filters.capability : [filters.capability];
    const capabilities = summary.allowedCapabilities ?? [];
    if (!required.every((cap) => capabilities.includes(cap))) {
      return false;
    }
  }

  return true;
};

export const listLocalPersonas = (filters?: ListPersonaFilters): AgentOSPersonaSummary[] =>
  personaSummaries
    .filter((summary) => matchesFilter(summary, filters))
    .map((summary) => ({
      ...summary,
      tags: summary.tags ? [...summary.tags] : undefined,
      allowedCapabilities: summary.allowedCapabilities ? [...summary.allowedCapabilities] : undefined,
      requiredSecrets: summary.requiredSecrets ? [...summary.requiredSecrets] : undefined,
      metadata: summary.metadata ? { ...summary.metadata } : undefined
    }));

export const listLocalWorkflowDefinitions = (): WorkflowDefinition[] => runtimeHost.listWorkflowDefinitions();
