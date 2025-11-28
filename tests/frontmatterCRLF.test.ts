import { describe, it, expect } from 'vitest';
import { loadAgentsFromDir } from '../src/codex-subagents.mcp';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('frontmatter parsing handles CRLF and line-anchored fences', () => {
  it('parses CRLF frontmatter and trims body', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agents-fm-crlf-'));
    const markdown = [
      '---\r\n',
      'profile: debugger\r\n',
      'approval_policy: on-request\r\n',
      'sandbox_mode: workspace-write\r\n',
      '---\r\n',
      'Persona body here.\r\n',
    ].join('');
    writeFileSync(join(tempDir, 'perf.md'), markdown, 'utf8');
    const registry = loadAgentsFromDir(tempDir);
    expect(registry.perf.profile).toBe('debugger');
    expect(registry.perf.approval_policy).toBe('on-request');
    expect(registry.perf.sandbox_mode).toBe('workspace-write');
    // body is trimmed by loader
    expect(registry.perf.persona).toBe('Persona body here.');
    rmSync(tempDir, { recursive: true, force: true });
  });
});
