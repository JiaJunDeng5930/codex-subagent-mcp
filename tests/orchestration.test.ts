import { describe, it, expect } from 'vitest';
import { routeThroughOrchestrator, loadTodo, finalize, saveTodo } from '../src/orchestration';
import { delegateHandler, ORCHESTRATOR_TOKEN, delegateBatchHandler } from '../src/codex-subagents.mcp';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function createTempWorkingDir() {
  return mkdtempSync(join(tmpdir(), 'orch-'));
}

describe('routing', () => {
  it('rewrites requests to orchestrator and persists todo metadata', () => {
    const workingDir = createTempWorkingDir();
    const routed = routeThroughOrchestrator({ agent: 'security', task: 'scan', cwd: workingDir });
    expect(routed.agent).toBe('orchestrator');
    const todo = loadTodo(routed.request_id, workingDir);
    expect(todo.requested_agent).toBe('security');
  });
});

describe('token gating', () => {
  it('rejects nested delegate calls without orchestrator token', async () => {
    // Given
    const requestId = 'req1';

    // When
    const response = await delegateHandler({ agent: 'security', task: 'scan-without-token', request_id: requestId });

    // Then
    expect(response.ok).toBe(false);
    expect(response.stderr).toContain('Only orchestrator');
  });

  it('allows delegate calls when orchestrator token is present', async () => {
    // When
    const response = await delegateHandler({ agent: 'security', task: 'scan-with-token', token: ORCHESTRATOR_TOKEN });

    // Then
    expect(response.code).not.toBe(0);
  });
});

describe('batch', () => {
  it('handles mixed token gating per item', async () => {
    // When
    const response = await delegateBatchHandler({
      items: [
        { agent: 'reviewer', task: 'review-batch-task', request_id: 'request-batch' },
        { agent: 'debugger', task: 'debug-batch-task', request_id: 'request-batch', token: ORCHESTRATOR_TOKEN },
      ],
    });

    // Then
    expect(response.results.length).toBe(2);
    expect(response.results[0].stderr).toContain('Only orchestrator');
    expect(response.results[1].code).not.toBe(0);
  });

  it('accepts legacy single-item input shape', async () => {
    // When
    const response = await delegateBatchHandler({ agent: 'reviewer', task: 'single-review-task' });

    // Then
    expect(response.results.length).toBe(1);
  });
});

describe('todo lifecycle', () => {
  it('records step outputs when codex execution fails', async () => {
    const workingDir = createTempWorkingDir();
    const routed = routeThroughOrchestrator({ agent: 'reviewer', task: 'check', cwd: workingDir });
    await delegateHandler({ agent: 'debugger', task: 'debug-run-step', token: ORCHESTRATOR_TOKEN, request_id: routed.request_id, cwd: workingDir });
    const todo = loadTodo(routed.request_id, workingDir);
    expect(todo.steps.length).toBe(1);
    expect(todo.steps[0].status).toBe('blocked');
  });
});

describe('e2e multi-step tracking', () => {
  it('tracks multiple delegated steps under one request id', async () => {
    const workingDir = createTempWorkingDir();
    const routed = routeThroughOrchestrator({ agent: 'orchestrator', task: 'plan', cwd: workingDir });
    const requestId = routed.request_id;
    await delegateHandler({ agent: 'review', task: 'review-phase', token: ORCHESTRATOR_TOKEN, request_id: requestId, cwd: workingDir });
    await delegateHandler({ agent: 'debugger', task: 'debug-phase', token: ORCHESTRATOR_TOKEN, request_id: requestId, cwd: workingDir });
    await delegateHandler({ agent: 'security', task: 'security-phase', token: ORCHESTRATOR_TOKEN, request_id: requestId, cwd: workingDir });
    const todo = loadTodo(requestId, workingDir);
    expect(todo.steps.length).toBe(3);
    finalize(todo, 'summary');
    saveTodo(todo, workingDir);
  });
});
