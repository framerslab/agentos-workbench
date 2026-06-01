import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SkipLink } from "@/components/SkipLink";
import { Sidebar } from "@/components/Sidebar";
import { RequestComposer, type RequestComposerPayload } from "@/components/RequestComposer";
import { AgencyComposer } from "@/components/AgencyComposer";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { eventBus } from "@/lib/eventBus";
import {
  openAgentOSStream,
  getAvailableModels,
  getRuntimeStatus,
  getTaskOutcomeTelemetry,
  getTaskOutcomeTelemetryConfig,
  getTaskOutcomeAlertHistory,
  getTaskOutcomeAlertRetentionStatus,
  pruneTaskOutcomeAlertHistory,
  setTaskOutcomeAlertAcknowledged,
  resolveWorkbenchApiBaseUrl,
  type AgentRoleConfig,
  type AgentOSModelInfo,
  type RuntimeStatusResponse,
  type TaskOutcomeAlertHistoryResponse,
  type TaskOutcomeAlertRetentionStatus,
  type TaskOutcomeAlertRetentionSummary,
  type TaskOutcomeRuntimeConfigResponse,
  type TaskOutcomeTelemetryResponse
} from "@/lib/agentosClient";
import { bootstrapStorage, deleteSessionRow, persistSessionEventRow, persistSessionRow } from "@/lib/storageBridge";
import { useUiStore } from "@/state/uiStore";
import { usePersonas } from "@/hooks/usePersonas";
import { useSystemTheme } from "@/hooks/useSystemTheme";
import { useSessionStore, type AgentSession, type SessionEvent, type SessionUpdate } from "@/state/sessionStore";
import { useTelemetryStore } from "@/state/telemetryStore";
import { AlertTriangle, Menu, X } from "lucide-react";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  AgentOSChunkType,
  type AgentOSAgencyUpdateChunk,
  type AgentOSTaskOutcomeAlert,
  type AgentOSWorkflowUpdateChunk,
} from "@/types/agentos";
import {
  toAlertHistoryFilterParams,
  type AlertAckFilter,
  type AlertSeverityFilter,
} from "@/lib/taskOutcomeHealthFilters";
import {
  DATA_MODE_LABELS,
  getWorkbenchSurfaceStatus,
  getWorkbenchWorkspaceStatus,
} from "@/lib/workbenchStatus";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

const SessionInspector = lazy(async () => ({ default: (await import("@/components/SessionInspector")).SessionInspector }));
const AgencyManager = lazy(async () => ({ default: (await import("@/components/AgencyManager")).AgencyManager }));
const PersonaCatalog = lazy(async () => ({ default: (await import("@/components/PersonaCatalog")).PersonaCatalog }));
const WorkflowOverview = lazy(async () => ({ default: (await import("@/components/WorkflowOverview")).WorkflowOverview }));
const EvaluationDashboard = lazy(() => import("@/components/EvaluationDashboard"));
const PlanningDashboard = lazy(async () => ({ default: (await import("@/components/PlanningDashboard")).PlanningDashboard }));
const MemoryDashboard = lazy(async () => ({ default: (await import("@/components/MemoryDashboard")).MemoryDashboard }));
const VoicePipelinePanel = lazy(async () => ({ default: (await import("@/components/VoicePipelinePanel")).VoicePipelinePanel }));
const AgencyStrategyPanel = lazy(async () => ({ default: (await import("@/components/AgencyStrategyPanel")).AgencyStrategyPanel }));
const ResourceControlsPanel = lazy(async () => ({ default: (await import("@/components/ResourceControlsPanel")).ResourceControlsPanel }));
const StructuredOutputBuilder = lazy(async () => ({ default: (await import("@/components/StructuredOutputBuilder")).StructuredOutputBuilder }));
const LiveHITLQueue = lazy(async () => ({ default: (await import("@/components/LiveHITLQueue")).LiveHITLQueue }));
const CapabilityDiscoveryBrowser = lazy(async () => ({ default: (await import("@/components/CapabilityDiscoveryBrowser")).CapabilityDiscoveryBrowser }));
const MarketplaceBrowser = lazy(async () => ({ default: (await import("@/components/MarketplaceBrowser")).MarketplaceBrowser }));
const GraphBuilder = lazy(async () => ({ default: (await import("@/components/GraphBuilder")).GraphBuilder }));
const EmergentToolForge = lazy(async () => ({ default: (await import("@/components/EmergentToolForge")).EmergentToolForge }));
const ChannelsManager = lazy(async () => ({ default: (await import("@/components/ChannelsManager")).ChannelsManager }));
const SocialPostComposer = lazy(async () => ({ default: (await import("@/components/SocialPostComposer")).SocialPostComposer }));
const VoiceCallMonitor = lazy(async () => ({ default: (await import("@/components/VoiceCallMonitor")).VoiceCallMonitor }));
const GuardrailEvaluator = lazy(async () => ({ default: (await import("@/components/GuardrailEvaluator")).GuardrailEvaluator }));
const ObservabilityDashboard = lazy(async () => ({ default: (await import("@/components/ObservabilityDashboard")).ObservabilityDashboard }));
const VisionPipelinePanel = lazy(async () => ({ default: (await import("@/components/VisionPipelinePanel")).VisionPipelinePanel }));
const ImageEditingPanel = lazy(async () => ({ default: (await import("@/components/ImageEditingPanel")).ImageEditingPanel }));
const LLMProviderPanel = lazy(async () => ({ default: (await import("@/components/LLMProviderPanel")).LLMProviderPanel }));
const RagWorkspace = lazy(async () => ({ default: (await import("@/components/RagWorkspace")).RagWorkspace }));
const HomeDashboard = lazy(async () => ({ default: (await import("@/components/HomeDashboard")).HomeDashboard }));
const AgentPlayground = lazy(async () => ({ default: (await import("@/components/AgentPlayground")).AgentPlayground }));
const PromptWorkspace = lazy(async () => ({ default: (await import("@/components/PromptWorkspace")).PromptWorkspace }));
const TourOverlay = lazy(async () => ({ default: (await import("@/components/TourOverlay")).TourOverlay }));
const ThemePanel = lazy(async () => ({ default: (await import("@/components/ThemePanel")).ThemePanel }));
const AboutPanel = lazy(async () => ({ default: (await import("@/components/AboutPanel")).AboutPanel }));
const SettingsPanel = lazy(async () => ({ default: (await import("@/components/SettingsPanel")).SettingsPanel }));
const ImportWizard = lazy(async () => ({ default: (await import("@/components/ImportWizard")).ImportWizard }));
const CommandPalette = lazy(async () => ({ default: (await import("@/components/CommandPalette")).CommandPalette }));

type LiveTaskOutcomeAlert = AgentOSTaskOutcomeAlert & {
  id: string;
  sessionId: string;
  receivedAt: number;
};

type TaskOutcomeHealthScopeJump = {
  scope: string;
  token: number;
};

function SuspensePanel({
  label,
  children,
  lines = 10,
}: {
  label: string;
  children: ReactNode;
  lines?: number;
}) {
  return (
    <ErrorBoundary label={label}>
      <Suspense
        fallback={(
          <div className="card-panel--strong p-4 transition-theme">
            <LoadingSkeleton withHeader lines={lines} />
          </div>
        )}
      >
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toAlertPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const normalized = Math.max(0, Math.min(1, value));
  return `${Math.round(normalized * 100)}%`;
}

function extractTaskOutcomeAlert(chunk: unknown): AgentOSTaskOutcomeAlert | null {
  const parsedChunk = asRecord(chunk);
  if (!parsedChunk) return null;
  if (parsedChunk.type !== AgentOSChunkType.METADATA_UPDATE) return null;

  const updates = asRecord(parsedChunk.updates);
  if (!updates) return null;
  const rawAlert = asRecord(updates.taskOutcomeAlert);
  if (!rawAlert) return null;

  const scopeKey = typeof rawAlert.scopeKey === "string" ? rawAlert.scopeKey.trim() : "";
  if (!scopeKey) return null;

  const severityRaw = typeof rawAlert.severity === "string" ? rawAlert.severity.trim() : "warning";
  const severity = severityRaw.length > 0 ? severityRaw : "warning";
  const reason =
    typeof rawAlert.reason === "string" && rawAlert.reason.trim().length > 0
      ? rawAlert.reason.trim()
      : "Task outcome KPI dropped below threshold.";
  const threshold =
    typeof rawAlert.threshold === "number" && Number.isFinite(rawAlert.threshold)
      ? Math.max(0, Math.min(1, rawAlert.threshold))
      : 0;
  const value =
    typeof rawAlert.value === "number" && Number.isFinite(rawAlert.value)
      ? Math.max(0, Math.min(1, rawAlert.value))
      : 0;
  const sampleCount =
    typeof rawAlert.sampleCount === "number" && Number.isFinite(rawAlert.sampleCount)
      ? Math.max(0, Math.round(rawAlert.sampleCount))
      : 0;
  const timestamp =
    typeof rawAlert.timestamp === "string" && rawAlert.timestamp.trim().length > 0
      ? rawAlert.timestamp
      : new Date().toISOString();

  return {
    scopeKey,
    severity,
    reason,
    threshold,
    value,
    sampleCount,
    timestamp,
  };
}

function TelemetryView() {
  const perSession = useTelemetryStore((s) => s.perSession);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const m = activeSessionId ? perSession[activeSessionId] : undefined;
  if (!m) return <p className="text-[10px] theme-text-secondary">No telemetry yet.</p>;
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-[10px] theme-text-secondary">
      <div><dt className="theme-text-muted">Chunks</dt><dd className="font-semibold theme-text-primary">{m.chunks ?? 0}</dd></div>
      <div><dt className="theme-text-muted">Chars</dt><dd className="font-semibold theme-text-primary">{m.textDeltaChars ?? 0}</dd></div>
      <div><dt className="theme-text-muted">Tools</dt><dd className="font-semibold theme-text-primary">{m.toolCalls ?? 0}</dd></div>
      <div><dt className="theme-text-muted">Errors</dt><dd className="font-semibold theme-text-primary">{m.errors ?? 0}</dd></div>
      <div><dt className="theme-text-muted">Duration</dt><dd className="font-semibold theme-text-primary">{m.durationMs ? `${Math.round(m.durationMs)}ms` : '-'}</dd></div>
      <div><dt className="theme-text-muted">Tokens</dt><dd className="font-semibold theme-text-primary">{m.finalTokensTotal ?? '-'}</dd></div>
    </dl>
  );
}

