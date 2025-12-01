import { appendFileSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogPaths = { logDir: string; logFile: string; execStdoutDir: string };

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_MAX_STRING = 4000;
const MAX_LOG_DEPTH = 5;
const MAX_COLLECTION_ITEMS = 50;
const SENSITIVE_KEYS = ['token', 'authorization', 'password', 'secret', 'apikey', 'api_key', 'access_key', 'auth'];

function pickLogPaths(): LogPaths {
  const baseCandidates: string[] = [];
  if (process.env.XDG_STATE_HOME) {
    baseCandidates.push(join(process.env.XDG_STATE_HOME, 'codex-subagent-mcp'));
  }
  baseCandidates.push(join(homedir(), '.local', 'state', 'codex-subagent-mcp'));
  baseCandidates.push(join(tmpdir(), 'codex-subagent-mcp'));

  for (const base of baseCandidates) {
    try {
      const logDir = join(base, 'logs');
      const execStdoutDir = join(logDir, 'exec-stdout');
      mkdirSync(execStdoutDir, { recursive: true });
      return { logDir, logFile: join(logDir, 'mcp.log'), execStdoutDir };
    } catch {
      // try next candidate
    }
  }

  const fallbackBase = join(tmpdir(), 'codex-subagent-mcp');
  const logDir = join(fallbackBase, 'logs');
  const execStdoutDir = join(logDir, 'exec-stdout');
  mkdirSync(execStdoutDir, { recursive: true });
  return { logDir, logFile: join(logDir, 'mcp.log'), execStdoutDir };
}

const paths = pickLogPaths();
const minLevelEnv = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel;
const minLevel: LogLevel = LEVEL_ORDER[minLevelEnv] ? minLevelEnv : 'info';

function shouldLog(level: LogLevel) {
  return (LEVEL_ORDER[level] ?? LEVEL_ORDER.info) >= (LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info);
}

function isSensitiveKey(key?: string) {
  if (!key) return false;
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((candidate) => lower.includes(candidate));
}

function truncateString(value: string) {
  if (value.length <= DEFAULT_MAX_STRING) return value;
  return `${value.slice(0, DEFAULT_MAX_STRING)}...[truncated ${value.length - DEFAULT_MAX_STRING}]`;
}

function sanitize(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MAX_LOG_DEPTH) return '[depth_exceeded]';
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return '***';
    return truncateString(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) sliced.push(`__truncated_items__:${value.length - MAX_COLLECTION_ITEMS}`);
    return sliced;
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_COLLECTION_ITEMS) {
      out.__truncated_keys__ = true;
      break;
    }
    out[k] = sanitize(v, depth + 1, k);
    count += 1;
  }
  return out;
}

function writeLog(entry: Record<string, unknown>) {
  const line = JSON.stringify(entry);
  try {
    appendFileSync(paths.logFile, `${line}\n`);
  } catch {
    // best-effort; ignore write errors to avoid impacting main flow
  }
}

export function logEvent(event: string, payload: Record<string, unknown>, level: LogLevel = 'info') {
  if (!shouldLog(level)) return;
  try {
    const sanitized = sanitize(payload) as Record<string, unknown>;
    const body = sanitized && typeof sanitized === 'object' ? sanitized : { data: sanitized };
    const record = {
      ...body,
      ts: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
    };
    writeLog(record);
  } catch {
    // never throw from logger
  }
}

export function createExecStdoutPath(): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const nonce = randomBytes(4).toString('hex');
    mkdirSync(paths.execStdoutDir, { recursive: true });
    return join(paths.execStdoutDir, `exec-${stamp}-${process.pid}-${nonce}.stdout`);
  } catch {
    return null;
  }
}

export const logger = {
  log: logEvent,
  paths,
};
