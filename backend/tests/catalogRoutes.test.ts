import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

test('skills routes expose registry-backed catalog and detail', async () => {
  const { default: skillRoutes } = await import('../src/routes/skills');
  const app = Fastify();
  await app.register(skillRoutes, { prefix: '/api/agentos' });

  try {
    const skillsResponse = await app.inject({ method: 'GET', url: '/api/agentos/skills' });
    assert.equal(skillsResponse.statusCode, 200);
    const skills = skillsResponse.json();
    assert.ok(Array.isArray(skills));
    assert.ok(skills.length >= 30);

    const webSearch = skills.find((skill: { name?: string }) => skill.name === 'web-search');
    assert.ok(webSearch);
    assert.equal(webSearch.displayName, 'web-search');
    assert.equal(typeof webSearch.source, 'string');
    assert.ok(Array.isArray(webSearch.requiresTools));

    const detailResponse = await app.inject({
      method: 'GET',
      url: '/api/agentos/skills/web-search',
    });
    assert.equal(detailResponse.statusCode, 200);
    const detail = detailResponse.json();
    assert.equal(detail.name, 'web-search');
    assert.equal(detail.enabled, false);
    assert.ok(typeof detail.content === 'string');
    assert.ok(detail.content.includes('# Web Search'));
    assert.ok(!detail.content.startsWith('---'));

    const enableResponse = await app.inject({
      method: 'POST',
      url: '/api/agentos/skills/enable',
      payload: { name: 'web-search' },
    });
    assert.equal(enableResponse.statusCode, 200);

    const activeResponse = await app.inject({ method: 'GET', url: '/api/agentos/skills/active' });
    assert.equal(activeResponse.statusCode, 200);
    const active = activeResponse.json();
    assert.ok(Array.isArray(active));
    assert.ok(active.some((skill: { name?: string }) => skill.name === 'web-search'));
  } finally {
    await app.close();
  }
});

