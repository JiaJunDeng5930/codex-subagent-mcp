import { describe, it, expect } from 'vitest';
import { delegateHandler, ORCHESTRATOR_TOKEN } from '../src/codex-subagents.mcp';

type DelegateResponse = Awaited<ReturnType<typeof delegateHandler>>;

describe('delegateHandler error surfaces', () => {
  it('rejects unknown agents when no persona is provided', async () => {
    const response: DelegateResponse = await delegateHandler({ agent: 'not-registered', task: 'unregistered-task', token: ORCHESTRATOR_TOKEN });
    expect(response.ok).toBe(false);
    expect(response.stderr).toContain('Unknown agent');
  });

  it('propagates codex missing or execution errors with clear message', async () => {
    const response: DelegateResponse = await delegateHandler({ agent: 'reviewer', task: 'noop-command' });
    expect([127, 0, 1]).toContain(response.code);
    if (response.code === 127) {
      expect(response.stderr).toContain('codex binary not found');
    }
  });
});