function AnalyticsView({
  selectedModel,
  onChangeModel,
  modelOptions,
  modelData
}: {
  selectedModel?: string;
  onChangeModel: (model?: string) => void;
  modelOptions: string[];
  modelData: AgentOSModelInfo[];
}) {
  const perSession = useTelemetryStore((s) => s.perSession);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const m = activeSessionId ? perSession[activeSessionId] : undefined;
  const tokens = m?.finalTokensTotal ?? 0;
  const promptTokens = m?.finalTokensPrompt ?? 0;
  const completionTokens = m?.finalTokensCompletion ?? 0;
  
  const currentModelData = modelData.find(model => model.id === selectedModel);
  const systemDefaultModel = modelData.find(model => model.id === 'gpt-4o') || modelData.find(model => model.id === 'gpt-4o-mini') || modelData[0];
  
  const estimateUsd = (promptTokens: number, completionTokens: number, model?: string) => {
    const modelInfo = modelData.find(m => m.id === model);
    const inputRate = modelInfo?.pricing?.inputCostPer1K ?? 0.0005;
    const outputRate = modelInfo?.pricing?.outputCostPer1K ?? 0.0015;
    const inputCost = (promptTokens / 1000) * inputRate;
    const outputCost = (completionTokens / 1000) * outputRate;
    return inputCost + outputCost;
  };
  
  const cost = estimateUsd(promptTokens, completionTokens, selectedModel);
  
  return (
    <div className="text-[10px] theme-text-secondary space-y-1">
      <label className="block">
        <select
          value={selectedModel || ''}
          onChange={(e) => onChangeModel(e.target.value || undefined)}
          className="w-full rounded-md border theme-border bg-[color:var(--color-background-secondary)] px-1.5 py-0.5 text-[10px] theme-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <option value="">
            Default ({systemDefaultModel?.displayName || systemDefaultModel?.id || 'gpt-4o-mini'})
          </option>
          {modelOptions.map((m) => {
            const modelInfo = modelData.find(model => model.id === m);
            return (
              <option key={m} value={m}>
                {modelInfo?.displayName || m} {selectedModel === m ? '(current)' : ''}
              </option>
            );
          })}
        </select>
      </label>
      {currentModelData && (
        <div className="theme-text-muted">
          {currentModelData.provider} | In: ${(currentModelData.pricing?.inputCostPer1K || 0).toFixed(4)}/1K | Out: ${(currentModelData.pricing?.outputCostPer1K || 0).toFixed(4)}/1K
        </div>
      )}
      <div>Tokens: {tokens || '-'} (P:{promptTokens || '-'} C:{completionTokens || '-'}) | Cost: {tokens ? `$${cost.toFixed(4)}` : '-'}</div>
    </div>
  );
}

