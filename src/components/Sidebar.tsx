import { clsx } from "clsx";
import { Radio, Plus, CheckCircle2, Users, Github, GitFork, Star, Globe, Store, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState, useMemo, useEffect, useCallback } from "react";
import { useSessionStore } from "@/state/sessionStore";
import { AgentOSChunkType } from "@/types/agentos";
import { LanguageSwitcher } from "./LanguageSwitcher";

interface SidebarProps {
  onCreateSession: (opts?: { targetType?: 'persona' | 'agency'; personaId?: string; agencyId?: string; displayName?: string }) => void;
  onToggleCollapse?: () => void;
  onNavigate?: (key: 'compose' | 'agency' | 'personas' | 'workflows' | 'settings' | 'about') => void;
}

const statusBadgeStyles: Record<string, string> = {
  idle: "border theme-border theme-bg-secondary theme-text-secondary",
  streaming: "theme-bg-success theme-text-on-accent border border-transparent",
  error: "theme-bg-error theme-text-on-accent border border-transparent"
};

export function Sidebar({ onCreateSession, onToggleCollapse, onNavigate }: SidebarProps) {
  const { t } = useTranslation();
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const personas = useSessionStore((state) => state.personas);
  const agencies = useSessionStore((state) => state.agencies);
  const [filter, setFilter] = useState<'all' | 'persona' | 'agency'>('persona');
  const [showNew, setShowNew] = useState(false);
  const [newType, setNewType] = useState<'persona' | 'agency'>('persona');

  const preferDefaultPersona = useCallback((ids: string[]): string | undefined => {
    if (ids.includes('v_researcher')) return 'v_researcher';
    return ids[0];
  }, []);
  const remotePersonaIds = useMemo(() => personas.filter(p => p.source === 'remote').map(p => p.id), [personas]);
  const defaultPersonaId = preferDefaultPersona(remotePersonaIds) ?? personas[0]?.id ?? "";
  const defaultAgencyId = agencies[0]?.id ?? "";
  const [newPersonaId, setNewPersonaId] = useState<string>(defaultPersonaId);
  const [newAgencyId, setNewAgencyId] = useState<string>(defaultAgencyId);
  const [newName, setNewName] = useState<string>("");

  useEffect(() => {
    if (!newPersonaId && defaultPersonaId) {
      setNewPersonaId(defaultPersonaId);
    }
  }, [defaultPersonaId, newPersonaId]);

  useEffect(() => {
    if (!newAgencyId && defaultAgencyId) {
      setNewAgencyId(defaultAgencyId);
    }
  }, [defaultAgencyId, newAgencyId]);

  const personaOptionsAvailable = personas.length > 0;
  const agencyOptionsAvailable = agencies.length > 0;
  const canCreateSession =
    (newType === 'persona' && personaOptionsAvailable && Boolean(newPersonaId)) ||
    (newType === 'agency' && agencyOptionsAvailable && Boolean(newAgencyId));

  const openNew = () => {
    const nextType: 'persona' | 'agency' = filter === 'agency' ? 'agency' : 'persona';
    setNewType(nextType);
    if (nextType === 'agency') {
      setNewAgencyId(defaultAgencyId);
    } else {
      setNewPersonaId(defaultPersonaId);
    }
    setNewName("");
    setShowNew(true);
  };

  const createNew = () => {
    if (!canCreateSession) {
      return;
    }

    const displayName = newName.trim() || undefined;
    if (newType === 'agency') {
      const agencyId = newAgencyId || defaultAgencyId;
      if (!agencyId) {
        return;
      }
      onCreateSession({ targetType: 'agency', agencyId, displayName });
    } else {
      const personaId = newPersonaId || defaultPersonaId;
      if (!personaId) {
        return;
      }
      onCreateSession({ targetType: 'persona', personaId, displayName });
    }
    setFilter(newType);
    setShowNew(false);
    setNewName("");
    setNewPersonaId(defaultPersonaId);
    setNewAgencyId(defaultAgencyId);
  };

  const sortedSessions = useMemo(() => {
    const base = [...sessions];
    const filtered = filter === 'all' ? base : base.filter((s) => s.targetType === filter);
    return filtered.sort((a, b) => {
      const latestA = a.events[0]?.timestamp ?? 0;
      const latestB = b.events[0]?.timestamp ?? 0;
      return latestB - latestA;
    });
  }, [sessions, filter]);

  // Switch session timeline when filter changes
  const handleFilterChange = (newFilter: 'all' | 'persona' | 'agency') => {
    setFilter(newFilter);
    // Auto-switch to first session of the new type
    const filtered = newFilter === 'all' ? sessions : sessions.filter((s) => s.targetType === newFilter);
    if (filtered.length > 0 && filtered[0].id !== activeSessionId) {
      setActiveSession(filtered[0].id);
    }
  };

  return (
    <nav 
      className="flex h-full flex-col theme-bg-primary text-sm transition-theme"
      aria-label={t("sidebar.labels.navigation", { defaultValue: "Session navigation" })}
    >
      {/* Header with branding and controls */}
      <header className="flex flex-shrink-0 flex-col gap-2 border-b theme-border px-4 py-3">
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.1em] theme-text-muted">WORKBENCH</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.35em] theme-accent">Sessions</p>
            <h1 className="sr-only">{t("sidebar.title")}</h1>
          </div>
          <button
            onClick={openNew}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full theme-bg-accent theme-text-on-accent shadow-md transition hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            title={t("sidebar.actions.newSession")}
            aria-label={t("sidebar.actions.newSession")}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="ml-2 rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-2 py-0.5 text-[10px] theme-text-secondary transition hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title="Hide sidebar"
              aria-label="Hide sidebar"
            >
              ◀
            </button>
          )}
        </div>
        
        {/* Quick links (Settings/About) and actions (Tour/Theme/Import) */}
        <div className="mt-1 flex flex-wrap items-center gap-1.5" role="navigation" aria-label="Quick links">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('agentos:open-settings'))}
            className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-2.5 py-0.5 text-[10px] theme-text-secondary transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Settings
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('agentos:open-about'))}
            className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-2.5 py-0.5 text-[10px] theme-text-secondary transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            About
          </button>
          <span className="mx-1 h-3 w-px bg-[color:var(--color-border-primary)]" aria-hidden="true" />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('agentos:toggle-tour'))}
            className="rounded-full px-2.5 py-0.5 text-[10px] theme-bg-warning transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Tour
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('agentos:toggle-theme-panel'))}
            className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-2.5 py-0.5 text-[10px] theme-text-secondary transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Theme
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('agentos:open-import'))}
            className="rounded-full px-2.5 py-0.5 text-[10px] theme-bg-success transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Import
          </button>
        </div>

        {/* Language Control */}
        <div className="flex items-center justify-between gap-2 pt-1" role="toolbar" aria-label={t("sidebar.labels.preferences", { defaultValue: "Preferences" })}>
          <LanguageSwitcher />
        </div>
      </header>
      
      {/* Filter + Session List */}
      <div 
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4 pt-3"
        role="list"
        aria-label={t("sidebar.labels.sessionList", { defaultValue: "Active sessions" })}
      >
        <div className="mb-2 flex items-center gap-1.5 text-xs">
          <button
            onClick={() => handleFilterChange('all')}
            className={clsx(
              'rounded-full border px-2 py-0.5 text-[10px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              filter === 'all'
                ? 'theme-bg-accent theme-text-on-accent border-transparent shadow-sm'
                : 'theme-text-secondary theme-bg-secondary theme-border hover:opacity-95'
            )}
          >
            All
          </button>
          <button
            onClick={() => handleFilterChange('persona')}
            className={clsx(
              'rounded-full border px-2 py-0.5 text-[10px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              filter === 'persona'
                ? 'theme-bg-accent theme-text-on-accent border-transparent shadow-sm'
                : 'theme-text-secondary theme-bg-secondary theme-border hover:opacity-95'
            )}
          >
            Persona
          </button>
          <button
            onClick={() => handleFilterChange('agency')}
            className={clsx(
              'rounded-full border px-2 py-0.5 text-[10px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              filter === 'agency'
                ? 'theme-bg-accent theme-text-on-accent border-transparent shadow-sm'
                : 'theme-text-secondary theme-bg-secondary theme-border hover:opacity-95'
            )}
          >
            Agency
          </button>
        </div>
        {sortedSessions.length === 0 ? (
          <div 
            className="rounded-lg border theme-border theme-bg-secondary-soft p-3 text-xs theme-text-secondary transition-theme"
            role="status"
          >
            {t("sidebar.emptyState")}
          </div>
        ) : (
          sortedSessions.map((session) => {
            const status = session.status;
            const statusLabel = t(`common.status.${status}` as const, { defaultValue: status });
            const isActive = activeSessionId === session.id;
            
            const targetBadge =
              session.targetType === "agency" ? (
                <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.4em] theme-accent">
                  <Users className="h-2.5 w-2.5" aria-hidden="true" /> {t("sidebar.badges.agency")}
                </span>
              ) : (
                <span className="text-[9px] font-semibold uppercase tracking-[0.4em] theme-text-muted">
                  {t("sidebar.badges.persona")}
                </span>
              );
              
            return (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className={clsx(
                  "flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
                  isActive 
                    ? "theme-bg-secondary-soft border theme-border-strong shadow-md" 
                    : "border theme-border theme-bg-secondary hover:opacity-95"
                )}
                role="listitem"
                aria-label={t("sidebar.session.ariaLabel", { 
                  defaultValue: "Session {{name}}, status: {{status}}", 
                  name: session.displayName, 
                  status: statusLabel 
                })}
                aria-current={isActive ? "page" : undefined}
              >
                {/* Status Badge */}
                <div className="flex items-center justify-between text-[10px]">
                    <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-widest theme-text-muted">
                      <Radio className="h-2.5 w-2.5 theme-accent" aria-hidden="true" />
                    <span className="sr-only">{t("sidebar.session.streamLabel")}</span>
                  </span>
                  <span 
                    className={clsx(
                      "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest",
                      statusBadgeStyles[status]
                    )}
                    role="status"
                    aria-live="polite"
                  >
                    {statusLabel}
                  </span>
                </div>
                
                {/* Session Info */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold theme-text-primary truncate pr-2">
                      {session.displayName}
                    </p>
                    {targetBadge}
                  </div>
                  <p className="text-[10px] theme-text-secondary mt-0.5">
                    {session.events.length === 0
                      ? t("sidebar.session.noActivity")
                      : new Date(session.events[0]!.timestamp).toLocaleTimeString()}
                  </p>
                </div>
                
                {/* Completion Indicator */}
                {session.events.find((event) => event.type === AgentOSChunkType.FINAL_RESPONSE) && (
                  <div className="flex items-center gap-1.5 text-[10px] theme-accent">
                    <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
                    <span>{t("sidebar.session.completedTurn")}</span>
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md card-panel--strong p-5 shadow-xl transition-theme">
            <header className="mb-3">
              <h3 className="text-sm font-semibold theme-text-primary">New session</h3>
            </header>
            <div className="space-y-3 text-sm theme-text-secondary">
              <div className="flex items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    checked={newType==='persona'}
                    onChange={() => {
                      setNewType('persona');
                      setNewPersonaId(defaultPersonaId);
                    }}
                  />
                  <span>Persona</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    checked={newType==='agency'}
                    onChange={() => {
                      setNewType('agency');
                      setNewAgencyId(defaultAgencyId);
                    }}
                    disabled={!agencyOptionsAvailable}
                  />
                  <span className={!agencyOptionsAvailable ? "theme-text-muted" : undefined}>Agency</span>
                </label>
              </div>
              {newType === 'persona' ? (
                <label className="block">
                  <span className="mb-1 block text-xs theme-text-muted">Persona</span>
                  {personaOptionsAvailable ? (
                    <select
                      value={newPersonaId}
                      onChange={(e)=>setNewPersonaId(e.target.value)}
                      className="w-full rounded-lg border theme-border bg-[color:var(--color-background-secondary)] px-3 py-2 text-sm theme-text-primary"
                    >
                      {[...personas].map(p => (
                        <option key={p.id} value={p.id}>{p.displayName}</option>
                      ))}
                    </select>
                  ) : (
                    <p className="rounded-lg border theme-border bg-[color:var(--color-background-secondary)] px-3 py-2 text-xs theme-text-secondary">
                      No personas available. Create or import one from the Personas tab.
                    </p>
                  )}
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-xs theme-text-muted">Agency</span>
                  {agencyOptionsAvailable ? (
                    <div className="space-y-2">
                      <select
                        value={newAgencyId}
                        onChange={(e)=>setNewAgencyId(e.target.value)}
                        className="w-full rounded-lg border theme-border bg-[color:var(--color-background-secondary)] px-3 py-2 text-sm theme-text-primary"
                      >
                        {[...agencies].map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setShowNew(false);
                          window.dispatchEvent(new CustomEvent('agentos:open-agency-wizard'));
                        }}
                        className="inline-flex items-center gap-2 text-xs theme-text-secondary underline decoration-dotted hover:theme-accent"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-sky-500" />
                        Launch agency wizard
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-lg border theme-border bg-[color:var(--color-background-secondary)] px-3 py-2 text-xs theme-text-secondary">
                      <p>No agencies have been defined yet.</p>
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate?.('agency');
                          setShowNew(false);
                        }}
                        className="rounded-full px-3 py-1 text-xs font-semibold theme-bg-warning hover:opacity-95"
                      >
                        Open Agency Manager
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowNew(false);
                          window.dispatchEvent(new CustomEvent('agentos:open-agency-wizard'));
                        }}
                        className="rounded-full px-3 py-1 text-xs font-semibold theme-bg-accent hover:opacity-95"
                      >
                        Launch Wizard
                      </button>
                    </div>
                  )}
                </label>
              )}
              <label className="block">
                <span className="mb-1 block text-xs theme-text-muted">Name (optional)</span>
                <input
                  value={newName}
                  onChange={(e)=>setNewName(e.target.value)}
                  className="w-full rounded-lg border theme-border bg-[color:var(--color-background-secondary)] px-3 py-2 text-sm theme-text-primary"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={()=>setShowNew(false)}
                className="rounded-full border theme-border bg-[color:var(--color-background-secondary)] px-3 py-1 text-xs theme-text-secondary transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Cancel
              </button>
              <button
                onClick={createNew}
                disabled={!canCreateSession}
                className={clsx(
                  "rounded-full px-3 py-1 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  canCreateSession
                    ? "theme-bg-accent theme-text-on-accent hover:opacity-95"
                    : "cursor-not-allowed border theme-border theme-bg-secondary theme-text-muted"
                )}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Footer links */}
      <footer className="mt-auto border-t theme-border px-4 py-2 text-[10px] theme-text-secondary transition-theme">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <a
            href="https://vca.chat"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 theme-accent transition-transform duration-200 hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
          >
            <Store className="h-3.5 w-3.5 transition-transform group-hover:scale-110" aria-hidden="true" />
            <span className="uppercase tracking-[0.35em]">Marketplace</span>
          </a>
          <div className="flex items-center gap-1.5 pr-2">
            <a
              href="https://agentos.sh"
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-transform duration-200 hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
            >
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">agentos.sh</span>
            </a>
            <a
              href="https://frame.dev"
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-transform duration-200 hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
            >
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">frame.dev</span>
            </a>
            <a
              href="https://github.com/framerslab/agentos"
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-transform duration-200 hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
            >
              <Github className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
            <a
              href="https://github.com/framerslab/agentos/stargazers"
              target="_blank"
              rel="noreferrer"
              aria-label="Star AgentOS on GitHub"
              className="group inline-flex items-center rounded-full p-1 pr-1.5 transition-transform duration-200 hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
            >
              <Star className="h-3.5 w-3.5 text-yellow-500 transition-transform group-active:scale-90" aria-hidden="true" />
            </a>
            <a
              href="https://github.com/framerslab/agentos/fork"
              target="_blank"
              rel="noreferrer"
              aria-label="Fork AgentOS on GitHub"
              className="group inline-flex items-center rounded-full p-1 transition-transform duration-200 hover:-translate-y-0.5 hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
            >
              <GitFork className="h-3.5 w-3.5 transition-transform group-active:scale-90" aria-hidden="true" />
            </a>
          </div>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="ml-auto rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 dark:border-white/10 dark:text-slate-300 dark:focus-visible:ring-offset-slate-950"
              title="Hide sidebar"
            >
              Hide
            </button>
          )}
        </div>
      </footer>
    </nav>
  );
}
