#!/usr/bin/env node
/*
 Minimal MCP server exposing a single tool `delegate` to spawn Codex CLI
 sub-agents with clean context via an ephemeral working directory and injected persona.

 Dependency footprint is minimal by default (zod). We implement a tiny
 JSON-RPC-over-stdio MCP wrapper compatible with basic MCP usage
 (initialize, tools/list, tools/call). If you later install a full MCP helper,
 you can swap it with minimal code changes.
*/

import { mkdtempSync, writeFileSync, cpSync, existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, resolve, relative } from 'path';
import { spawn } from 'child_process';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { routeThroughOrchestrator, loadTodo, saveTodo, appendStep, updateStep } from './orchestration';
import ignore, { Ignore } from 'ignore';

const SERVER_NAME = 'codex-subagents';
const SERVER_VERSION = '0.1.0';
const START_TIME = Date.now();
export const ORCHESTRATOR_TOKEN = randomBytes(16).toString('hex');

// Personas and profiles
type AgentKey = 'orchestrator';
export type ApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AgentSpec = {
  profile: string;
  persona: string;
  approval_policy?: ApprovalPolicy;
  sandbox_mode?: SandboxMode;
  resourceDir?: string;
};

export const AGENTS: Record<AgentKey, AgentSpec> = {
  orchestrator: {
    profile: 'default',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    persona:
      [
        'Parse [[ORCH-ENVELOPE]] JSON if present; use request_id.',
        'Maintain and evolve a To-Do plan aligned to the user goal.',
        'Use subagents.delegate / subagents.delegate_batch for subtasks, always passing token="<server-injected-token>" and request_id.',
        'Prefer parallel for independent work; sequential for dependencies.',
        'Summarize after each batch, decide next steps, stop when the user goal is achieved.',
        'Never delegate without the token; refuse and explain if token is missing.',
        'Non-orchestrator agents must not delegate; they perform local work only.',
      ].join('\n'),
  },
};

// Zod schema for tool parameters
export const DelegateParamsSchema = z.object({
  // Allow custom agent names. If unknown, require persona+profile inline.
  agent: z.string().min(1, 'agent name is required'),
  task: z.string().min(1, 'task is required'),
  cwd: z.string().optional(),
  mirror_repo: z.boolean().default(false),
  // Optional ad-hoc agent definition when not found in registry
  profile: z.string().optional(),
  persona: z.string().optional(),
  approval_policy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']).optional(),
  sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  token: z.string().optional(),
  request_id: z.string().optional(),
});

export type DelegateParams = z.infer<typeof DelegateParamsSchema>;

export const DelegateBatchParamsSchema = z.object({
  items: z.array(DelegateParamsSchema),
  token: z.string().optional(),
});
export type DelegateBatchParams = z.infer<typeof DelegateBatchParamsSchema>;

// Spawn helper
function buildSanitizedEnv(base: NodeJS.ProcessEnv = process.env) {
  const allowedKeys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SHELL', 'TERM', 'TMPDIR'];
  const allowedPrefixes = ['CODEX_', 'SUBAGENTS_'];
  const safeEnv: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (base[key]) safeEnv[key] = String(base[key]);
  }
  for (const [key, value] of Object.entries(base)) {
    const hasAllowedPrefix = allowedPrefixes.some(prefix => key.startsWith(prefix));
    if (hasAllowedPrefix && typeof value !== 'undefined') safeEnv[key] = String(value);
  }
  return safeEnv;
}

export function run(
  cmd: string,
  args: string[],
  workingDirectory?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: workingDirectory, env: buildSanitizedEnv() });
    const stdoutChunks: Array<string | Buffer> = [];
    const stderrChunks: Array<string | Buffer> = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    const toUtf8 = (chunks: Array<string | Buffer>) => {
      const normalized = chunks.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part))));
      const combined = Buffer.concat(normalized);
      return combined.toString('utf8');
    };

    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout: toUtf8(stdoutChunks), stderr: toUtf8(stderrChunks) });
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const codexMissing = err?.code === 'ENOENT';
      const message = codexMissing
        ? 'codex binary not found in PATH. Install Codex CLI and ensure it is on PATH. See README.md for setup instructions.'
        : String(err);
      resolve({ code: 127, stdout: '', stderr: message });
    });
  });
}

export function prepareWorkingDirectory(agent: string): string {
  return mkdtempSync(join(tmpdir(), `codex-${agent}-`));
}

export function writePersonaFile(workingDirectory: string, agentName: string, persona: string, resourceDir?: string): void {
  const header = `# Persona: ${agentName}\n\n`;
  const blocks = [header, persona.trim(), '\n'];
  if (resourceDir) {
    blocks.push('[[RESOURCES]]\n', `${resourceDir}\n`);
  }
  writeFileSync(join(workingDirectory, 'AGENTS.md'), blocks.join(''), 'utf8');
}