function TaskOutcomeHealthView({
  liveAlertCount,
  scopeJump,
}: {
  liveAlertCount: number;
  scopeJump: TaskOutcomeHealthScopeJump | null;
}) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = useSessionStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  );
  const [scopeMode, setScopeMode] = useState<"all" | "global" | "organization" | "organization_persona">("all");
  const [scopeContains, setScopeContains] = useState("");
  const [sortBy, setSortBy] = useState<"updated_at" | "weighted_success_rate" | "sample_count" | "scope_key">("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [alertSeverityFilter, setAlertSeverityFilter] = useState<AlertSeverityFilter>("all");
  const [alertAckFilter, setAlertAckFilter] = useState<AlertAckFilter>("all");
  const [page, setPage] = useState(1);
  const [limit, _setLimit] = useState(6);
  const [snapshot, setSnapshot] = useState<TaskOutcomeTelemetryResponse | null>(null);
  const [alertSnapshot, setAlertSnapshot] = useState<TaskOutcomeAlertHistoryResponse | null>(null);
  const [retentionStatus, setRetentionStatus] = useState<TaskOutcomeAlertRetentionStatus | null>(null);
  const [_lastPruneSummary, setLastPruneSummary] = useState<TaskOutcomeAlertRetentionSummary | null>(null);
  const [config, setConfig] = useState<TaskOutcomeRuntimeConfigResponse | null>(null);
  const [acknowledgingAlertId, setAcknowledgingAlertId] = useState<string | null>(null);
  const [pruningAlerts, setPruningAlerts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scopeModeParam = scopeMode === "all" ? undefined : scopeMode;
  const normalizedScopeContains = scopeContains.trim();
  const alertHistoryParams = toAlertHistoryFilterParams(alertSeverityFilter, alertAckFilter);

  useEffect(() => {
    if (!scopeJump?.scope) return;
    setScopeMode("all");
    setScopeContains(scopeJump.scope);
    setPage(1);
  }, [scopeJump?.token, scopeJump?.scope]);

  const loadHealth = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const [nextSnapshot, nextConfig, nextAlertSnapshot, nextRetentionStatus] = await Promise.all([
          getTaskOutcomeTelemetry({
            scopeMode: scopeModeParam,
            scopeContains: normalizedScopeContains || undefined,
            sortBy,
            sortDir,
            page,
            limit,
          }),
          getTaskOutcomeTelemetryConfig(),
          getTaskOutcomeAlertHistory({
            scopeMode: scopeModeParam,
            scopeContains: normalizedScopeContains || undefined,
            severity: alertHistoryParams.severity,
            acknowledged: alertHistoryParams.acknowledged,
            limit: 8,
            page: 1,
            sortBy: "alert_timestamp",
            sortDir: "desc",
          }),
          getTaskOutcomeAlertRetentionStatus(),
        ]);
        if (!mountedRef.current) return;
        setSnapshot(nextSnapshot);
        setConfig(nextConfig);
        setAlertSnapshot(nextAlertSnapshot);
        setRetentionStatus(nextRetentionStatus);
        setLastPruneSummary(nextRetentionStatus.lastSummary);
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to fetch task outcome health");
      } finally {
        if (!silent && mountedRef.current) setLoading(false);
      }
    },
    [
      alertHistoryParams.acknowledged,
      alertHistoryParams.severity,
      normalizedScopeContains,
      scopeModeParam,
      sortBy,
      sortDir,
      page,
      limit,
    ]
  );

  useEffect(() => {
    void loadHealth();
    const timer = window.setInterval(() => {
      void loadHealth(true);
    }, 15000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeSessionId, loadHealth]);

  const totals = snapshot?.totals;
  const windows = snapshot?.windows ?? [];
  const persistedAlerts = alertSnapshot?.alerts ?? [];
  const unacknowledgedPersistedAlerts = alertSnapshot?.totals.unacknowledgedCount ?? 0;
  const pagination = snapshot?.pagination;
  const degradedWindows = windows
    .slice()
    .sort((a, b) => a.weightedSuccessRate - b.weightedSuccessRate)
    .slice(0, 3);
  const activePersonaId = activeSession?.personaId;
  const activePersonaWindow =
    activePersonaId && windows.length > 0
      ? windows.find((window) => window.personaId === activePersonaId) ?? null
      : null;
  const threshold = config?.taskOutcomeTelemetry.alertBelowWeightedSuccessRate ?? 0.55;
  const thresholdPercent = `${Math.round(threshold * 100)}%`;

  const handleAcknowledgeToggle = useCallback(
    async (alertId: string, acknowledged: boolean) => {
      setAcknowledgingAlertId(alertId);
      setError(null);
      try {
        await setTaskOutcomeAlertAcknowledged(alertId, acknowledged);
        if (!mountedRef.current) return;
        await loadHealth(true);
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to update alert acknowledgement");
      } finally {
        if (mountedRef.current) {
          setAcknowledgingAlertId(null);
        }
      }
    },
    [loadHealth]
  );

  const handlePruneAlerts = useCallback(async () => {
    setPruningAlerts(true);
    setError(null);
    try {
      const result = await pruneTaskOutcomeAlertHistory();
      if (!mountedRef.current) return;
      setLastPruneSummary(result.summary);
      setRetentionStatus(result.status);
      await loadHealth(true);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to prune alert history");
    } finally {
      if (mountedRef.current) {
        setPruningAlerts(false);
      }
    }
  }, [loadHealth]);

  return (
    <div className="space-y-1 text-[10px] theme-text-secondary max-h-36 overflow-y-auto">
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        <div className="flex justify-between"><span>Alerts</span><span className="font-semibold theme-text-primary">{liveAlertCount}</span></div>
        <div className="flex justify-between"><span>Unacked</span><span className="font-semibold theme-text-primary">{unacknowledgedPersistedAlerts}</span></div>
        <div className="flex justify-between"><span>Success</span><span className="font-semibold theme-text-primary">{totals ? `${Math.round(totals.weightedSuccessRate * 100)}%` : "—"}</span></div>
        <div className="flex justify-between"><span>Samples</span><span className="font-semibold theme-text-primary">{totals?.sampleCount ?? "—"}</span></div>
        <div className="flex justify-between"><span>Threshold</span><span className="font-semibold theme-text-primary">{thresholdPercent}</span></div>
        <div className="flex justify-between"><span>Fail mode</span><span className="font-semibold theme-text-primary">{config?.turnPlanning.defaultToolFailureMode ?? "fail_open"}</span></div>
      </div>
      <details className="text-[10px]">
        <summary className="cursor-pointer select-none theme-text-muted hover:theme-text-secondary">Filters &amp; config</summary>
        <div className="mt-1 space-y-1">
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            <div className="flex justify-between"><span>Discovery</span><span className="font-semibold theme-text-primary">{config?.turnPlanning.discovery?.defaultToolSelectionMode ?? "discovered"}</span></div>
            <div className="flex justify-between"><span>Recall</span><span className="font-semibold theme-text-primary">{config?.turnPlanning.discovery?.recallProfile ?? "aggressive"}</span></div>
            <div className="flex justify-between"><span>Force fail-open</span><span className="font-semibold theme-text-primary">{config?.adaptiveExecution.forceFailOpenWhenDegraded !== false ? "on" : "off"}</span></div>
            <div className="flex justify-between"><span>Tenant</span><span className="font-semibold theme-text-primary">{config?.tenantRouting.mode ?? "—"}</span></div>
          </div>
          <div className="grid grid-cols-4 gap-1 pt-0.5">
            <select value={scopeMode} onChange={(event) => { setScopeMode(event.target.value as typeof scopeMode); setPage(1); }} className="rounded border theme-border bg-[color:var(--color-background-secondary)] px-1 py-0.5 text-[10px] theme-text-primary" title="Scope">
              <option value="all">All</option><option value="global">Global</option><option value="organization">Org</option><option value="organization_persona">Org+P</option>
            </select>
            <select value={sortBy} onChange={(event) => { setSortBy(event.target.value as typeof sortBy); setPage(1); }} className="rounded border theme-border bg-[color:var(--color-background-secondary)] px-1 py-0.5 text-[10px] theme-text-primary" title="Sort by">
              <option value="updated_at">Updated</option><option value="weighted_success_rate">Success</option><option value="sample_count">Samples</option><option value="scope_key">Scope</option>
            </select>
            <select value={sortDir} onChange={(event) => { setSortDir(event.target.value as "asc" | "desc"); setPage(1); }} className="rounded border theme-border bg-[color:var(--color-background-secondary)] px-1 py-0.5 text-[10px] theme-text-primary" title="Direction">
              <option value="desc">Desc</option><option value="asc">Asc</option>
            </select>
            <input value={scopeContains} onChange={(event) => { setScopeContains(event.target.value); setPage(1); }} placeholder="scope" className="rounded border theme-border bg-[color:var(--color-background-secondary)] px-1 py-0.5 text-[10px] theme-text-primary" title="Filter scope" />
          </div>
        </div>
      </details>
      {(windows.length > 0 || activePersonaId || degradedWindows.length > 0) && (
        <details className="text-[10px]">
          <summary className="cursor-pointer select-none theme-text-muted hover:theme-text-secondary">Scopes &amp; windows</summary>
          <div className="mt-1 space-y-0.5">
            {activePersonaId && (
              <div className="flex justify-between"><span>Active persona</span><span className="font-semibold theme-text-primary">{activePersonaWindow ? `${Math.round(activePersonaWindow.weightedSuccessRate * 100)}% (${activePersonaWindow.sampleCount})` : "—"}</span></div>
            )}
            {windows.map((window) => (
              <div key={window.scopeKey} className="flex justify-between"><span className="truncate pr-1">{window.scopeKey}</span><span className="font-semibold theme-text-primary">{Math.round(window.weightedSuccessRate * 100)}%/{window.sampleCount}</span></div>
            ))}
            {degradedWindows.length > 0 && (
              <>
                <p className="theme-text-muted pt-0.5">Degraded:</p>
                {degradedWindows.map((window) => (
                  <div key={window.scopeKey} className="flex justify-between"><span className="truncate pr-1">{window.scopeKey}</span><span className="font-semibold theme-text-primary">{Math.round(window.weightedSuccessRate * 100)}%</span></div>
                ))}
              </>
            )}
          </div>
        </details>
      )}
      <details className="text-[10px]">
        <summary className="cursor-pointer select-none theme-text-muted hover:theme-text-secondary">
          Alerts ({persistedAlerts.length}) &amp; retention
          {retentionStatus && <span className="ml-1">• {retentionStatus.config.retentionDays}d</span>}
        </summary>
        <div className="mt-1 space-y-1">
          <div className="flex items-center gap-1">
            <select value={alertSeverityFilter} onChange={(event) => setAlertSeverityFilter(event.target.value as typeof alertSeverityFilter)} className="rounded border theme-border bg-[color:var(--color-background-secondary)] px-1 py-0.5 text-[10px] theme-text-primary" title="Severity">
              <option value="all">All sev</option><option value="critical">Critical</option><option value="warning">Warning</option>
            </select>
            <select value={alertAckFilter} onChange={(event) => setAlertAckFilter(event.target.value as typeof alertAckFilter)} className="rounded border theme-border bg-[color:var(--color-background-secondary)] px-1 py-0.5 text-[10px] theme-text-primary" title="Ack state">
              <option value="all">All ack</option><option value="unacknowledged">Unacked</option><option value="acknowledged">Acked</option>
            </select>
            <button type="button" onClick={() => { void handlePruneAlerts(); }} className="rounded border theme-border px-1 py-0.5 text-[10px] theme-text-secondary disabled:opacity-40" disabled={pruningAlerts || retentionStatus?.pruneInFlight}>
              {pruningAlerts ? "..." : "Prune"}
            </button>
          </div>
          {persistedAlerts.length === 0 ? (
            <p className="theme-text-muted">No alerts.</p>
          ) : (
            persistedAlerts.map((alert) => {
              const acknowledged = Boolean(alert.acknowledgedAt);
              const severity = alert.severity.toLowerCase();
              return (
                <div key={alert.alertId} className="flex items-center justify-between gap-1 rounded border theme-border px-1 py-0.5">
                  <div className="min-w-0 flex-1">
                    <span className="truncate font-semibold theme-text-primary">{alert.scopeKey}</span>
                    <span className={`ml-1 ${severity === "critical" ? "text-rose-500" : ""}`}>{alert.severity}</span>
                  </div>
                  <button type="button" onClick={() => { void handleAcknowledgeToggle(alert.alertId, !acknowledged); }} className="rounded border theme-border px-1 py-0 text-[9px] theme-text-secondary disabled:opacity-40" disabled={acknowledgingAlertId === alert.alertId}>
                    {acknowledged ? "Unack" : "Ack"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </details>
      {error && <p className="text-rose-500">{error}</p>}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={!pagination?.hasPreviousPage} className="rounded border theme-border px-1 py-0 text-[9px] theme-text-secondary disabled:opacity-40">‹</button>
          <span className="text-[9px] theme-text-muted">{pagination ? `${pagination.page}/${pagination.totalPages}` : "—"}</span>
          <button type="button" onClick={() => setPage((prev) => prev + 1)} disabled={!pagination?.hasNextPage} className="rounded border theme-border px-1 py-0 text-[9px] theme-text-secondary disabled:opacity-40">›</button>
        </div>
        <button type="button" onClick={() => { void loadHealth(); }} className="rounded border theme-border px-1 py-0 text-[9px] theme-text-secondary hover:opacity-90" disabled={loading}>{loading ? "..." : "Refresh"}</button>
      </div>
    </div>
  );
}

const DEFAULT_PERSONA_ID = "v_researcher";
const DEMO_PERSONA_SESSION_ID = "demo-persona-session";
const DEMO_AGENCY_ID = "demo-agency";
const DEMO_AGENCY_SESSION_ID = "demo-agency-session";
const LEFT_TABS = [
  { key: "home", label: "Home" },
  { key: "playground", label: "Playground" },
  { key: "prompt-workspace", label: "Prompts" },
  { key: "compose", label: "Compose" },
  { key: "personas", label: "Personas" },
  { key: "agency", label: "Agency" },
  { key: "workflows", label: "Workflows" },
  { key: "evaluation", label: "Evaluation" },
  { key: "planning", label: "Planning" },
  { key: "memory", label: "Memory" },
  { key: "voice", label: "Voice" },
  { key: "strategy", label: "Strategy" },
  { key: "resources", label: "Resources" },
  { key: "schema", label: "Schema" },
  { key: "rag", label: "RAG" },
  { key: "hitl", label: "HITL" },
  { key: "capabilities", label: "Capabilities" },
  { key: "marketplace", label: "Marketplace" },
  { key: "graph-builder", label: "Graph Builder" },
  { key: "tool-forge", label: "Tool Forge" },
  { key: "channels", label: "Channels" },
  { key: "social", label: "Social" },
  { key: "call-monitor", label: "Call Monitor" },
  { key: "guardrail-eval", label: "Guardrail Eval" },
  { key: "observability", label: "Observability" },
  { key: "vision-pipeline", label: "Vision" },
  { key: "image-editing", label: "Image Edit" },
  { key: "llm-providers", label: "LLM Providers" },
] as const;
type LeftTabKey = typeof LEFT_TABS[number]["key"];

function normalizeLeftTabKey(key: string | null | undefined): LeftTabKey | undefined {
  if (key === "rag-docs") {
    return "rag";
  }
  if (LEFT_TABS.some((tab) => tab.key === key)) {
    return key as LeftTabKey;
  }
  return undefined;
}

export default function App() {
  const disableAutoWelcomeTour = import.meta.env.VITE_E2E_MODE === "true";
  const autoEnableSampleWorkspace = import.meta.env.VITE_E2E_MODE === "true";
  const preferredLeftPanel = useUiStore((s) => s.preferredLeftPanel);
  const setPreferredLeftPanel = useUiStore((s) => s.setPreferredLeftPanel);
  const sampleWorkspaceMode = useUiStore((s) => s.sampleWorkspaceMode);
  const setSampleWorkspaceMode = useUiStore((s) => s.setSampleWorkspaceMode);
  const leftTab: LeftTabKey = normalizeLeftTabKey(preferredLeftPanel) ?? "home";
  const setLeftTab = useCallback((key: LeftTabKey) => {
    setPreferredLeftPanel(normalizeLeftTabKey(key) ?? "home");
  }, [setPreferredLeftPanel]);
  const [showTour, setShowTour] = useState(false);
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showSampleWorkspaceDialog, setShowSampleWorkspaceDialog] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelData, setModelData] = useState<AgentOSModelInfo[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusResponse | null | undefined>(undefined);
  const [runtimeStatusLoading, setRuntimeStatusLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [liveTaskOutcomeAlerts, setLiveTaskOutcomeAlerts] = useState<LiveTaskOutcomeAlert[]>([]);
  const [taskOutcomeAlertToasts, setTaskOutcomeAlertToasts] = useState<LiveTaskOutcomeAlert[]>([]);
  const [healthScopeJump, setHealthScopeJump] = useState<TaskOutcomeHealthScopeJump | null>(null);
  const alertCooldownRef = useRef<Map<string, number>>(new Map());
  const toastTimeoutRef = useRef<Record<string, number>>({});
  const welcomeTourDismissed = useUiStore((s) => s.welcomeTourDismissed);
  const welcomeTourSnoozeUntil = useUiStore((s) => s.welcomeTourSnoozeUntil);
  const dismissWelcomeTour = useUiStore((s) => s.dismissWelcomeTour);
  const snoozeWelcomeTour = useUiStore((s) => s.snoozeWelcomeTour);
  const tourSteps = [
    { selector: '[data-tour="tabs"]', title: 'Panels', body: 'Switch between Compose, Agency, Personas, Workflows, Evaluation, Planning, Settings, and About.' },
    { selector: '[data-tour="composer"]', title: 'Compose', body: 'Write prompts, select persona/agency, and submit to start a session.' },
    { selector: '[data-tour="agency-manager"]', title: 'Agency', body: 'Define multi-seat collectives and attach workflows.' },
    { selector: '[data-tour="theme-button"]', title: 'Theme', body: 'Switch theme mode, appearance, and palette (Sakura, Twilight, etc.)' },
    { selector: '[data-tour="import-button"]', title: 'Import', body: 'Import exported personas, agencies, and sessions from JSON.' },
  ];
  const { t } = useTranslation();
  useSystemTheme();
  const personas = useSessionStore((state) => state.personas);
  const addPersona = useSessionStore((state) => state.addPersona);
  const agencies = useSessionStore((state) => state.agencies);
  const removeAgency = useSessionStore((state) => state.removeAgency);
  const sessions = useSessionStore((state) => state.sessions);
  const addAgency = useSessionStore((state) => state.addAgency);
  const removeSession = useSessionStore((state) => state.removeSession);
  const applyAgencySnapshot = useSessionStore((state) => state.applyAgencySnapshot);
  const applyWorkflowSnapshot = useSessionStore((state) => state.applyWorkflowSnapshot);
  const setPersonas = useSessionStore((state) => state.setPersonas);
  const personaFilters = useSessionStore((state) => state.personaFilters);
  const remotePersonas = useMemo(() => personas.filter(p => p.source === 'remote'), [personas]);
  const upsertSession = useSessionStore((state) => state.upsertSession);
  const appendEvent = useSessionStore((state) => state.appendEvent);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const syncSessionToStorage = useCallback((sessionId: string) => {
    const snapshot = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (snapshot) {
      void persistSessionRow(snapshot);
    }
  }, []);
  const syncEventToStorage = useCallback((sessionId: string, event: SessionEvent) => {
    const snapshot = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (snapshot) {
      void persistSessionEventRow(snapshot, event);
    }
  }, []);
  const commitSession = useCallback((update: SessionUpdate) => {
    upsertSession(update);
    syncSessionToStorage(update.id);
  }, [upsertSession, syncSessionToStorage]);
  const pushEvent = useCallback((sessionId: string, event: SessionEvent) => {
    appendEvent(sessionId, event);
    syncEventToStorage(sessionId, event);
  }, [appendEvent, syncEventToStorage]);

  useEffect(() => {
    if (preferredLeftPanel === "rag-docs") {
      setPreferredLeftPanel("rag");
    }
  }, [preferredLeftPanel, setPreferredLeftPanel]);
  
  const activeSession = useMemo(() => {
    return activeSessionId ? sessions.find(s => s.id === activeSessionId) : undefined;
  }, [activeSessionId, sessions]);
  const isAgencyStreaming = activeSession?.targetType === 'agency' && activeSession.status === 'streaming';
  const liveAlertCount = liveTaskOutcomeAlerts.length;
  const workspaceStatus = useMemo(() => getWorkbenchWorkspaceStatus(runtimeStatus), [runtimeStatus]);
  const activeSurfaceStatus = useMemo(() => getWorkbenchSurfaceStatus(leftTab), [leftTab]);

  const streamHandles = useRef<Record<string, () => void>>({});
  const telemetry = useTelemetryStore();

  const dismissTaskOutcomeToast = useCallback((alertId: string) => {
    setTaskOutcomeAlertToasts((current) => current.filter((alert) => alert.id !== alertId));
    const timeoutId = toastTimeoutRef.current[alertId];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      delete toastTimeoutRef.current[alertId];
    }
  }, []);

  const noteTaskOutcomeAlert = useCallback(
    (alert: AgentOSTaskOutcomeAlert, sessionId: string) => {
      const now = Date.now();
      const dedupeKey = `${alert.scopeKey}::${alert.severity}`;
      const lastSeenAt = alertCooldownRef.current.get(dedupeKey) ?? 0;
      const dedupeCooldownMs = 15_000;
      if (now - lastSeenAt < dedupeCooldownMs) {
        return;
      }
      alertCooldownRef.current.set(dedupeKey, now);

      const timestampMs = Date.parse(alert.timestamp);
      const normalizedTimestamp = Number.isFinite(timestampMs)
        ? new Date(timestampMs).toISOString()
        : new Date(now).toISOString();

      const entry: LiveTaskOutcomeAlert = {
        ...alert,
        timestamp: normalizedTimestamp,
        id: `${alert.scopeKey}-${now}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        receivedAt: now,
      };

      setLiveTaskOutcomeAlerts((current) => {
        const next = [entry, ...current.filter((item) => item.scopeKey !== alert.scopeKey)];
        return next.slice(0, 64);
      });

      setTaskOutcomeAlertToasts((current) => [entry, ...current].slice(0, 5));
      const toastTtlMs = 12_000;
      const timeoutId = window.setTimeout(() => {
        setTaskOutcomeAlertToasts((current) => current.filter((item) => item.id !== entry.id));
        delete toastTimeoutRef.current[entry.id];
      }, toastTtlMs);
      toastTimeoutRef.current[entry.id] = timeoutId;
    },
    []
  );

  useEffect(() => {
    return () => {
      for (const timeoutId of Object.values(toastTimeoutRef.current)) {
        window.clearTimeout(timeoutId);
      }
      toastTimeoutRef.current = {};
    };
  }, []);

  const personasQuery = usePersonas({
    filters: {
      search: personaFilters.search.trim() ? personaFilters.search.trim() : undefined,
      capability: personaFilters.capabilities
    },
    staleTimeMs: 10 * 60 * 1000, // 10 minutes cache
  });

  const backendReady = !personasQuery.isLoading && !personasQuery.isError;

  useEffect(() => {
    if (!personasQuery.data) return;
    setPersonas(personasQuery.data);
  }, [personasQuery.data, setPersonas]);

  // Bootstrap persisted sessions/personas from the SQL storage adapter
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { sessions: storedSessions, personas: storedPersonas } = await bootstrapStorage();
        if (cancelled) return;
        if (storedPersonas.length > 0) {
          storedPersonas.forEach((persona) => addPersona(persona));
        }
        if (storedSessions.length > 0) {
          storedSessions.forEach((session) => upsertSession(session));
        }
      } catch (error) {
        console.error("[AgentOS Client] Failed to bootstrap storage", error);
      } finally {
        if (!cancelled) {
          setStorageReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addPersona, upsertSession]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setRuntimeStatusLoading(true);
        const status = await getRuntimeStatus();
        if (!cancelled) {
          setRuntimeStatus(status);
        }
      } catch {
        if (!cancelled) {
          setRuntimeStatus(null);
        }
      } finally {
        if (!cancelled) {
          setRuntimeStatusLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || sampleWorkspaceMode !== null || !autoEnableSampleWorkspace) {
      return;
    }
    setSampleWorkspaceMode("sample");
  }, [autoEnableSampleWorkspace, sampleWorkspaceMode, setSampleWorkspaceMode, storageReady]);

  useEffect(() => {
    if (sampleWorkspaceMode !== null) {
      setShowSampleWorkspaceDialog(false);
    }
  }, [sampleWorkspaceMode]);

  useEffect(() => {
    if (!storageReady || sampleWorkspaceMode !== "clean") {
      return;
    }

    const demoSessionIds = [DEMO_PERSONA_SESSION_ID, DEMO_AGENCY_SESSION_ID];
    const existingDemoSessionIds = sessions
      .filter((session) => demoSessionIds.includes(session.id))
      .map((session) => session.id);

    const hasDemoAgency = agencies.some((agency) => agency.id === DEMO_AGENCY_ID);
    if (existingDemoSessionIds.length === 0 && !hasDemoAgency) {
      return;
    }

    const fallbackSessionId =
      activeSessionId && demoSessionIds.includes(activeSessionId)
        ? sessions.find((session) => !demoSessionIds.includes(session.id))?.id ?? null
        : null;

    if (fallbackSessionId) {
      setActiveSession(fallbackSessionId);
    }

    for (const sessionId of existingDemoSessionIds) {
      removeSession(sessionId);
      void deleteSessionRow(sessionId);
    }

    if (hasDemoAgency) {
      removeAgency(DEMO_AGENCY_ID);
    }
  }, [
    activeSessionId,
    agencies,
    removeAgency,
    removeSession,
    sampleWorkspaceMode,
    sessions,
    setActiveSession,
    storageReady,
  ]);

  // Fetch available models from AgentOS
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const models = await getAvailableModels();
        if (!mounted) return;
        const rawModels: AgentOSModelInfo[] = Array.isArray(models) ? (models as AgentOSModelInfo[]) : [];
        const normalisedModels = rawModels.map((model) => ({
          id: model.id ?? crypto.randomUUID(),
          displayName: model.displayName,
          provider: model.provider,
          pricing: model.pricing
        }));
        setModelData(normalisedModels);
        const modelIds = normalisedModels.map((m) => m.id);
        setModelOptions(modelIds);
      } catch {
        if (mounted) {
          setModelOptions([]);
          setModelData([]);
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const preferDefaultPersona = useCallback((ids: string[]): string | undefined => {
    if (ids.includes('v_researcher')) return 'v_researcher';
    return ids[0];
  }, []);

  const ensureDemoPersonaSession = useCallback(() => {
    if (!storageReady || sampleWorkspaceMode !== "sample") return;
    const hasDemo = sessions.some((session) => session.id === DEMO_PERSONA_SESSION_ID);
    const remoteIds = personas.filter((p) => p.source === "remote").map((p) => p.id);
    const personaId = preferDefaultPersona(remoteIds) ?? personas[0]?.id ?? null;
    if (!personaId) return;

    if (!hasDemo) {
      commitSession({
        id: DEMO_PERSONA_SESSION_ID,
        targetType: "persona",
        displayName: "Demo Persona Session",
        personaId,
        status: "idle",
        events: []
      });
    }

    if (!activeSessionId) {
      setActiveSession(DEMO_PERSONA_SESSION_ID);
    }
  }, [
    storageReady,
    sampleWorkspaceMode,
    sessions,
    personas,
    preferDefaultPersona,
    activeSessionId,
    commitSession,
    setActiveSession,
  ]);

  useEffect(() => {
    ensureDemoPersonaSession();
  }, [ensureDemoPersonaSession]);

  // Seed a demo agency if none exists, to make the dashboard usable immediately
  const ensureDemoAgencySession = useCallback(() => {
    if (!storageReady || sampleWorkspaceMode !== "sample") return;
    const remotePersonas = personas.filter((p) => p.source === "remote");
    if (remotePersonas.length < 1) return;
    let demoAgency = agencies.find((agency) => agency.id === DEMO_AGENCY_ID) ?? null;
    if (!demoAgency) {
      const timestamp = new Date().toISOString();
      const participants = [
        { roleId: "lead", personaId: remotePersonas[0]?.id ?? DEFAULT_PERSONA_ID },
        { roleId: "researcher", personaId: remotePersonas[1]?.id ?? remotePersonas[0]?.id ?? DEFAULT_PERSONA_ID },
        { roleId: "writer", personaId: remotePersonas[0]?.id ?? DEFAULT_PERSONA_ID }
      ];
      const seededAgency = {
        id: DEMO_AGENCY_ID,
        name: "Demo Agency",
        goal: "Multi-GMI coordination demo",
        workflowId: undefined,
        participants,
        metadata: { seeded: true },
        createdAt: timestamp,
        updatedAt: timestamp
      };
      addAgency(seededAgency);
      demoAgency = seededAgency;
    }
    const hasDemoSession = sessions.some((session) => session.id === DEMO_AGENCY_SESSION_ID);
    if (!hasDemoSession && demoAgency) {
      commitSession({
        id: DEMO_AGENCY_SESSION_ID,
        targetType: "agency",
        displayName: demoAgency.name,
        agencyId: demoAgency.id,
        status: "idle",
        events: []
      });
    }
  }, [storageReady, sampleWorkspaceMode, agencies, personas, addAgency, commitSession, sessions]);

  useEffect(() => {
    ensureDemoAgencySession();
  }, [ensureDemoAgencySession]);

  useEffect(() => {
    if (personasQuery.error) {
      console.error("[AgentOS Client] Failed to load personas", personasQuery.error);
    }
  }, [personasQuery.error]);

  // Wire up a global event to open the import wizard from SettingsPanel
  useEffect(() => {
    const open = () => setShowImport(true);
    window.addEventListener('agentos:open-import', open as EventListener);
    return () => window.removeEventListener('agentos:open-import', open as EventListener);
  }, []);

  // Toggle Theme Panel via custom event
  useEffect(() => {
    const toggle = () => setShowThemePanel((v) => !v);
    window.addEventListener('agentos:toggle-theme-panel', toggle as EventListener);
    return () => window.removeEventListener('agentos:toggle-theme-panel', toggle as EventListener);
  }, []);

  // Toggle Tour Overlay via custom event
  useEffect(() => {
    const toggle = () => setShowTour((v) => !v);
    window.addEventListener('agentos:toggle-tour', toggle as EventListener);
    return () => window.removeEventListener('agentos:toggle-tour', toggle as EventListener);
  }, []);

  // Connect the real-time event bus
  useEffect(() => {
    try {
      const baseUrl = resolveWorkbenchApiBaseUrl();
      eventBus.connect(`${baseUrl}/api/events`);
    } catch {
      // Non-fatal — event bus is best-effort
    }
    return () => {
      // Keep the bus alive across tab switches — do not disconnect on unmount
    };
  }, []);

  // Global keyboard shortcuts:
  //   Ctrl+K / Cmd+K — open command palette
  //   Ctrl+1–9       — switch to tab by index
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
        return;
      }
      if (ctrl && e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const tab = LEFT_TABS[idx];
        if (tab) {
          e.preventDefault();
          setLeftTab(tab.key as LeftTabKey);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setLeftTab]);

  // Settings / About as modals
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  useEffect(() => {
    const openSettings = () => setShowSettingsModal(true);
    window.addEventListener('agentos:open-settings', openSettings as EventListener);
    return () => window.removeEventListener('agentos:open-settings', openSettings as EventListener);
  }, []);
  useEffect(() => {
    const openAbout = () => setShowAboutModal(true);
    window.addEventListener('agentos:open-about', openAbout as EventListener);
    return () => window.removeEventListener('agentos:open-about', openAbout as EventListener);
  }, []);

  // Responsive: track desktop vs mobile and auto-collapse sidebar on small screens
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)'); // md breakpoint
    const apply = (matches: boolean) => {
      setIsDesktop(matches);
      if (!matches) {
        setSidebarCollapsed(false); // sidebar visibility handled by mobile overlay
      }
    };
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Show welcome tour on first load unless dismissed or snoozed
  useEffect(() => {
    if (disableAutoWelcomeTour) {
      return;
    }
    if (!welcomeTourDismissed) {
      const now = Date.now();
      if (!welcomeTourSnoozeUntil || now >= welcomeTourSnoozeUntil) {
        setShowTour(true);
      }
    }
  }, [disableAutoWelcomeTour, welcomeTourDismissed, welcomeTourSnoozeUntil]);


  const resolvePersonaName = useCallback(
    (personaId?: string | null) => {
      if (!personaId) {
        return t("app.fallbacks.untitledPersona");
      }
      const persona = personas.find((item) => item.id === personaId);
      return persona?.displayName ?? personaId;
    },
    [personas, t]
  );

  const resolveAgencyName = useCallback(
    (agencyId?: string | null) => {
      if (!agencyId) {
        return t("app.fallbacks.agencyCollective");
      }
      const agency = agencies.find((item) => item.id === agencyId);
      return agency?.name ?? agencyId;
    },
    [agencies, t]
  );

  const ensureActiveSession = useCallback((): AgentSession => {
    if (activeSessionId) {
      const existing = sessions.find((session) => session.id === activeSessionId);
      if (existing) {
        return existing;
      }
    }

    const remoteIds = personas.filter((p) => p.source === "remote").map((p) => p.id);
    const personaId = preferDefaultPersona(remoteIds) ?? personas[0]?.id ?? DEFAULT_PERSONA_ID;
    const fallback: AgentSession = {
      id: crypto.randomUUID(),
      targetType: "persona",
      displayName: resolvePersonaName(personaId),
      personaId,
      status: "idle",
      events: []
    };
    commitSession(fallback);
    setActiveSession(fallback.id);
    return fallback;
  }, [activeSessionId, sessions, personas, preferDefaultPersona, resolvePersonaName, setActiveSession, commitSession]);

  const handleCreateSession = useCallback(
    (opts?: { targetType?: 'persona' | 'agency'; personaId?: string; agencyId?: string; displayName?: string }) => {
      const sessionId = crypto.randomUUID();
      const remoteIds = personas.filter((p) => p.source === "remote").map((p) => p.id);
      const fallbackPersonaId = preferDefaultPersona(remoteIds) ?? personas[0]?.id ?? DEFAULT_PERSONA_ID;
      const rawPersonaId = opts?.personaId?.trim();
      const personaId =
        rawPersonaId && personas.some((p) => p.id === rawPersonaId) ? rawPersonaId : fallbackPersonaId;
      const fallbackAgencyId = agencies[0]?.id;
      const rawAgencyId = opts?.agencyId?.trim();
      let targetType: 'persona' | 'agency' = opts?.targetType ?? "persona";
      const agencyId = targetType === "agency" ? (rawAgencyId || fallbackAgencyId) : undefined;
      if (targetType === "agency" && !agencyId) {
        targetType = "persona";
      }

      const baseName =
        targetType === "agency"
          ? resolveAgencyName(agencyId)
          : resolvePersonaName(personaId);
      const existing = sessions.filter((session) => session.displayName.startsWith(baseName)).length;
      const displayName =
        opts?.displayName ?? (existing === 0 ? baseName : `${baseName} ${existing + 1}`);

      commitSession({
        id: sessionId,
        targetType,
        displayName,
        personaId: targetType === "persona" ? personaId : undefined,
        agencyId: targetType === "agency" ? agencyId : undefined,
        status: "idle",
        events: []
      });
      setActiveSession(sessionId);
      return sessionId;
    },
    [agencies, personas, sessions, setActiveSession, commitSession, preferDefaultPersona, resolveAgencyName, resolvePersonaName]
  );

  const handleSubmit = useCallback(
    (payload: RequestComposerPayload) => {
      const session = ensureActiveSession();
      const sessionId = session.id;

      const remoteIds = personas.filter((p) => p.source === "remote").map((p) => p.id);
      const allPersonaIds = personas.map((p) => p.id);
      const preferredPersonaId = preferDefaultPersona(remoteIds) ?? personas[0]?.id ?? DEFAULT_PERSONA_ID;

      let effectiveTarget: 'persona' | 'agency' = session.targetType;
      let agencyId = session.agencyId ?? null;
      if (effectiveTarget === "agency") {
        if (agencyId && agencies.some((agency) => agency.id === agencyId)) {
          // valid agency
        } else if (agencies.length > 0) {
          agencyId = agencies[0]?.id ?? null;
        } else {
          effectiveTarget = "persona";
          agencyId = null;
        }
      }

      let personaId =
        session.personaId && allPersonaIds.includes(session.personaId) ? session.personaId : preferredPersonaId;
      if (!personaId) {
        personaId = preferredPersonaId;
      }

      if (session.targetType !== effectiveTarget || session.agencyId !== agencyId) {
        commitSession({
          id: sessionId,
          targetType: effectiveTarget,
          agencyId: agencyId ?? undefined
        });
      }

      setActiveSession(sessionId);

      streamHandles.current[sessionId]?.();
      delete streamHandles.current[sessionId];

      const displayName =
        effectiveTarget === "agency" ? resolveAgencyName(agencyId) : resolvePersonaName(personaId);
      const timestamp = Date.now();

      const agencyDefinition =
        effectiveTarget === "agency" && agencyId
          ? agencies.find((item) => item.id === agencyId) ?? null
          : null;

      const workflowDefinitionId = payload.workflowId ?? agencyDefinition?.workflowId;
      const workflowInstanceId = workflowDefinitionId ? `${workflowDefinitionId}-${sessionId}` : undefined;

      const agencyRequest =
        effectiveTarget === "agency" && agencyDefinition
          ? {
              agencyId: agencyId ?? undefined,
              workflowId: workflowInstanceId ?? undefined,
              goal: agencyDefinition.goal,
              participants: (agencyDefinition.participants ?? []).map((participant) => ({
                roleId: participant.roleId,
                personaId:
                  participant.personaId && allPersonaIds.includes(participant.personaId)
                    ? participant.personaId
                    : personaId,
              })),
              metadata: {
                ...agencyDefinition.metadata,
                sourceSessionId: sessionId,
              },
            }
          : undefined;

      const workflowRequest = workflowDefinitionId
        ? {
            definitionId: workflowDefinitionId,
            workflowId: workflowInstanceId,
            conversationId: sessionId,
            metadata: { source: "agentos-workbench" }
          }
        : undefined;

      commitSession({
        id: sessionId,
        targetType: effectiveTarget,
        displayName,
        personaId: effectiveTarget === "persona" ? personaId : undefined,
        agencyId: effectiveTarget === "agency" ? agencyId ?? undefined : undefined,
        status: "streaming"
      });

      pushEvent(sessionId, {
        id: crypto.randomUUID(),
        timestamp,
        type: "log",
        payload: {
          message: t("app.logs.userMessage", { displayName, content: payload.input })
        }
      });

      telemetry.startStream(sessionId);

      const cleanup = openAgentOSStream(
        {
          sessionId,
          personaId,
          messages: [{ role: "user", content: payload.input }],
          workflowRequest,
          agencyRequest,
          model: selectedModel
        },
        {
          onChunk: (chunk) => {
            try {
              // eslint-disable-next-line no-console
              console.debug("[AgentOS SSE] chunk:", chunk);
            } catch {
              // no-op
            }
            pushEvent(sessionId, {
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              type: chunk.type,
              payload: chunk
            });

            telemetry.noteChunk(sessionId, chunk);
            const taskOutcomeAlert = extractTaskOutcomeAlert(chunk);
            if (taskOutcomeAlert) {
              noteTaskOutcomeAlert(taskOutcomeAlert, sessionId);
            }

            if (chunk.type === AgentOSChunkType.AGENCY_UPDATE) {
              applyAgencySnapshot((chunk as AgentOSAgencyUpdateChunk).agency);
            }

            if (chunk.type === AgentOSChunkType.WORKFLOW_UPDATE) {
              applyWorkflowSnapshot((chunk as AgentOSWorkflowUpdateChunk).workflow);
            }
          },
          onDone: () => {
            commitSession({ id: sessionId, status: "idle" });
            telemetry.endStream(sessionId);
            delete streamHandles.current[sessionId];
          },
          onError: (error) => {
            pushEvent(sessionId, {
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              type: "log",
              payload: { message: t("app.logs.streamError", { message: error.message }), level: "error" }
            });
            commitSession({ id: sessionId, status: "error" });
            telemetry.endStream(sessionId);
            delete streamHandles.current[sessionId];
          }
        }
      );

      streamHandles.current[sessionId] = cleanup;
    },
    [
      agencies,
      personas,
      applyAgencySnapshot,
      applyWorkflowSnapshot,
      ensureActiveSession,
      preferDefaultPersona,
      resolveAgencyName,
      resolvePersonaName,
      setActiveSession,
      commitSession,
      pushEvent,
      selectedModel,
      telemetry,
      noteTaskOutcomeAlert,
      t
    ]
  );

  // Removed auto-new-session on tab switch; tabs now only change view and filter.

  return (
    <div className="flex h-screen flex-col overflow-hidden theme-bg-primary theme-text-primary transition-theme">
      <SkipLink />
      {/* Top Header */}
      <header className="flex-none sticky top-0 z-50 border-b theme-border theme-bg-primary-soft px-4 py-2 backdrop-blur-sm transition-theme">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {!isDesktop && (
              <button
                type="button"
                className="mr-1 inline-flex items-center justify-center rounded-md border theme-border bg-[color:var(--color-background-secondary)] p-1 theme-text-primary transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
                aria-label="Open sidebar"
                onClick={() => setShowMobileSidebar(true)}
              >
                <Menu className="h-5 w-5" />
              </button>
            )}
            <a href="https://agentos.sh" target="_blank" rel="noreferrer" className="group flex items-center gap-2">
              <img src="/agentos-icon.svg" alt="AgentOS" className="h-6 w-6" />
              <span className="flex items-baseline gap-0.5 text-[18px] font-semibold leading-none theme-text-primary">
                Agent
                <span
                  className="leading-none"
                  style={{
                    background: 'linear-gradient(135deg, #6366F1, #8B5CF6, #EC4899)',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    WebkitTextFillColor: 'transparent'
                  }}
                >
                  OS
                </span>
              </span>
            </a>
          </div>
          <nav className="flex items-center gap-3 text-xs">
            <a href="https://agentos.sh/docs" target="_blank" rel="noreferrer" className="theme-text-secondary transition-colors hover:text-[color:var(--color-accent-primary)]">Docs</a>
            <a href="https://github.com/framerslab/agentos" target="_blank" rel="noreferrer" className="theme-text-secondary transition-colors hover:text-[color:var(--color-accent-primary)]">GitHub</a>
            <button
              type="button"
              onClick={() => setLeftTab("marketplace")}
              className="theme-text-secondary transition-colors hover:text-[color:var(--color-accent-primary)]"
              title="Open the workbench marketplace"
            >
              Marketplace
            </button>
            <DataSourceBadge
              tone={workspaceStatus.tone}
              label={`Workspace ${workspaceStatus.label}`}
              className="hidden md:inline-flex"
            />
            <div
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${
                liveAlertCount > 0
                  ? "border-rose-300 bg-rose-50 text-rose-700"
                  : "theme-border bg-[color:var(--color-background-secondary)] theme-text-secondary"
              }`}
              title="Live task outcome KPI alerts"
            >
              <AlertTriangle className="h-3 w-3" />
              <span className="uppercase tracking-widest">Alerts</span>
              <span className="font-semibold">{liveAlertCount}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowThemePanel(!showThemePanel)}
                className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-2 py-1 text-xs theme-text-secondary transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                title="Theme settings"
              >
                Theme
              </button>
              <ThemeToggle />
            </div>
          </nav>
        </div>
      </header>

      {showThemePanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="dialog" aria-modal="true">
          <div className="card-panel--strong w-full max-w-lg p-4 shadow-2xl shadow-[rgba(15,23,42,0.2)]">
            <Suspense fallback={<LoadingSkeleton withHeader lines={8} className="p-2" />}>
              <ThemePanel />
            </Suspense>
            <div className="mt-3 flex justify-end">
              <button onClick={() => setShowThemePanel(false)} className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-3 py-1 text-xs theme-text-secondary transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Close</button>
            </div>
          </div>
        </div>
      )}
      {showSettingsModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" 
          role="dialog" 
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowSettingsModal(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setShowSettingsModal(false);
            }
          }}
        >
          <div className="card-panel--strong flex h-full max-h-[90vh] w-full max-w-3xl flex-col shadow-2xl shadow-[rgba(15,23,42,0.2)] transition-theme">
            <div className="flex-1 overflow-y-auto p-4">
              <Suspense fallback={<LoadingSkeleton withHeader lines={12} className="p-2" />}>
                <SettingsPanel />
              </Suspense>
            </div>
            <div className="border-t theme-border p-4">
              <div className="flex justify-end">
                <button 
                  onClick={() => setShowSettingsModal(false)} 
                  className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-3 py-1 text-xs theme-text-secondary transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showAboutModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" 
          role="dialog" 
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowAboutModal(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setShowAboutModal(false);
            }
          }}
        >
          <div className="card-panel--strong flex h-full max-h-[90vh] w-full max-w-3xl flex-col shadow-2xl shadow-[rgba(15,23,42,0.2)] transition-theme">
            <div className="flex-1 overflow-y-auto p-4">
              <Suspense fallback={<LoadingSkeleton withHeader lines={10} className="p-2" />}>
                <AboutPanel />
              </Suspense>
            </div>
            <div className="border-t theme-border p-4">
              <div className="flex justify-end">
                <button 
                  onClick={() => setShowAboutModal(false)} 
                  className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-3 py-1 text-xs theme-text-secondary transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {(showSampleWorkspaceDialog || (storageReady && sampleWorkspaceMode === null && !autoEnableSampleWorkspace)) && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true">
          <div className="card-panel--strong w-full max-w-xl p-5 shadow-2xl shadow-[rgba(15,23,42,0.2)] transition-theme">
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-[0.35em] theme-text-muted">Workspace Setup</p>
              <h2 className="text-lg font-semibold theme-text-primary">Choose how the workbench should start</h2>
              <p className="text-sm leading-relaxed theme-text-secondary">
                Sample data makes the workbench easier to explore, but it also introduces seeded sessions and agencies.
                Clean mode avoids generated demo artifacts and leaves the workspace empty until you create something.
              </p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => {
                  setSampleWorkspaceMode("clean");
                  setShowSampleWorkspaceDialog(false);
                }}
                className="rounded-xl border theme-border theme-bg-primary p-4 text-left transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <DataSourceBadge tone="local" label="Clean workspace" />
                <p className="mt-3 text-sm font-semibold theme-text-primary">Start without sample sessions</p>
                <p className="mt-1 text-xs leading-relaxed theme-text-secondary">
                  Best if you want the UI to reflect only real agents, runs, and content you create.
                </p>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSampleWorkspaceMode("sample");
                  setShowSampleWorkspaceDialog(false);
                }}
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <DataSourceBadge tone="demo" label="Sample workspace" />
                <p className="mt-3 text-sm font-semibold theme-text-primary">Load guided demo sessions</p>
                <p className="mt-1 text-xs leading-relaxed theme-text-secondary">
                  Seeds a demo persona session and agency so the dashboard is populated immediately.
                </p>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`flex-1 min-h-0 grid w-full ${sidebarCollapsed ? 'grid-cols-1' : 'grid-cols-panel'} transition-all duration-300 ease-in-out-sine`}>
        {/* Navigation Sidebar */}
        {!sidebarCollapsed && (
          isDesktop ? (
            <div className="h-full overflow-y-auto border-r theme-border">
              <Sidebar
                onCreateSession={handleCreateSession}
                onToggleCollapse={() => setSidebarCollapsed(true)}
                onNavigate={(key) => {
                  if (key === 'settings') { setShowSettingsModal(true); return; }
                  if (key === 'about') { setShowAboutModal(true); return; }
                  setLeftTab(key as LeftTabKey);
                }}
              />
            </div>
          ) : (
            showMobileSidebar && (
              <div className="fixed inset-0 z-50 flex lg:hidden">
                <div className="h-full w-80 max-w-[80%] overflow-y-auto border-r theme-border theme-bg-primary transition-theme">
                  <Sidebar
                    onCreateSession={handleCreateSession}
                    onToggleCollapse={() => setShowMobileSidebar(false)}
                    onNavigate={(key) => {
                      if (key === 'settings') { setShowSettingsModal(true); setShowMobileSidebar(false); return; }
                      if (key === 'about') { setShowAboutModal(true); setShowMobileSidebar(false); return; }
                      setLeftTab(key as LeftTabKey);
                      setShowMobileSidebar(false);
                    }}
                  />
                </div>
                <button className="flex-1 bg-black/40" aria-label="Close sidebar overlay" onClick={() => setShowMobileSidebar(false)} />
              </div>
            )
          )
        )}
        
        {/* Main Content Area */}
        <main 
          id="main-content"
          className="flex min-w-0 flex-col gap-4 h-full md:overflow-hidden overflow-y-auto theme-bg-primary-soft p-4 transition-theme"
          role="main"
          aria-label={t("app.labels.mainContent", { defaultValue: "Main content area" })}
        >
          {sidebarCollapsed && (
            <div className="flex-none flex justify-end">
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-3 py-1 text-xs theme-text-secondary transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                title="Show sidebar"
              >
                Show sidebar
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col gap-4 md:grid md:gap-4 md:grid-cols-[1fr_2fr]">
            {/* Left Column: Tabbed coordination */}
            <section className="flex flex-col gap-3 min-h-[500px] md:min-h-0 md:h-full overflow-hidden" aria-label={t("app.labels.leftPanel", { defaultValue: "Composer and coordination" })}>
              <div
                role="tablist"
                aria-label="Left panel tabs"
                className="flex-none card-panel--strong p-1.5 text-sm transition-theme sticky top-0 z-10"
                data-tour="tabs"
              >
                <div className="flex flex-wrap items-center gap-1">
                  {LEFT_TABS.map((tab) => {
                    const active = leftTab === tab.key;
                    return (
                      <button
                        key={tab.key}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setLeftTab(tab.key)}
                        className={`rounded-full border px-2 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                          active
                            ? "theme-bg-accent theme-text-on-accent shadow-sm"
                            : "theme-text-secondary theme-bg-secondary border theme-border hover:opacity-95"
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
              <div className="ml-auto" />
                </div>
              </div>
              <div className="flex-none rounded-xl border theme-border theme-bg-secondary-soft px-3 py-2 transition-theme">
                <div className="flex flex-wrap items-center gap-2">
                  <DataSourceBadge tone={activeSurfaceStatus.mode} label={`${activeSurfaceStatus.label} ${DATA_MODE_LABELS[activeSurfaceStatus.mode]}`} />
                  {runtimeStatusLoading ? (
                    <DataSourceBadge tone="neutral" label="Runtime checking" />
                  ) : (
                    <DataSourceBadge
                      tone={runtimeStatus?.runtime.connected ? "runtime" : "demo"}
                      label={runtimeStatus?.runtime.connected ? "Runtime connected" : "Runtime standalone"}
                    />
                  )}
                  {(activeSurfaceStatus.mode === "demo" || activeSurfaceStatus.mode === "mixed") && (
                    <button
                      type="button"
                      onClick={() => setShowSettingsModal(true)}
                      className="rounded-full border theme-border px-2 py-1 text-[10px] theme-text-secondary transition hover:opacity-90"
                    >
                      Runtime details
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed theme-text-secondary">
                  {activeSurfaceStatus.description}
                </p>
              </div>
              <div className="flex-1 overflow-y-auto pr-1">
                {leftTab === 'home' && (
                  <SuspensePanel label="Home Dashboard" lines={12}>
                    <HomeDashboard
                      onNavigate={(key) => setLeftTab(key as LeftTabKey)}
                      runtimeStatus={runtimeStatus}
                      runtimeStatusLoading={runtimeStatusLoading}
                      workspaceStatus={workspaceStatus}
                      sampleWorkspaceMode={sampleWorkspaceMode}
                      onManageSampleWorkspace={() => setShowSampleWorkspaceDialog(true)}
                    />
                  </SuspensePanel>
                )}
                {leftTab === 'playground' && (
                  <SuspensePanel label="Agent Playground" lines={14}>
                    <AgentPlayground />
                  </SuspensePanel>
                )}
                {leftTab === 'prompt-workspace' && (
                  <SuspensePanel label="Prompt Workspace" lines={12}>
                    <PromptWorkspace />
                  </SuspensePanel>
                )}
                {leftTab === 'compose' && (
                  activeSession?.targetType === 'agency' ? (
                    <AgencyComposer
                      onSubmit={(agencyPayload) => {
                        const sessionId = activeSessionId || crypto.randomUUID();
                        setActiveSession(sessionId);
                        
                        // Parse roles from markdown if needed
                        let roles: AgentRoleConfig[] = agencyPayload.roles;
                        if (agencyPayload.format === 'markdown' && agencyPayload.markdownInput) {
                          const lines = agencyPayload.markdownInput.split('\n').filter(l => l.trim());
                          roles = [];
                          for (const line of lines) {
                            const match = line.match(/^\[([^\]]+)\]\s*(.+)$/);
                            if (match) {
                              const roleId = match[1].trim().toLowerCase().replace(/\s+/g, '_');
                              const instruction = match[2].trim();
                              const persona = remotePersonas[roles.length % remotePersonas.length] || personas[0];
                              roles.push({
                                roleId,
                                personaId: persona?.id || 'v_researcher',
                                instruction,
                                priority: roles.length + 1,
                              });
                            }
                          }
                        }
                        
                        // Start agency workflow via dedicated endpoint
                        streamHandles.current[sessionId]?.();
                        delete streamHandles.current[sessionId];
                        
                        commitSession({
                          id: sessionId,
                          targetType: 'agency',
                          displayName: activeSession?.displayName || 'Agency Workflow',
                          agencyId: activeSession?.agencyId,
                          status: 'streaming',
                        });
                        
                        pushEvent(sessionId, {
                          id: crypto.randomUUID(),
                          timestamp: Date.now(),
                          type: 'log',
                          payload: { message: `Starting agency workflow: ${agencyPayload.goal}` },
                        });
                        
                        telemetry.startStream(sessionId);
                        
                        // Use backend API endpoint for agency workflows
                        const params = new URLSearchParams({
                          userId: 'agentos-workbench-user',
                          conversationId: sessionId,
                          goal: agencyPayload.goal,
                          roles: JSON.stringify(roles.map(r => ({
                            roleId: r.roleId,
                            personaId: r.personaId,
                            instruction: r.instruction,
                            priority: r.priority,
                          }))),
                          outputFormat: agencyPayload.outputFormat || 'markdown',
                        });

                        const baseUrl = resolveWorkbenchApiBaseUrl();
                        const eventSource = new EventSource(`${baseUrl}/api/agentos/agency/stream?${params.toString()}`);

                        const cleanup = () => {
                          eventSource.close();
                          delete streamHandles.current[sessionId];
                        };

                        eventSource.onmessage = (event) => {
                          try {
                            const chunk = JSON.parse(event.data);
                            
                            pushEvent(sessionId, {
                              id: crypto.randomUUID(),
                              timestamp: Date.now(),
                              type: chunk.type as AgentOSChunkType,
                              payload: chunk,
                            });
                            telemetry.noteChunk(sessionId, chunk);
                            const taskOutcomeAlert = extractTaskOutcomeAlert(chunk);
                            if (taskOutcomeAlert) {
                              noteTaskOutcomeAlert(taskOutcomeAlert, sessionId);
                            }
                            
                            if (chunk.type === 'agency_update') {
                              applyAgencySnapshot((chunk as AgentOSAgencyUpdateChunk).agency);
                            }
                          } catch (error) {
                            console.error('[Agency Stream] Failed to parse chunk:', error);
                          }
                        };

                        eventSource.addEventListener('done', () => {
                          commitSession({ id: sessionId, status: 'idle' });
                          telemetry.endStream(sessionId);
                          cleanup();
                        });

                        eventSource.addEventListener('error', () => {
                          pushEvent(sessionId, {
                            id: crypto.randomUUID(),
                            timestamp: Date.now(),
                            type: 'log',
                            payload: { message: 'Agency stream connection error', level: 'error' },
                          });
                          commitSession({ id: sessionId, status: 'error' });
                          telemetry.endStream(sessionId);
                          cleanup();
                        });

                        eventSource.onerror = (error) => {
                          pushEvent(sessionId, {
                            id: crypto.randomUUID(),
                            timestamp: Date.now(),
                            type: 'log',
                            payload: { message: `Agency stream error: ${error.type}`, level: 'error' },
                          });
                          commitSession({ id: sessionId, status: 'error' });
                          telemetry.endStream(sessionId);
                          cleanup();
                        };
                        
                        streamHandles.current[sessionId] = cleanup;
                      }}
                      disabled={!backendReady || isAgencyStreaming}
                      isSubmitting={isAgencyStreaming}
                    />
                  ) : (
                    <RequestComposer key={activeSessionId || 'compose'} onSubmit={handleSubmit} />
                  )
                )}
                {leftTab === 'personas' && <SuspensePanel label="Personas"><PersonaCatalog /></SuspensePanel>}
                {leftTab === 'agency' && <SuspensePanel label="Agency"><AgencyManager /></SuspensePanel>}
                {leftTab === 'workflows' && <SuspensePanel label="Workflows"><WorkflowOverview /></SuspensePanel>}
                {leftTab === 'evaluation' && <SuspensePanel label="Evaluation"><EvaluationDashboard /></SuspensePanel>}
                {leftTab === 'planning' && <SuspensePanel label="Planning" lines={14}><PlanningDashboard /></SuspensePanel>}
                {leftTab === 'memory' && <SuspensePanel label="Memory"><MemoryDashboard /></SuspensePanel>}
                {leftTab === 'voice' && <SuspensePanel label="Voice"><VoicePipelinePanel /></SuspensePanel>}
                {leftTab === 'strategy' && <SuspensePanel label="Strategy"><AgencyStrategyPanel /></SuspensePanel>}
                {leftTab === 'resources' && <SuspensePanel label="Resources"><ResourceControlsPanel /></SuspensePanel>}
                {leftTab === 'schema' && <SuspensePanel label="Schema"><StructuredOutputBuilder /></SuspensePanel>}
                {leftTab === 'rag' && <SuspensePanel label="RAG" lines={14}><RagWorkspace /></SuspensePanel>}
                {leftTab === 'hitl' && <SuspensePanel label="HITL"><LiveHITLQueue /></SuspensePanel>}
                {leftTab === 'capabilities' && <SuspensePanel label="Capabilities"><CapabilityDiscoveryBrowser /></SuspensePanel>}
                {leftTab === 'marketplace' && <SuspensePanel label="Marketplace"><MarketplaceBrowser /></SuspensePanel>}
                {leftTab === 'graph-builder' && <SuspensePanel label="Graph Builder" lines={14}><GraphBuilder /></SuspensePanel>}
                {leftTab === 'tool-forge' && <SuspensePanel label="Tool Forge" lines={14}><EmergentToolForge /></SuspensePanel>}
                {leftTab === 'channels' && <SuspensePanel label="Channels" lines={12}><ChannelsManager /></SuspensePanel>}
                {leftTab === 'social' && <SuspensePanel label="Social" lines={12}><SocialPostComposer /></SuspensePanel>}
                {leftTab === 'call-monitor' && <SuspensePanel label="Call Monitor"><VoiceCallMonitor /></SuspensePanel>}
                {leftTab === 'guardrail-eval' && <SuspensePanel label="Guardrail Eval"><GuardrailEvaluator /></SuspensePanel>}
                {leftTab === 'observability' && <SuspensePanel label="Observability"><ObservabilityDashboard /></SuspensePanel>}
                {leftTab === 'vision-pipeline' && <SuspensePanel label="Vision Pipeline"><VisionPipelinePanel /></SuspensePanel>}
                {leftTab === 'image-editing' && <SuspensePanel label="Image Editing"><ImageEditingPanel /></SuspensePanel>}
                {leftTab === 'llm-providers' && <SuspensePanel label="LLM Providers"><LLMProviderPanel /></SuspensePanel>}
              </div>
            </section>

            {/* Right Column: Outputs - Stack on mobile, side-by-side on desktop */}
            <aside
              className="flex flex-col gap-2 min-h-[500px] md:min-h-0 md:h-full overflow-hidden"
              aria-label={t("app.labels.outputsPanel", { defaultValue: "Outputs and results" })}
            >
              <div className="flex-1 min-h-0 relative">
                <SuspensePanel label="Session Inspector" lines={16}>
                  <SessionInspector />
                </SuspensePanel>
              </div>
              <details className="flex-none group" open={false}>
                <summary className="cursor-pointer select-none flex items-center gap-2 border-t border-slate-200 dark:border-white/10 px-2 py-1.5 text-[10px] uppercase tracking-[0.3em] theme-text-muted hover:theme-text-secondary transition-colors">
                  <span className="inline-block transition-transform group-open:rotate-90">&#9654;</span>
                  Telemetry &amp; Health
                </summary>
                <div className="max-h-48 overflow-y-auto grid gap-2 sm:grid-cols-2 lg:grid-cols-3 p-2">
                  <section className="card-panel--strong p-2 transition-theme">
                    <header className="mb-1">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.25em] theme-text-muted">Telemetry</h3>
                    </header>
                    <TelemetryView />
                  </section>
                  <section className="card-panel--strong p-2 transition-theme">
                    <header className="mb-1">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.25em] theme-text-muted">Analytics</h3>
                    </header>
                    <AnalyticsView selectedModel={selectedModel} onChangeModel={setSelectedModel} modelOptions={modelOptions} modelData={modelData} />
                  </section>
                  <section className="card-panel--strong p-2 transition-theme">
                    <header className="mb-1">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.25em] theme-text-muted">Health</h3>
                    </header>
                    <TaskOutcomeHealthView liveAlertCount={liveAlertCount} scopeJump={healthScopeJump} />
                  </section>
                </div>
              </details>
            </aside>
          </div>
        </main>
      </div>
      {/* Footer with tagline */}
      <footer className="flex-none border-t theme-border theme-bg-primary px-4 py-2 text-[10px] theme-text-muted transition-theme">
        <div className="mx-auto flex w-full items-center justify-between">
          <span className="uppercase tracking-[0.25em]">AgentOS — Cognitive Operating System</span>
          <div className="flex items-center gap-3">
            <a href="https://agentos.sh" target="_blank" rel="noreferrer" className="transition-colors hover:text-[color:var(--color-accent-primary)]">agentos.sh</a>
            <a href="https://github.com/framerslab/agentos" target="_blank" rel="noreferrer" className="transition-colors hover:text-[color:var(--color-accent-primary)]">GitHub</a>
          </div>
        </div>
      </footer>
      {taskOutcomeAlertToasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2">
          {taskOutcomeAlertToasts.map((alert) => {
            const isCritical = String(alert.severity).toLowerCase() === "critical";
            return (
              <div
                key={alert.id}
                onClick={() => {
                  setHealthScopeJump({ scope: alert.scopeKey, token: Date.now() });
                }}
                title="Click to filter Health by this scope"
                className={`pointer-events-auto cursor-pointer rounded-lg border px-3 py-2 shadow-md ${
                  isCritical
                    ? "border-rose-300 bg-rose-50 text-rose-900"
                    : "border-amber-300 bg-amber-50 text-amber-900"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.25em]">
                      {isCritical ? "Critical KPI alert" : "KPI alert"}
                    </p>
                    <p className="text-xs font-semibold">{alert.scopeKey}</p>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      dismissTaskOutcomeToast(alert.id);
                    }}
                    className="rounded-full border border-current/30 p-1 opacity-80 transition-opacity hover:opacity-100"
                    aria-label="Dismiss alert"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <p className="mt-1 text-xs">{alert.reason}</p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <p className="uppercase tracking-widest opacity-70">Value</p>
                    <p className="font-semibold">{toAlertPercent(alert.value)}</p>
                  </div>
                  <div>
                    <p className="uppercase tracking-widest opacity-70">Threshold</p>
                    <p className="font-semibold">{toAlertPercent(alert.threshold)}</p>
                  </div>
                  <div>
                    <p className="uppercase tracking-widest opacity-70">Samples</p>
                    <p className="font-semibold">{alert.sampleCount}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Suspense fallback={null}>
        <TourOverlay
          open={showTour}
          steps={tourSteps}
          onClose={() => setShowTour(false)}
          onDontShowAgain={() => dismissWelcomeTour()}
          onRemindLater={() => snoozeWelcomeTour(24)}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ImportWizard open={showImport} onClose={() => setShowImport(false)} />
      </Suspense>
      <Suspense fallback={null}>
        <CommandPalette
          open={showCommandPalette}
          onClose={() => setShowCommandPalette(false)}
          onNavigate={(key) => {
            if (key === "settings") {
              setShowSettingsModal(true);
              setShowCommandPalette(false);
              return;
            }
            if (key === "about") {
              setShowAboutModal(true);
              setShowCommandPalette(false);
              return;
            }
            setLeftTab(key as LeftTabKey);
            setShowCommandPalette(false);
          }}
        />
      </Suspense>
    </div>
  );
}