test('agentos routes expose registry-backed extensions, tools, and guardrails', async () => {
  const { graphRunStore } = await import('../src/services/graphRunStore');
  const { default: agentosRoutes } = await import('../src/routes/agentos');
  // In the parent monorepo every pack's directory and manifest sit beside the workbench. A
  // standalone checkout reads the catalog from the @framers/agentos-extensions package, and a
  // pack counts as installed there only when its npm package resolves; the backend depends on
  // none of them.
  const { isMonorepoExtensionsCatalog } = await import('../src/lib/registryCatalog');
  const inMonorepo = isMonorepoExtensionsCatalog();
  const app = Fastify();
  await app.register(agentosRoutes, { prefix: '/api/agentos' });

  try {
    const extensionsResponse = await app.inject({ method: 'GET', url: '/api/agentos/extensions' });
    assert.equal(extensionsResponse.statusCode, 200);
    const extensions = extensionsResponse.json();
    assert.ok(Array.isArray(extensions));
    assert.ok(extensions.length >= 50);

    const webchat = extensions.find((extension: { package?: string }) =>
      extension.package === '@framers/agentos-ext-channel-webchat'
    );
    assert.ok(webchat);
    assert.equal(webchat.installed, inMonorepo);
    assert.equal(webchat.category, 'channels');
    assert.ok(Array.isArray(webchat.platforms));
    if (inMonorepo) {
      assert.ok(webchat.platforms.includes('webchat'));
    }

    const installCandidate = extensions.find((extension: { installed?: boolean }) => extension.installed === false);

    const installResponse = await app.inject({
      method: 'POST',
      url: '/api/agentos/extensions/install',
      payload: { package: installCandidate?.package ?? '@framers/agentos-ext-channel-webchat' },
    });
    assert.equal(installResponse.statusCode, 200);
    assert.equal(installResponse.json().installed, true);

    if (installCandidate) {
      const refreshedExtensionsResponse = await app.inject({ method: 'GET', url: '/api/agentos/extensions' });
      assert.equal(refreshedExtensionsResponse.statusCode, 200);
      const refreshedExtensions = refreshedExtensionsResponse.json();
      assert.equal(
        refreshedExtensions.find((extension: { id?: string }) => extension.id === installCandidate.id)?.installed,
        true
      );
    }

    const toolsResponse = await app.inject({ method: 'GET', url: '/api/agentos/extensions/tools' });
    assert.equal(toolsResponse.statusCode, 200);
    const tools = toolsResponse.json();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.some((tool: { id?: string }) => tool.id === 'webchatChannel'));

    const guardrailsResponse = await app.inject({ method: 'GET', url: '/api/agentos/guardrails' });
    assert.equal(guardrailsResponse.statusCode, 200);
    const guardrails = guardrailsResponse.json();
    assert.equal(guardrails.tier, 'balanced');
    assert.equal(guardrails.packs.length, 5);
    assert.ok(guardrails.packs.every((pack: { installed?: boolean }) => pack.installed === inMonorepo));

    const configureResponse = await app.inject({
      method: 'POST',
      url: '/api/agentos/guardrails/configure',
      payload: {
        tier: 'paranoid',
        packs: {
          piiRedaction: true,
          mlClassifiers: true,
          topicality: true,
          codeSafety: true,
          groundingGuard: true,
        },
      },
    });
    assert.equal(configureResponse.statusCode, 200);

    const updatedGuardrailsResponse = await app.inject({ method: 'GET', url: '/api/agentos/guardrails' });
    assert.equal(updatedGuardrailsResponse.statusCode, 200);
    const updatedGuardrails = updatedGuardrailsResponse.json();
    assert.equal(updatedGuardrails.tier, 'paranoid');
    assert.ok(
      updatedGuardrails.packs.every((pack: { enabled?: boolean }) => pack.enabled === true)
    );

    const runtimeResponse = await app.inject({ method: 'GET', url: '/api/agentos/runtime' });
    assert.equal(runtimeResponse.statusCode, 200);
    const runtime = runtimeResponse.json();
    assert.equal(typeof runtime.modernApi.generateText, 'boolean');
    assert.equal(typeof runtime.modernApi.streamText, 'boolean');
    assert.equal(typeof runtime.modernApi.generateImage, 'boolean');
    assert.equal(typeof runtime.modernApi.agentFactory, 'boolean');
    assert.equal(typeof runtime.orchestrationApi.agentGraph, 'boolean');
    assert.equal(typeof runtime.orchestrationApi.workflowBuilder, 'boolean');
    assert.equal(typeof runtime.orchestrationApi.missionBuilder, 'boolean');
    assert.equal(typeof runtime.orchestrationApi.graphRuntime, 'boolean');
    assert.equal(typeof runtime.orchestrationApi.checkpointStore, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.workflowExecution, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.agencyExecution, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.planningDashboardBackedByRuntime, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.graphRunRecords, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.graphInspectionUi, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.checkpointResumeUi, 'boolean');
    assert.equal(typeof runtime.workbenchIntegration.note, 'string');
    assert.equal(runtime.workbenchIntegration.planningDashboardBackedByRuntime, true);
    assert.equal(runtime.workbenchIntegration.graphRunRecords, true);
    assert.equal(runtime.workbenchIntegration.graphInspectionUi, true);
    assert.equal(runtime.workbenchIntegration.checkpointResumeUi, true);
    assert.ok(runtime.catalogs.extensions >= 50);
    assert.ok(runtime.catalogs.tools >= 10);

    const startWorkflowResponse = await app.inject({
      method: 'POST',
      url: '/api/agentos/agency/workflow/start',
      payload: {
        workflowId: 'local.research-and-publish',
        input: { topic: 'Quantum Computing Breakthroughs' },
        userId: 'agentos-workbench-user',
      },
    });
    assert.equal(startWorkflowResponse.statusCode, 200);
    const startedWorkflow = startWorkflowResponse.json();
    assert.equal(startedWorkflow.status, 'started');
    assert.equal(startedWorkflow.workflowId, 'local.research-and-publish');
    assert.equal(typeof startedWorkflow.executionId, 'string');
    assert.equal(typeof startedWorkflow.conversationId, 'string');

    const graphRunsResponse = await app.inject({ method: 'GET', url: '/api/agentos/graph-runs' });
    assert.equal(graphRunsResponse.statusCode, 200);
    const graphRuns = graphRunsResponse.json();
    assert.ok(Array.isArray(graphRuns));
    assert.ok(graphRuns.some((run: { runId?: string }) => run.runId === startedWorkflow.executionId));

    const graphRunDetailResponse = await app.inject({
      method: 'GET',
      url: `/api/agentos/graph-runs/${encodeURIComponent(startedWorkflow.executionId)}`,
    });
    assert.equal(graphRunDetailResponse.statusCode, 200);
    assert.equal(graphRunDetailResponse.json().runId, startedWorkflow.executionId);

    const checkpointRunId = `graph-run-contract-${Date.now()}`;
    graphRunStore.beginRun({
      runId: checkpointRunId,
      source: 'workflow',
      goal: 'Checkpoint contract test',
      workflowId: 'local.research-and-publish',
      conversationId: 'graph-run-contract-conversation',
    });
    const syncedRun = graphRunStore.syncWorkflowSnapshot({
      runId: checkpointRunId,
      source: 'workflow',
      goal: 'Checkpoint contract test',
      workflowId: 'local.research-and-publish',
      conversationId: 'graph-run-contract-conversation',
      workflow: {
        status: 'running',
        tasks: {
          gather: {
            status: 'in_progress',
            assignedRoleId: 'researcher',
            metadata: { displayName: 'Gather context' },
          },
        },
      },
    });
    const checkpointId = syncedRun.checkpoints[0]?.checkpointId;
    assert.ok(checkpointId);

    graphRunStore.syncWorkflowSnapshot({
      runId: checkpointRunId,
      source: 'workflow',
      goal: 'Checkpoint contract test',
      workflowId: 'local.research-and-publish',
      conversationId: 'graph-run-contract-conversation',
      workflow: {
        status: 'running',
        tasks: {
          gather: {
            status: 'completed',
            assignedRoleId: 'researcher',
            metadata: { displayName: 'Gather context' },
          },
          summarize: {
            status: 'in_progress',
            assignedRoleId: 'writer',
            metadata: { displayName: 'Summarize' },
          },
        },
      },
    });

    const restoreCheckpointResponse = await app.inject({
      method: 'POST',
      url: `/api/agentos/graph-runs/${encodeURIComponent(checkpointRunId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
    });
    assert.equal(restoreCheckpointResponse.statusCode, 200);
    const restoredRun = restoreCheckpointResponse.json();
    assert.equal(restoredRun.runId, checkpointRunId);
    assert.equal(restoredRun.tasks.length, 1);

    const forkCheckpointResponse = await app.inject({
      method: 'POST',
      url: `/api/agentos/graph-runs/${encodeURIComponent(checkpointRunId)}/checkpoints/${encodeURIComponent(checkpointId)}/fork`,
    });
    assert.equal(forkCheckpointResponse.statusCode, 200);
    const forkedPlan = forkCheckpointResponse.json();
    assert.equal(forkedPlan.readOnly, false);
    assert.equal(typeof forkedPlan.planId, 'string');
    assert.ok(Array.isArray(forkedPlan.steps));
  } finally {
    await app.close();
  }
});

test('memory routes expose live cognitive memory data when runtime is initialized', async () => {
  const { default: memoryRoutes } = await import('../src/routes/memory');
  const { getAgentOS, initializeAgentOS } = await import('../src/lib/agentos');

  await initializeAgentOS();
  const agentos = await getAgentOS();
  const personas = await agentos.listAvailablePersonas('workbench-test-user');
  const personaId = (personas[0] as { id?: string } | undefined)?.id ?? 'default';
  const gmiManager = agentos.getGMIManager?.() as any;
  assert.ok(gmiManager);

  const { gmi } = await gmiManager.getOrCreateGMIForSession(
    'workbench-test-user',
    'workbench-test-session',
    personaId,
  );
  const cognitiveMemory = gmi.getCognitiveMemoryManager?.() as any;
  assert.ok(cognitiveMemory);

  await cognitiveMemory.encode(
    'User prefers concise, technical answers.',
    { valence: 0, arousal: 0, dominance: 0 },
    'neutral',
    {
      type: 'episodic',
      sourceType: 'user_statement',
      scopeId: 'workbench-test-user',
      tags: ['preference'],
    },
  );
  await cognitiveMemory.encode(
    'Assistant should favor precise implementation details over marketing language.',
    { valence: 0, arousal: 0, dominance: 0 },
    'analytical',
    {
      type: 'semantic',
      sourceType: 'agent_inference',
      scopeId: 'workbench-test-session',
      tags: ['style'],
    },
  );

  const app = Fastify();
  await app.register(memoryRoutes, { prefix: '/api/agentos' });

  try {
    const statsResponse = await app.inject({ method: 'GET', url: '/api/agentos/memory/stats' });
    assert.equal(statsResponse.statusCode, 200);
    const stats = statsResponse.json();
    assert.equal(stats.connected, true);
    assert.ok(stats.episodic.count >= 1);
    assert.ok(stats.semantic.count >= 1);

    const entriesResponse = await app.inject({ method: 'GET', url: '/api/agentos/memory/entries' });
    assert.equal(entriesResponse.statusCode, 200);
    const entries = entriesResponse.json();
    assert.equal(entries.connected, true);
    assert.ok(Array.isArray(entries.episodic));
    assert.ok(entries.episodic.some((entry: { content?: string }) =>
      entry.content?.includes('prefers concise, technical answers')
    ));
    assert.ok(entries.semantic.some((entry: { content?: string }) =>
      entry.content?.includes('precise implementation details')
    ));

    const liveId = entries.episodic[0]?.id;
    assert.ok(typeof liveId === 'string');

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/agentos/memory/entries/${encodeURIComponent(liveId)}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.json().ok, true);

    const afterDeleteResponse = await app.inject({ method: 'GET', url: '/api/agentos/memory/entries' });
    assert.equal(afterDeleteResponse.statusCode, 200);
    const afterDelete = afterDeleteResponse.json();
    assert.ok(!afterDelete.episodic.some((entry: { id?: string }) => entry.id === liveId));
  } finally {
    await app.close();
  }
});
