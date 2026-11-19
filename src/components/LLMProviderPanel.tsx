/**
 * @file LLMProviderPanel.tsx
 * @description LLM provider status dashboard showing all 9 supported providers
 * with configuration status, capabilities, and connectivity testing.
 *
 * Features:
 *   - Grid of 9 providers with status badges (configured / not configured)
 *   - For each: env var name, available models, capabilities (vision, tools,
 *     streaming, embedding)
 *   - "Test" button to verify the API key works
 *   - Cost tier indicator ($, $$, $$$)
 *
 * State is local to the panel. Fetches status from
 * `GET /api/llm/providers` on mount and supports manual refresh.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  RefreshCw,
  Zap,
  Eye,
  Wrench,
  MessageSquare,
  Database,
  type LucideIcon,
} from 'lucide-react';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { resolveWorkbenchApiBaseUrl } from '@/lib/agentosClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  id: string;
  name: string;
  envVar: string;
  configured: boolean;
  defaultModel: string;
  models: string[];
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    vision: boolean;
    embedding: boolean;
  };
  costTier: 1 | 2 | 3;
}

/** Fallback provider list used when the backend is unreachable. */
const FALLBACK_PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', configured: false,
    defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-luna'],
    capabilities: { streaming: true, toolCalling: true, vision: true, embedding: true },
    costTier: 3,
  },
  {
    id: 'anthropic', name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', configured: false,
    defaultModel: 'claude-sonnet-4-0', models: ['claude-sonnet-4-0', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    capabilities: { streaming: true, toolCalling: true, vision: true, embedding: false },
    costTier: 3,
  },
  {
    id: 'gemini', name: 'Google Gemini', envVar: 'GEMINI_API_KEY', configured: false,
    defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    capabilities: { streaming: true, toolCalling: true, vision: true, embedding: true },
    costTier: 2,
  },
  {
    id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY', configured: false,
    defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    capabilities: { streaming: true, toolCalling: true, vision: false, embedding: false },
    costTier: 1,
  },
  {
    id: 'together', name: 'Together AI', envVar: 'TOGETHER_API_KEY', configured: false,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', models: ['Llama-3.3-70B', 'Llama-3.1-405B', 'Mixtral-8x22B'],
    capabilities: { streaming: true, toolCalling: true, vision: false, embedding: true },
    costTier: 1,
  },
  {
    id: 'mistral', name: 'Mistral AI', envVar: 'MISTRAL_API_KEY', configured: false,
    defaultModel: 'mistral-large-latest', models: ['mistral-large-latest', 'codestral-latest', 'mistral-small-latest'],
    capabilities: { streaming: true, toolCalling: true, vision: false, embedding: true },
    costTier: 2,
  },
  {
    id: 'xai', name: 'xAI (Grok)', envVar: 'XAI_API_KEY', configured: false,
    defaultModel: 'grok-2', models: ['grok-2', 'grok-2-mini'],
    capabilities: { streaming: true, toolCalling: true, vision: true, embedding: false },
    costTier: 2,
  },
  {
    id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', configured: false,
    defaultModel: 'openai/gpt-4o', models: ['200+ models'],
    capabilities: { streaming: true, toolCalling: true, vision: true, embedding: true },
    costTier: 2,
  },
  {
    id: 'ollama', name: 'Ollama', envVar: 'OLLAMA_BASE_URL', configured: false,
    defaultModel: 'llama3.2', models: ['llama3.2', 'codellama', 'dolphin-mixtral', 'mistral'],
    capabilities: { streaming: true, toolCalling: false, vision: false, embedding: true },
    costTier: 1,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CostBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const labels = { 1: '$', 2: '$$', 3: '$$$' };
  const colors = {
    1: 'text-green-500',
    2: 'text-yellow-500',
    3: 'text-orange-500',
  };
  return (
    <span className={`text-[10px] font-bold ${colors[tier]}`} title={`Cost tier: ${labels[tier]}`}>
      {labels[tier]}
    </span>
  );
}

function CapBadge({ enabled, icon: Icon, label }: { enabled: boolean; icon: LucideIcon; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded ${
        enabled ? 'theme-bg-success/10 text-green-600' : 'theme-bg-secondary theme-text-muted'
      }`}
      title={`${label}: ${enabled ? 'supported' : 'not supported'}`}
    >
      <Icon size={8} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function LLMProviderPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>(FALLBACK_PROVIDERS);
  const [loading, setLoading] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'fail' | null>>({});

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const base = resolveWorkbenchApiBaseUrl();
      const res = await fetch(`${base}/api/llm/providers`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.providers)) {
          setProviders(data.providers);
        }
      }
    } catch {
      // Use fallback list
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleTest = useCallback(async (providerId: string) => {
    setTestingId(providerId);
    setTestResults((prev) => ({ ...prev, [providerId]: null }));
    try {
      const base = resolveWorkbenchApiBaseUrl();
      const res = await fetch(`${base}/api/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      setTestResults((prev) => ({ ...prev, [providerId]: res.ok ? 'ok' : 'fail' }));
    } catch {
      setTestResults((prev) => ({ ...prev, [providerId]: 'fail' }));
    } finally {
      setTestingId(null);
    }
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b theme-border px-2 py-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <Zap size={12} className="theme-text-accent" />
          <p className="text-[10px] uppercase tracking-[0.3em] theme-text-muted font-semibold">LLM Providers</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchProviders}
            disabled={loading}
            className="p-1 rounded hover:theme-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} className={`theme-text-muted ${loading ? 'animate-spin' : ''}`} />
          </button>
          <HelpTooltip label="Explain LLM provider panel" side="bottom">
            9 LLM providers supported. Set an API key to configure a provider. Use Test to verify connectivity.
          </HelpTooltip>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid gap-2">
          {providers.map((prov) => {
            const testStatus = testResults[prov.id];
            return (
              <div
                key={prov.id}
                className={`card-panel--strong p-2 border-l-2 transition-colors ${
                  prov.configured ? 'border-l-green-500' : 'border-l-gray-400'
                }`}
              >
                {/* Provider header */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    {prov.configured ? (
                      <CheckCircle2 size={12} className="text-green-500" />
                    ) : (
                      <XCircle size={12} className="text-gray-400" />
                    )}
                    <span className="text-xs font-semibold">{prov.name}</span>
                    <CostBadge tier={prov.costTier} />
                  </div>
                  <div className="flex items-center gap-1">
                    {testStatus === 'ok' && <CheckCircle2 size={10} className="text-green-500" />}
                    {testStatus === 'fail' && <XCircle size={10} className="text-red-500" />}
                    <button
                      onClick={() => handleTest(prov.id)}
                      disabled={!prov.configured || testingId === prov.id}
                      className="text-[9px] px-1.5 py-0.5 rounded border theme-border hover:theme-bg-hover disabled:opacity-40 transition-colors"
                      title={prov.configured ? 'Test connectivity' : 'Not configured'}
                    >
                      {testingId === prov.id ? (
                        <RefreshCw size={8} className="animate-spin inline" />
                      ) : (
                        'Test'
                      )}
                    </button>
                  </div>
                </div>

                {/* Env var + default model */}
                <div className="text-[10px] theme-text-muted mb-1 flex items-center gap-2">
                  <code className="font-mono">{prov.envVar}</code>
                  <span className="theme-text-muted">|</span>
                  <span>Default: <code className="font-mono">{prov.defaultModel}</code></span>
                </div>

                {/* Capabilities */}
                <div className="flex flex-wrap gap-1">
                  <CapBadge enabled={prov.capabilities.streaming} icon={MessageSquare} label="Stream" />
                  <CapBadge enabled={prov.capabilities.toolCalling} icon={Wrench} label="Tools" />
                  <CapBadge enabled={prov.capabilities.vision} icon={Eye} label="Vision" />
                  <CapBadge enabled={prov.capabilities.embedding} icon={Database} label="Embed" />
                </div>

                {/* Models list */}
                <div className="mt-1 text-[9px] theme-text-muted">
                  Models: {prov.models.join(', ')}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