export function buildTaskWithPersonaAndResources(params: { persona: string; resourceDir?: string; originalTask: string }): string {
  const blocks = ['[[PERSONA]]', params.persona.trim()];
  if (params.resourceDir) {
    blocks.push('[[RESOURCES]]', params.resourceDir);
  }
  blocks.push('[[TASK]]', params.originalTask);
  return blocks.join('\n');
}

export function mirrorRepoIfRequested(sourceWorkingDirectory: string | undefined, destinationWorkingDirectory: string, mirror: boolean): void {
  if (!mirror) return;
  if (!sourceWorkingDirectory) return;
  // Validate and filter sensitive paths by default
  const base = resolve(process.cwd());
  const src = resolve(sourceWorkingDirectory);
  const isWithinBase = src === base || src.startsWith(`${base}/`);
  if (!isWithinBase) {
    throw new Error(`Refusing to mirror outside base working directory: ${src}`);
  }
  const forcedSkip = new Set(['.git', '.ssh', '.env', '.env.local', '.env.development', '.env.production', 'node_modules', '.DS_Store']);
  const mirrorAll = process.env.SUBAGENTS_MIRROR_ALL === '1';
  const gitignore = loadGitignore(src);
  cpSync(src, destinationWorkingDirectory, {
    recursive: true,
    force: true,
    filter: (p: string) => {
      const name = basename(p);
      if (forcedSkip.has(name)) return false;
      if (mirrorAll) return true;
      const relative = normalizeRelativePath(src, p);
      if (relative === '') return true;
      if (!gitignore) return true;
      return !gitignore.ignores(relative);
    },
  });
}

function loadGitignore(root: string): Ignore | null {
  const gitignorePath = join(root, '.gitignore');
  if (!existsSync(gitignorePath)) return null;
  const matcher = ignore();
  const content = readFileSync(gitignorePath, 'utf8');
  matcher.add(content.split(/\r?\n/).filter(Boolean));
  return matcher;
}

function normalizeRelativePath(root: string, targetPath: string): string {
  const rel = relative(root, targetPath);
  return rel.replace(/\\/g, '/');
}

// -------- Dynamic agents loading from directory --------
export function getAgentsDir(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  currentDir: string = process.cwd(),
): string | undefined {
  const fromArg = argv.find((a) => a.startsWith('--agents-dir'));
  if (fromArg) {
    const hasInlineValue = fromArg.includes('=');
    if (hasInlineValue) {
      const inlineValue = fromArg.split('=')[1];
      if (inlineValue) return inlineValue;
    }

    const indexOfFlag = argv.indexOf(fromArg);
    const valueAfterFlag = argv[indexOfFlag + 1];
    if (valueAfterFlag) return valueAfterFlag;
  }
  if (env.CODEX_SUBAGENTS_DIR) return env.CODEX_SUBAGENTS_DIR;
  // Common defaults. Prefer explicit, then CWD, then next to the installed server binary.
  const candidates = [
    // Project-local defaults
    join(currentDir, 'agents'),
    join(currentDir, '.codex-subagents', 'agents'),
    // Fallback: alongside the installed server (dist/../agents or src/../agents)
    join(__dirname, '..', 'agents'),
  ];
  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) return candidatePath;
  }
  return undefined;
}

function parseFrontmatter(md: string): { attrs: Record<string, string>; body: string } {
  const frontmatterMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) return { attrs: {}, body: md };
  const raw = frontmatterMatch[1];
  const body = md.slice(frontmatterMatch[0].length);
  const attrs: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (keyValue) attrs[keyValue[1]] = keyValue[2];
  }
  return { attrs, body };
}

