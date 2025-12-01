import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTaskWithPersonaAndResources, delegateHandler, loadAgentsFromDir } from '../src/codex-subagents.mcp';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const originalEnv = { ...process.env };
const trash: string[] = [];

describe('directory-based agents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    while (trash.length > 0) {
      const trashPath = trash.pop();
      if (trashPath) rmSync(trashPath, { recursive: true, force: true });
    }
  });

  it('loads markdown agent definitions from a directory and records resourceDir', () => {
    const base = mkdtempSync(join(tmpdir(), 'agents-dir-md-'));
    trash.push(base);
    const agentDir = join(base, 'perfd');
    mkdirSync(agentDir, { recursive: true });
    const markdown = `---\nprofile: debugger\napproval_policy: on-request\nsandbox_mode: workspace-write\n---\nPersona inside dir.`;
    writeFileSync(join(agentDir, 'perfd.md'), markdown, 'utf8');
    writeFileSync(join(agentDir, 'helper.sh'), '#!/bin/sh\necho helper\n', 'utf8');

    const registry = loadAgentsFromDir(base);

    expect(registry.perfd.profile).toBe('debugger');
    expect(registry.perfd.persona).toContain('Persona inside dir.');
    expect(registry.perfd.resourceDir).toBe(resolve(agentDir));

  });

  it('writes resources path into AGENTS.md when mirror_repo is true', async () => {
    const base = mkdtempSync(join(tmpdir(), 'agents-dir-mirror-'));
    trash.push(base);
    const agentDir = join(base, 'writer');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'writer.md'), `---\nprofile: reviewer\n---\nDir persona.`, 'utf8');
    writeFileSync(join(agentDir, 'script.sh'), '#!/bin/sh\necho script\n', 'utf8');

    process.env.CODEX_SUBAGENTS_DIR = base;

    const requestCwd = mkdtempSync(join(process.cwd(), 'tmp-mirror-src-'));
    trash.push(requestCwd);
    writeFileSync(join(requestCwd, 'readme.txt'), 'mirror me', 'utf8');

    const response = await delegateHandler({ agent: 'writer', task: 'noop', mirror_repo: true, cwd: requestCwd });

    expect(response.working_dir).toBeTruthy();
    const agentsPath = join(response.working_dir, 'AGENTS.md');
    expect(existsSync(agentsPath)).toBe(true);
    const content = readFileSync(agentsPath, 'utf8');
    expect(content).toContain('Dir persona.');
    expect(content).toContain(resolve(agentDir));

    trash.push(response.working_dir);
  });

  it('when mirror_repo is false, keeps working_dir as request cwd and does not write AGENTS.md', async () => {
    const agentsBase = mkdtempSync(join(tmpdir(), 'agents-dir-nomirror-'));
    trash.push(agentsBase);
    const agentDir = join(agentsBase, 'nomirror');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'nomirror.md'), `---\nprofile: reviewer\n---\nInline persona.`, 'utf8');
    process.env.CODEX_SUBAGENTS_DIR = agentsBase;

    const requestCwd = mkdtempSync(join(tmpdir(), 'delegate-cwd-'));
    trash.push(requestCwd);

    const response = await delegateHandler({ agent: 'nomirror', task: 'original task', mirror_repo: false, cwd: requestCwd });

    expect(response.working_dir).toBe(requestCwd);
    expect(existsSync(join(requestCwd, 'AGENTS.md'))).toBe(false);

  });

  it('builds task string by prefixing persona and resources before original task when mirror is disabled', () => {
    const result = buildTaskWithPersonaAndResources({
      persona: 'persona-text',
      resourceDir: '/abs/path/to/agent',
      originalTask: 'do-things',
    }) as string;

    expect(result).toContain('persona-text');
    expect(result).toContain('/abs/path/to/agent');
    expect(result).toContain('do-things');
    expect(result.indexOf('persona-text')).toBeLessThan(result.indexOf('/abs/path/to/agent'));
    expect(result.indexOf('/abs/path/to/agent')).toBeLessThan(result.indexOf('do-things'));
    expect(result).toContain('[[PERSONA]]');
    expect(result).toContain('[[RESOURCES]]');
    expect(result).toContain('[[TASK]]');
  });
});
