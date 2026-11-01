import type { AgentSession, PersonaDefinition, SessionEvent } from "@/state/sessionStore";
import { AgentOSChunkType } from "@/types/agentos";
import { createAgentOSStorageAdapter } from "./agentosStorage";
import { loadRecentSessionEventRows, MAX_EVENTS_PER_SESSION } from "./sessionEventRows";
import type { StorageAdapter } from "@framers/sql-storage-adapter/types";

const DEFAULT_USER_ID = "agentos-workbench-user";
const DEFAULT_DB_NAME = "agentos-workbench-db";

type SqlRow = Record<string, unknown>;

interface BootstrapPayload {
  sessions: AgentSession[];
  personas: PersonaDefinition[];
}

let adapterPromise: Promise<StorageAdapter> | null = null;

async function getAdapter(): Promise<StorageAdapter> {
  if (!adapterPromise) {
    adapterPromise = createAgentOSStorageAdapter(DEFAULT_DB_NAME);
  }
  return adapterPromise;
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function serialise(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export async function bootstrapStorage(): Promise<BootstrapPayload> {
  const adapter = await getAdapter();
  const sessionRows = (await adapter.all(
    `SELECT id, display_name, target_type, target_id, metadata, created_at, updated_at
     FROM sessions
     WHERE user_id = ?
     ORDER BY updated_at DESC`,
    [DEFAULT_USER_ID]
  )) as SqlRow[];

  const eventsRows = await loadRecentSessionEventRows(adapter);

  const groupedEvents = new Map<string, SessionEvent[]>();
  for (const row of eventsRows) {
    const sessionId = String(row.conversation_id);
    const payload = parseJson<SessionEvent["payload"]>(row.event_data) ?? { message: "Unknown payload" };
    const event: SessionEvent = {
      id: row.event_id ? String(row.event_id) : crypto.randomUUID(),
      timestamp: typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp ?? Date.now()),
      type: (row.event_type as SessionEvent["type"]) ?? "log",
      payload
    };
    const current = groupedEvents.get(sessionId) ?? [];
    if (current.length < MAX_EVENTS_PER_SESSION) {
      current.push(event);
      groupedEvents.set(sessionId, current);
    }
  }

  const sessions: AgentSession[] = sessionRows.map((row) => {
    const metadata = parseJson<Record<string, unknown>>(row.metadata) ?? {};
    const targetType = (row.target_type as AgentSession["targetType"]) ?? "persona";
    const events = groupedEvents.get(String(row.id)) ?? [];
    events.sort((a, b) => b.timestamp - a.timestamp);
    return {
      id: String(row.id),
      targetType,
      displayName: (row.display_name as string) ?? "Untitled session",
      personaId: targetType === "persona" ? (metadata.personaId as string | undefined) ?? (row.target_id as string) : undefined,
      agencyId: targetType === "agency" ? (metadata.agencyId as string | undefined) ?? (row.target_id as string) : undefined,
      status: "idle",
      events
    };
  });

  const personaRows = (await adapter.all(
    `SELECT id, display_name, description, definition
     FROM personas
     ORDER BY updated_at DESC`
  )) as SqlRow[];

  const personas: PersonaDefinition[] = personaRows.map((row) => {
    const definition = parseJson<Partial<PersonaDefinition>>(row.definition);
    return {
      id: String(row.id),
      displayName: (row.display_name as string) ?? String(row.id),
      description: (row.description as string) ?? definition?.description,
      tags: definition?.tags,
      traits: definition?.traits,
      capabilities: definition?.capabilities,
      metadata: definition?.metadata,
      source: "local"
    };
  });

  return { sessions, personas };
}

export async function persistSessionRow(session: AgentSession): Promise<void> {
  const adapter = await getAdapter();
  const targetId = session.targetType === "agency" ? session.agencyId ?? "agency" : session.personaId ?? "persona";
  const timestamp = Date.now();

  await adapter.run(
    `INSERT INTO sessions (id, user_id, display_name, target_type, target_id, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       target_type = excluded.target_type,
       target_id = excluded.target_id,
       updated_at = excluded.updated_at,
       metadata = excluded.metadata`,
    [
      session.id,
      DEFAULT_USER_ID,
      session.displayName,
      session.targetType,
      targetId,
      timestamp,
      timestamp,
      serialise({
        status: session.status,
        personaId: session.personaId,
        agencyId: session.agencyId
      })
    ]
  );
}

export async function persistSessionEventRow(session: AgentSession, event: SessionEvent): Promise<void> {
  const adapter = await getAdapter();
  const timestamp = event.timestamp ?? Date.now();
  await adapter.run(
    `INSERT INTO conversations (id, user_id, persona_id, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, json(?))
     ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
       metadata = excluded.metadata`,
    [
      session.id,
      DEFAULT_USER_ID,
      session.personaId ?? "agency",
      timestamp,
      timestamp,
      serialise({
        targetType: session.targetType,
        agencyId: session.agencyId,
        personaId: session.personaId
      })
    ]
  );

  await adapter.run(
    `INSERT INTO conversation_events (conversation_id, event_type, event_data, timestamp)
     VALUES (?, ?, json(?), ?)`,
    [session.id, event.type ?? "log", serialise(event.payload), timestamp]
  );

  if (event.type === AgentOSChunkType.FINAL_RESPONSE) {
    const usage = (event.payload as { usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } })?.usage;
    await adapter.run(
      `INSERT INTO telemetry (session_id, event_type, event_data, timestamp)
       VALUES (?, ?, json(?), ?)`,
      [session.id, "final_response", serialise({ usage }), timestamp]
    );
  }
}

export async function persistPersonaRow(persona: PersonaDefinition): Promise<void> {
  const adapter = await getAdapter();
  const timestamp = Date.now();
  await adapter.run(
    `INSERT INTO personas (id, display_name, description, definition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       description = excluded.description,
       definition = excluded.definition,
       updated_at = excluded.updated_at`,
    [
      persona.id,
      persona.displayName,
      persona.description ?? null,
      serialise({
        description: persona.description,
        tags: persona.tags,
        traits: persona.traits,
        capabilities: persona.capabilities,
        metadata: persona.metadata
      }),
      timestamp,
      timestamp
    ]
  );
}

export async function deleteSessionRow(sessionId: string): Promise<void> {
  const adapter = await getAdapter();
  await adapter.run(`DELETE FROM conversation_events WHERE conversation_id = ?`, [sessionId]);
  await adapter.run(`DELETE FROM conversations WHERE id = ?`, [sessionId]);
  await adapter.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

export async function clearSessionEvents(sessionId: string): Promise<void> {
  const adapter = await getAdapter();
  await adapter.run(`DELETE FROM conversation_events WHERE conversation_id = ?`, [sessionId]);
  await adapter.run(`DELETE FROM telemetry WHERE session_id = ?`, [sessionId]);
}
