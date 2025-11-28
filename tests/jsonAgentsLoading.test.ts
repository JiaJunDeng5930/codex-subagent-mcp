import { describe, it, expect } from 'vitest';
import { loadAgentsFromDir, type AgentSpec } from '../src/codex-subagents.mcp';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('JSON agents personaFile', () => {
  it('loads persona from personaFile path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agents-json-'));
    writeFileSync(join(tempDir, 'body.txt'), 'JSON persona here.', 'utf8');
    const json: Partial<AgentSpec> & { personaFile: string } = {
      profile: 'reviewer',
      personaFile: 'body.txt',
      approval_policy: 'on-request',
      sandbox_mode: 'read-only',
    };
    writeFileSync(join(tempDir, 'review.json'), JSON.stringify(json), 'utf8');
    const registry = loadAgentsFromDir(tempDir);
    expect(registry.review.profile).toBe('reviewer');
    expect(registry.review.persona).toBe('JSON persona here.');
    expect(registry.review.approval_policy).toBe('on-request');
    expect(registry.review.sandbox_mode).toBe('read-only');
    rmSync(tempDir, { recursive: true, force: true });
  });
});