export function loadAgentsFromDir(dir?: string): Record<string, AgentSpec> {
  if (!dir) return {};
  if (!existsSync(dir)) return {};
  const out: Record<string, AgentSpec> = {};
  for (const entry of readdirSync(dir)) {
    try {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        const parsedDir = loadAgentDirectory(full, entry);
        if (parsedDir) out[parsedDir.name] = parsedDir.spec;
        continue;
      }

      if (entry.endsWith('.md')) {
        const parsed = loadMarkdownAgent(full, entry);
        out[parsed.name] = parsed.spec;
      } else if (entry.endsWith('.json')) {
        const parsed = loadJsonAgent(full, dir, entry);
        if (parsed) out[parsed.name] = parsed.spec;
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load agent file: ${entry} (${reason})`);
    }
  }
  return out;
}

function loadAgentDirectory(fullPath: string, entry: string) {
  const agentName = entry;
  const mdPath = join(fullPath, `${agentName}.md`);
  const jsonPath = join(fullPath, `${agentName}.json`);
  const hasMd = existsSync(mdPath);
  const hasJson = existsSync(jsonPath);
  if (!hasMd && !hasJson) {
    console.error(`Persona file not found for agent directory: ${agentName}`);
    return null;
  }
  if (hasMd && hasJson) {
    console.error(`Multiple persona files found for agent directory: ${agentName}`);
    return null;
  }

  if (hasMd) {
    const parsed = loadMarkdownAgent(mdPath, `${agentName}.md`);
    return { name: parsed.name, spec: { ...parsed.spec, resourceDir: fullPath } };
  }

  const parsed = loadJsonAgent(jsonPath, fullPath, `${agentName}.json`);
  if (parsed) return { name: parsed.name, spec: { ...parsed.spec, resourceDir: fullPath } };
  return null;
}

function loadMarkdownAgent(fullPath: string, entry: string) {
  const raw = readFileSync(fullPath, 'utf8');
  const { attrs, body } = parseFrontmatter(raw);
  const profile = (attrs.profile || 'default').trim();
  const approval_policy = resolveApprovalPolicy(attrs.approval_policy?.trim());
  const sandbox_mode = resolveSandboxMode(attrs.sandbox_mode?.trim());
  return {
    name: basename(entry, '.md'),
    spec: { profile, persona: body.trim(), approval_policy, sandbox_mode },
  } as const;
}

function loadJsonAgent(fullPath: string, dir: string, entry: string) {
  const agentConfig = JSON.parse(readFileSync(fullPath, 'utf8')) as Partial<AgentSpec> & { personaFile?: string };
  const profile = agentConfig.profile;
  if (!profile) return null;

  const persona = loadJsonPersona(agentConfig, dir);
  if (!persona) return null;

  const approval_policy = resolveApprovalPolicy(agentConfig.approval_policy);
  const sandbox_mode = resolveSandboxMode(agentConfig.sandbox_mode);
  return {
    name: basename(entry, '.json'),
    spec: { profile, persona, approval_policy, sandbox_mode } as AgentSpec,
  } as const;
}

function loadJsonPersona(agentConfig: Partial<AgentSpec> & { personaFile?: string }, dir: string) {
  if (agentConfig.persona) return agentConfig.persona;
  if (!agentConfig.personaFile) return undefined;
  const path = join(dir, agentConfig.personaFile);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

const ALLOWED_APPROVAL_POLICIES: ApprovalPolicy[] = ['never', 'on-request', 'on-failure', 'untrusted'];
const ALLOWED_SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

function resolveApprovalPolicy(value?: string | ApprovalPolicy) {
  if (!value) return undefined;
  return ALLOWED_APPROVAL_POLICIES.includes(value as ApprovalPolicy) ? (value as ApprovalPolicy) : undefined;
}

function resolveSandboxMode(value?: string | SandboxMode) {
  if (!value) return undefined;
  return ALLOWED_SANDBOX_MODES.includes(value as SandboxMode) ? (value as SandboxMode) : undefined;
}

function resolveAgent(agentName: string, parsed: DelegateParams): { spec: AgentSpec | undefined; isConfigured: boolean } {
  const registryFromDisk = loadAgentsFromDir(getAgentsDir());
  const registry: Record<string, AgentSpec> = { ...AGENTS, ...registryFromDisk };
  const configuredAgent = registry[agentName];
  const hasInlinePersona = Boolean(parsed.persona) && Boolean(parsed.profile);
  const adHocAgent = hasInlinePersona
    ? {
      persona: parsed.persona as string,
      profile: parsed.profile as string,
      approval_policy: parsed.approval_policy,
      sandbox_mode: parsed.sandbox_mode,
    } as AgentSpec
    : undefined;
  return { spec: configuredAgent ?? adHocAgent, isConfigured: Boolean(configuredAgent) };
}

type DelegateContext = {
  parsed: z.infer<typeof DelegateParamsSchema>;
  workingDirectory: string;
  isOrchestratorRequest: boolean;
  hasServerToken: boolean;
  hasRequestId: boolean;
};

function buildDelegateContext(parsed: z.infer<typeof DelegateParamsSchema>): DelegateContext {
  return {
    parsed,
    workingDirectory: parsed.cwd ?? process.cwd(),
    isOrchestratorRequest: parsed.agent === 'orchestrator',
    hasServerToken: parsed.token === ORCHESTRATOR_TOKEN,
    hasRequestId: Boolean(parsed.request_id),
  };
}

function rejectClientDelegationWithoutToken(context: DelegateContext) {
  const requiresTokenValidation = context.hasRequestId && !context.isOrchestratorRequest;
  if (!requiresTokenValidation) return null;
  if (context.hasServerToken) return null;
  return {
    ok: false,
    code: 1,
    stdout: '',
    stderr: 'Only orchestrator can delegate. Pass server-injected token.',
    working_dir: '',
  } as const;
}

function shouldBootstrapOrchestrator(context: DelegateContext) {
  const wantsOrchestrator = context.isOrchestratorRequest;
  const isFirstRequest = !context.hasRequestId;
  return wantsOrchestrator && isFirstRequest;
}

function needsOrchestratorProxy(context: DelegateContext) {
  const isClientRequest = !context.isOrchestratorRequest;
  if (!isClientRequest) return false;
  if (context.hasServerToken) return false;
  return true;
}

function ensureOrchestrationDirs(context: DelegateContext) {
  const isOrchestrator = context.isOrchestratorRequest;
  const hasRequestId = context.hasRequestId;
  if (!isOrchestrator) return;
  if (!hasRequestId) return;

  mkdirSync(join(context.workingDirectory, 'orchestration', context.parsed.request_id as string), { recursive: true });
}

function ensureAgentResolved(agentName: string, parsed: DelegateParams) {
  const { spec, isConfigured } = resolveAgent(agentName, parsed);
  if (!spec) {
    return {
      failure: {
        ok: false,
        code: 2,
        stdout: '',
        stderr:
          `Unknown agent: ${agentName}. Create agents/<name>.md or pass persona+profile inline. ` +
          'See README.md “Custom agents”.',
        working_dir: '',
      } as const,
      spec: undefined,
      isConfigured: false,
    } as const;
  }
  return { failure: null, spec, isConfigured } as const;
}

async function executeDelegation(
  parsed: DelegateParams,
  requestWorkingDirectory: string,
  agentName: string,
  spec: AgentSpec,
  isConfigured: boolean,
) {
  const stepId = recordRunningStep(parsed, requestWorkingDirectory);
  if (parsed.mirror_repo) {
    const delegatedWorkingDirectory = prepareWorkingDirectory(isConfigured ? agentName : 'orchestrator');
    try {
      mirrorRepoIfRequested(requestWorkingDirectory, delegatedWorkingDirectory, true);
    } catch (error) {
      return buildDelegationResponse({
        result: {
          code: 1,
          stdout: '',
          stderr:
            `Failed to mirror repo into temp dir: ${String(error)}. ` +
            'Consider disabling mirroring or using git worktree (see docs).',
        },
        workingDir: delegatedWorkingDirectory,
      });
    }
    writePersonaFile(delegatedWorkingDirectory, agentName, spec.persona, spec.resourceDir);
    const args = ['exec', '--profile', spec.profile, parsed.task];
    const result = await run('codex', args, delegatedWorkingDirectory);
    finalizeStep(parsed, requestWorkingDirectory, stepId, result);
    return buildDelegationResponse({ result, workingDir: delegatedWorkingDirectory });
  }

  const task = buildTaskWithPersonaAndResources({ persona: spec.persona, resourceDir: spec.resourceDir, originalTask: parsed.task });
  const args = ['exec', '--profile', spec.profile, task];
  const result = await run('codex', args, requestWorkingDirectory);
  finalizeStep(parsed, requestWorkingDirectory, stepId, result);
  return buildDelegationResponse({ result, workingDir: requestWorkingDirectory });
}

function buildDelegationResponse(params: { result: { code: number; stdout: string; stderr: string }; workingDir: string }) {
  const commandSucceeded = params.result.code === 0;
  const trimmedStdout = params.result.stdout.trim();
  const trimmedStderr = params.result.stderr.trim();
  const hasOutput = trimmedStdout.length > 0;
  const succeededWithOutput = commandSucceeded && hasOutput;
  return {
    ok: succeededWithOutput,
    code: params.result.code,
    stdout: trimmedStdout,
    stderr: trimmedStderr,
    working_dir: params.workingDir,
  } as const;
}

export async function delegateHandler(params: unknown) {
  const parsed = DelegateParamsSchema.parse(params);
  const context = buildDelegateContext(parsed);

  const tokenRejection = rejectClientDelegationWithoutToken(context);
  if (tokenRejection) return tokenRejection;

  if (shouldBootstrapOrchestrator(context)) {
    const routed = routeThroughOrchestrator(parsed);
    return delegateHandler({ ...parsed, ...routed });
  }

  if (needsOrchestratorProxy(context)) {
    const routed = routeThroughOrchestrator(parsed);
    return delegateHandler({ ...parsed, ...routed });
  }

  ensureOrchestrationDirs(context);

  const agentName = parsed.agent;
  const resolved = ensureAgentResolved(agentName, parsed);
  if (resolved.failure) return resolved.failure;

  return executeDelegation(parsed, context.workingDirectory, agentName, resolved.spec, resolved.isConfigured);
}

function recordRunningStep(params: DelegateParams, requestWorkingDirectory: string): string | undefined {
  const isDelegatedTask = params.agent !== 'orchestrator';
  const hasOrchestratorToken = params.token === ORCHESTRATOR_TOKEN;
  const hasRequestId = Boolean(params.request_id);
  if (!isDelegatedTask) return undefined;
  if (!hasOrchestratorToken) return undefined;
  if (!hasRequestId) return undefined;

  const requestId = params.request_id as string;
  const todo = loadTodo(requestId, requestWorkingDirectory);
  const title = params.task.split('\n')[0].slice(0, 80);
  const step = appendStep(todo, {
    title,
    requested_agent: params.agent,
    status: 'running',
    started_at: new Date().toISOString(),
  });
  saveTodo(todo, requestWorkingDirectory);
  return step.id;
}

function finalizeStep(
  params: DelegateParams,
  requestWorkingDirectory: string,
  stepId: string | undefined,
  result: { code: number; stdout: string; stderr: string },
) {
  if (!stepId) return;
  if (!params.request_id) return;

  const todo = loadTodo(params.request_id, requestWorkingDirectory);
  const stepDir = join(requestWorkingDirectory, 'orchestration', params.request_id, 'steps', stepId);
  mkdirSync(stepDir, { recursive: true });
  writeFileSync(join(stepDir, 'stdout.txt'), result.stdout, 'utf8');
  writeFileSync(join(stepDir, 'stderr.txt'), result.stderr, 'utf8');
  updateStep(todo, stepId, {
    ended_at: new Date().toISOString(),
    status: result.code === 0 ? 'done' : 'blocked',
    stdout_path: join('steps', stepId, 'stdout.txt'),
    stderr_path: join('steps', stepId, 'stderr.txt'),
  });
  saveTodo(todo, requestWorkingDirectory);
}

export async function delegateBatchHandler(params: unknown) {
  try {
    const parsed = normalizeBatchParams(params);
    const results = await Promise.allSettled(
      parsed.items.map((item) => delegateHandler({ ...item, token: item.token ?? parsed.token }))
    );
    return {
      results: results.map((result) =>
        result.status === 'fulfilled'
          ? result.value
          : { ok: false, code: 1, stdout: '', stderr: String(result.reason), working_dir: '' }
      ),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { results: [{ ok: false, code: 1, stdout: '', stderr: msg, working_dir: '' }] };
  }
}

function normalizeBatchParams(params: unknown): { items: DelegateParams[]; token?: string } {
  if (isSingleDelegateShape(params)) {
    const single = DelegateParamsSchema.parse(params);
    return { items: [single] };
  }
  const batch = DelegateBatchParamsSchema.parse(params);
  const items = batch.items.map(item => DelegateParamsSchema.parse(item));
  return { items, token: batch.token };
}

function isSingleDelegateShape(params: unknown): params is Record<string, unknown> {
  if (!params || typeof params !== 'object') return false;
  const hasAgent = 'agent' in params;
  const hasTask = 'task' in params;
  return hasAgent && hasTask;
}

// ---------------- Tiny MCP stdio server -----------------
// Implements a narrow slice of MCP sufficient for tools/list and tools/call.

type JsonRpcId = number | string | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id: JsonRpcId; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

type ToolDef = {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema
  handler: (args: unknown) => Promise<unknown>;
};

class TinyMCPServer {
  private tools: Map<string, ToolDef> = new Map();
  private buffer: Buffer = Buffer.alloc(0);
  private static readonly MAX_BYTES = 1_000_000; // 1MB cap
  private framing: 'unknown' | 'cl' | 'nl' = 'unknown';

  constructor(private name: string, private version: string) {
    process.stdin.on('data', (chunk: Buffer) => this.onData(chunk));
    process.stdin.on('error', (err: unknown) => console.error('stdin error', err));
    // Ensure the process starts reading immediately
    process.stdin.resume();
  }

  addTool(def: ToolDef) {
    this.tools.set(def.name, def);
  }

  start() {
    // no-op: listening on stdin already
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > TinyMCPServer.MAX_BYTES * 2) {
      // prevent unbounded growth (DoS guard)
      this.buffer = Buffer.alloc(0);
      return;
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frameText = this.readNextFrame();
      if (!frameText) break;
      this.dispatchFrame(frameText);
    }
  }

  private write(messageObject: Record<string, unknown>) {
    const payload = JSON.stringify(messageObject);
    if (this.framing === 'cl') {
      const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
      process.stdout.write(header + payload);
    } else {
      process.stdout.write(payload + '\n');
    }
  }

  private writeMessage(response: JsonRpcResponse) {
    this.write(response);
  }

  private writeNotification(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private readNextFrame(): string | null {
    if (this.framing === 'cl') return this.tryReadContentLengthFrame();
    const contentLengthFrame = this.tryReadContentLengthFrame();
    if (contentLengthFrame) {
      this.framing = 'cl';
      return contentLengthFrame;
    }
    const newlineFrame = this.tryReadNewlineFrame();
    if (newlineFrame) {
      this.framing = 'nl';
      return newlineFrame;
    }
    return null;
  }

  private tryReadContentLengthFrame(): string | null {
    const headerEnd = this.findHeaderEnd();
    if (headerEnd === -1) return null;
    const separatorLength = this.separatorLength(headerEnd);
    const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
    const contentLength = this.parseContentLength(headerText);
    if (contentLength === null) {
      this.buffer = this.buffer.slice(headerEnd + separatorLength);
      return this.tryReadContentLengthFrame();
    }
    const frameEnd = headerEnd + separatorLength + contentLength;
    if (this.buffer.length < frameEnd) return null;
    const body = this.buffer.slice(headerEnd + separatorLength, frameEnd).toString('utf8');
    this.buffer = this.buffer.slice(frameEnd);
    return body;
  }

  private tryReadNewlineFrame(): string | null {
    const newlineIndex = this.buffer.indexOf('\n');
    if (newlineIndex === -1) return null;
    const line = this.buffer.slice(0, newlineIndex).toString('utf8').trim();
    this.buffer = this.buffer.slice(newlineIndex + 1);
    return line || null;
  }

  private findHeaderEnd() {
    const crlf = this.buffer.indexOf('\r\n\r\n');
    const lf = this.buffer.indexOf('\n\n');
    if (crlf === -1 && lf === -1) return -1;
    if (crlf === -1) return lf;
    if (lf === -1) return crlf;
    return Math.min(crlf, lf);
  }

  private separatorLength(headerEnd: number) {
    const isCrlf = this.buffer.slice(headerEnd, headerEnd + 2).toString('utf8') === '\r\n';
    return isCrlf ? 4 : 2;
  }

  private parseContentLength(headerText: string): number | null {
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) return null;
    const length = parseInt(match[1], 10);
    const invalid = !Number.isFinite(length) || length < 0 || length > TinyMCPServer.MAX_BYTES;
    return invalid ? null : length;
  }

  private dispatchFrame(frameText: string) {
    try {
      const request = JSON.parse(frameText) as JsonRpcRequest;
      this.handleRequest(request);
    } catch {
      // ignore parse errors
    }
  }

  private async handleRequest(request: JsonRpcRequest) {
    const isNotification = request.id === undefined;
    const id = isNotification ? null : request.id;
    try {
      if (request.method === 'initialize') return this.handleInitialize(id);
      if (request.method === 'tools/list') return this.handleToolsList(id);
      if (request.method === 'tools/call') return this.handleToolsCall(request, id);
      if (request.method === 'shutdown') return this.handleShutdown(id);

      if (!isNotification) this.respondMethodNotFound(id, request.method);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isNotification) {
        this.writeMessage({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: msg },
        });
      }
    }
  }

  private handleInitialize(id: JsonRpcId) {
    const now = Date.now();
    if (process.env.DEBUG_MCP) {
      console.error(
        `[${new Date().toISOString()}] initialize received after ${now - START_TIME}ms`,
      );
    }
    const result = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: this.name, version: this.version },
    };
    this.writeMessage({ jsonrpc: '2.0', id, result });
    setTimeout(() => {
      this.writeNotification('initialized');
      if (process.env.DEBUG_MCP) {
        console.error(
          `[${new Date().toISOString()}] initialized sent after ${Date.now() - START_TIME}ms`,
        );
      }
    }, 0);
  }

  private handleToolsList(id: JsonRpcId) {
    const tools = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    this.writeMessage({ jsonrpc: '2.0', id, result: { tools } });
  }

  private async handleToolsCall(req: JsonRpcRequest, id: JsonRpcId) {
    const payload = (req.params ?? {}) as { name?: string; arguments?: unknown };
    const name = payload.name;
    const args = payload.arguments;
    if (!name || !this.tools.has(name)) {
      this.writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
      return;
    }
    const tool = this.tools.get(name)!;
    try {
      const data = await tool.handler(args ?? {});
      this.writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: (process.env.DEBUG_MCP ? JSON.stringify(data, null, 2) : JSON.stringify(data)) },
          ],
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: msg },
      });
    }
  }

  private handleShutdown(id: JsonRpcId) {
    this.writeMessage({ jsonrpc: '2.0', id, result: null });
  }

  private respondMethodNotFound(id: JsonRpcId, method: string) {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

// Server wiring
function toJsonSchema(_schema: z.ZodTypeAny) {
  // Very small bridge using zod-to-json-schema would be ideal, but to keep
  // dependencies minimal we handwrite the schema here.
  return {
    type: 'object',
    properties: {
      agent: { type: 'string' },
      task: { type: 'string' },
      cwd: { type: 'string' },
      mirror_repo: { type: 'boolean', default: false },
      profile: { type: 'string' },
      persona: { type: 'string' },
      approval_policy: { type: 'string', enum: ['never', 'on-request', 'on-failure', 'untrusted'] },
      sandbox_mode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
    },
    required: ['agent', 'task'],
    additionalProperties: false,
  };
}

const server = new TinyMCPServer(SERVER_NAME, SERVER_VERSION);
if (process.env.DEBUG_MCP) {
  console.error(`[${new Date().toISOString()}] server starting`);
}

server.addTool({
  name: 'delegate',
  description:
    'Run a named sub-agent as a clean Codex exec with its own persona/profile.',
  inputSchema: toJsonSchema(DelegateParamsSchema),
  handler: (args: unknown) => delegateHandler(args),
});

server.addTool({
  name: 'delegate_batch',
  description:
    'Run multiple sub-agents in parallel. Input must be {items:[{agent,task,...}], token?}; each item matches delegate.',
  inputSchema: toJsonSchema(DelegateBatchParamsSchema),
  handler: (args: unknown) => delegateBatchHandler(args),
});

server.addTool({
  name: 'list_agents',
  description: 'List available sub-agents from built-ins and custom agents dir.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const dynamic = loadAgentsFromDir(getAgentsDir());
    const rows = [
      ...Object.entries(AGENTS).map(([name, spec]) => ({ name, profile: spec.profile, approval_policy: spec.approval_policy, sandbox_mode: spec.sandbox_mode, source: 'builtin' })),
      ...Object.entries(dynamic).map(([name, spec]) => ({ name, profile: spec.profile, approval_policy: spec.approval_policy, sandbox_mode: spec.sandbox_mode, source: 'custom' })),
    ];
    return { agents: rows };
  },
});

// ---------------- Validation tool -----------------
type ValidationIssue = { level: 'error' | 'warning'; code: string; message: string; field?: string };

type ValidationFileResult = {
  file: string;
  agent_name?: string;
  ok: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  parsed?: Partial<AgentSpec> & { persona_length?: number };
};

function inspectAgentFile(entry: string, dir: string): ValidationFileResult | null {
  const full = join(dir, entry);
  const isDirectory = statSync(full).isDirectory();
  const fileLabel = isDirectory ? `${entry}/` : entry;

  if (isDirectory) {
    return inspectDirectoryAgent({ dirPath: full, agentName: entry, fileLabel });
  }
  if (entry.endsWith('.md')) {
    const agentName = basename(entry, '.md');
    return buildValidationResult(fileLabel, agentName, validateMarkdownAgent(full));
  }
  if (entry.endsWith('.json')) {
    const agentName = basename(entry, '.json');
    return buildValidationResult(fileLabel, agentName, validateJsonAgent(full, dir));
  }

  const issues: ValidationIssue[] = [{ level: 'warning', code: 'unsupported_extension', message: `Skipping unsupported file: ${entry}` }];
  return buildValidationResult(fileLabel, undefined, { issues, parsed: {} });
}

function inspectDirectoryAgent(params: { dirPath: string; agentName: string; fileLabel: string }): ValidationFileResult {
  const { dirPath, agentName, fileLabel } = params;
  const mdPath = join(dirPath, `${agentName}.md`);
  const jsonPath = join(dirPath, `${agentName}.json`);
  const hasMd = existsSync(mdPath);
  const hasJson = existsSync(jsonPath);
  const issues: ValidationIssue[] = [];
  const parsed: Partial<AgentSpec> & { persona_length?: number } = {};

  if (!hasMd && !hasJson) {
    issues.push({ level: 'error', code: 'missing_persona', field: 'persona', message: `Persona file not found: ${mdPath} or ${jsonPath}` });
    return buildValidationResult(fileLabel, agentName, { issues, parsed });
  }

  if (hasMd && hasJson) {
    issues.push({ level: 'error', code: 'multiple_persona_files', message: `Multiple persona files found in ${agentName}` });
    return buildValidationResult(fileLabel, agentName, { issues, parsed });
  }

  if (hasMd) {
    const result = validateMarkdownAgent(mdPath);
    return buildValidationResult(fileLabel, agentName, { ...result, parsed: { ...result.parsed, resourceDir: dirPath } });
  }

  const result = validateJsonAgent(jsonPath, dirPath);
  return buildValidationResult(fileLabel, agentName, { ...result, parsed: { ...result.parsed, resourceDir: dirPath } });
}

function validateMarkdownAgent(fullPath: string): { issues: ValidationIssue[]; parsed: Partial<AgentSpec> & { persona_length?: number } } {
  const issues: ValidationIssue[] = [];
  const parsed: Partial<AgentSpec> & { persona_length?: number } = {};
  try {
    const raw = readFileSync(fullPath, 'utf8');
    const { attrs, body } = parseFrontmatter(raw);
    const profile = (attrs.profile || '').trim();
    if (!profile) issues.push({ level: 'warning', code: 'missing_profile', field: 'profile', message: 'profile missing; built-in loader defaults to default' });
    parsed.profile = profile || 'default';
    const approvalPolicyValue = attrs.approval_policy?.trim();
    const sandboxModeValue = attrs.sandbox_mode?.trim();
    if (approvalPolicyValue && !ALLOWED_APPROVAL_POLICIES.includes(approvalPolicyValue as ApprovalPolicy)) {
      issues.push({ level: 'error', code: 'invalid_approval_policy', field: 'approval_policy', message: `Invalid approval_policy: ${approvalPolicyValue}` });
    } else if (approvalPolicyValue) parsed.approval_policy = approvalPolicyValue as ApprovalPolicy;
    if (sandboxModeValue && !ALLOWED_SANDBOX_MODES.includes(sandboxModeValue as SandboxMode)) {
      issues.push({ level: 'error', code: 'invalid_sandbox_mode', field: 'sandbox_mode', message: `Invalid sandbox_mode: ${sandboxModeValue}` });
    } else if (sandboxModeValue) parsed.sandbox_mode = sandboxModeValue as SandboxMode;
    const persona = body.trim();
    if (!persona) issues.push({ level: 'error', code: 'empty_persona', field: 'persona', message: 'Persona body is empty' });
    parsed.persona = persona;
    parsed.persona_length = persona.length;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push({ level: 'error', code: 'unhandled', message: msg });
  }
  return { issues, parsed };
}

function validateJsonAgent(
  fullPath: string,
  personaBaseDir: string,
): { issues: ValidationIssue[]; parsed: Partial<AgentSpec> & { persona_length?: number } } {
  const issues: ValidationIssue[] = [];
  const parsed: Partial<AgentSpec> & { persona_length?: number } = {};
  type JsonAgent = {
    profile?: unknown;
    approval_policy?: unknown;
    sandbox_mode?: unknown;
    persona?: unknown;
    personaFile?: unknown;
  };
  try {
    const jsonAgent = JSON.parse(readFileSync(fullPath, 'utf8')) as JsonAgent;
    const profile = String((jsonAgent.profile as string | undefined) || '').trim();
    if (!profile) issues.push({ level: 'error', code: 'missing_profile', field: 'profile', message: 'profile is required' });
    else parsed.profile = profile;
    const approvalPolicyValue = jsonAgent.approval_policy as string | undefined;
    const sandboxModeValue = jsonAgent.sandbox_mode as string | undefined;
    if (approvalPolicyValue && !ALLOWED_APPROVAL_POLICIES.includes(approvalPolicyValue as ApprovalPolicy)) {
      issues.push({ level: 'error', code: 'invalid_approval_policy', field: 'approval_policy', message: `Invalid approval_policy: ${approvalPolicyValue}` });
    } else if (approvalPolicyValue) parsed.approval_policy = approvalPolicyValue as ApprovalPolicy;
    if (sandboxModeValue && !ALLOWED_SANDBOX_MODES.includes(sandboxModeValue as SandboxMode)) {
      issues.push({ level: 'error', code: 'invalid_sandbox_mode', field: 'sandbox_mode', message: `Invalid sandbox_mode: ${sandboxModeValue}` });
    } else if (sandboxModeValue) parsed.sandbox_mode = sandboxModeValue as SandboxMode;
    let persona: string | undefined = typeof jsonAgent.persona === 'string' ? (jsonAgent.persona as string) : undefined;
    if (!persona && jsonAgent.personaFile) {
      const personaPath = join(personaBaseDir, String(jsonAgent.personaFile));
      if (!existsSync(personaPath)) {
        issues.push({ level: 'error', code: 'persona_file_missing', field: 'personaFile', message: `personaFile not found: ${personaPath}` });
      } else {
        persona = readFileSync(personaPath, 'utf8');
      }
    }
    if (!persona || !persona.trim()) {
      issues.push({ level: 'error', code: 'missing_persona', field: 'persona', message: 'persona or personaFile is required and must be non-empty' });
    } else {
      parsed.persona = persona;
      parsed.persona_length = persona.length;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push({ level: 'error', code: 'unhandled', message: msg });
  }
  return { issues, parsed };
}

function buildValidationResult(
  file: string,
  agentName: string | undefined,
  result: { issues: ValidationIssue[]; parsed: Partial<AgentSpec> & { persona_length?: number } },
): ValidationFileResult {
  const errors = result.issues.filter(i => i.level === 'error').length;
  const warnings = result.issues.filter(i => i.level === 'warning').length;
  return { file, agent_name: agentName, ok: errors === 0, errors, warnings, issues: result.issues, parsed: result.parsed };
}
export async function validateAgents(dir?: string) {
  const resolved = dir ?? getAgentsDir();
  if (!resolved) {
    return {
      ok: false,
      summary: { files: 0, ok: 0, withErrors: 0, withWarnings: 0 },
      error: 'No agents directory configured. Use --agents-dir, CODEX_SUBAGENTS_DIR, or create ./agents',
      files: [] as unknown[],
    };
  }
  if (!existsSync(resolved)) {
    return {
      ok: false,
      summary: { files: 0, ok: 0, withErrors: 0, withWarnings: 0 },
      error: `Agents directory not found: ${resolved}`,
      files: [] as unknown[],
    };
  }
  const results: ValidationFileResult[] = [];
  for (const entry of readdirSync(resolved)) {
    const inspected = inspectAgentFile(entry, resolved);
    if (inspected) results.push(inspected);
  }
  const summary = results.reduce(
    (totals, result) => {
      totals.files += 1;
      if (result.ok) totals.ok += 1;
      if (result.errors > 0) totals.withErrors += 1;
      if (result.warnings > 0) totals.withWarnings += 1;
      return totals;
    },
    { files: 0, ok: 0, withErrors: 0, withWarnings: 0 },
  );
  return { ok: summary.withErrors === 0, summary, files: results, dir: resolved };
}

server.addTool({
  name: 'validate_agents',
  description: 'Validate agent files and report errors/warnings per file.',
  inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, additionalProperties: false },
  handler: async (args: unknown) => {
    let dir: string | undefined;
    if (args && typeof args === 'object' && 'dir' in (args as Record<string, unknown>)) {
      const dirValue = (args as { dir?: unknown }).dir;
      if (typeof dirValue === 'string') dir = dirValue;
    }
    return validateAgents(dir);
  },
});

server.start();
