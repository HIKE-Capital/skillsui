import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { engineCliPath } from '../paths.js';
import { envWithGit, getGitInfo, type GitInfo } from './git.js';

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

export interface CliRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  env?: Record<string, string | undefined>;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
  cancelled: boolean;
}

function sanitizedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CURSOR_AGENT',
    'CURSOR_EXTENSION_HOST_ROLE',
    'CURSOR_TRACE_ID',
  ]) {
    delete env[key];
  }
  env.DISABLE_TELEMETRY = '1';
  env.DO_NOT_TRACK = '1';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.TERM = 'dumb';
  env.GIT_TERMINAL_PROMPT = '0';
  env.SKILLS_DOWNLOAD_MAX_BYTES ??= String(50 * 1024 * 1024);
  env.SKILLS_EXTRACT_MAX_BYTES ??= String(100 * 1024 * 1024);
  env.SKILLS_EXTRACT_MAX_FILES ??= '5000';
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function killTree(child: ChildProcessByStdio<null, Readable, Readable>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // fall through
  }
  // child.killed is true immediately after kill() — track actual exit so the
  // SIGKILL escalation still fires when the process ignores SIGTERM.
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  setTimeout(() => {
    try {
      if (!exited) child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 1500).unref();
}

export async function runCli(args: string[], options: CliRunOptions = {}): Promise<CliResult> {
  const git = await getGitInfo();
  return runCliInner(args, options, false, git);
}

export async function runCliCapture(
  args: string[],
  options: CliRunOptions = {}
): Promise<CliResult> {
  const git = await getGitInfo();
  return runCliInner(args, options, true, git);
}

async function runCliInner(
  args: string[],
  options: CliRunOptions,
  quiet: boolean,
  git: GitInfo
): Promise<CliResult> {
  const cli = engineCliPath();
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<CliResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        code: 130,
        stdout: '',
        stderr: '',
        combined: '',
        timedOut: false,
        cancelled: true,
      });
      return;
    }

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(process.execPath, [cli, ...args], {
        cwd: options.cwd || process.cwd(),
        env: envWithGit(git, sanitizedEnv(options.env)),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let finished = false;

    const emit = (line: string, stream: 'stdout' | 'stderr') => {
      if (!options.onLine || quiet) return;
      const cleaned = line.trimEnd();
      if (!cleaned) return;
      options.onLine(cleaned, stream);
    };

    const attach = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      const target = stream === 'stdout' ? child.stdout : child.stderr;
      target.setEncoding('utf8');
      target.on('data', (chunk: string) => {
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          // Keep only the final state of carriage-return progress lines.
          const segments = raw.split('\r').filter((s) => s.trim().length > 0);
          const line = stripAnsi(segments.length > 0 ? segments[segments.length - 1]! : raw);
          emit(line, stream);
        }
      });
      target.on('end', () => {
        if (!buffer) return;
        const segments = buffer.split('\r').filter((s) => s.trim().length > 0);
        const line = stripAnsi(segments.length > 0 ? segments[segments.length - 1]! : buffer);
        emit(line, stream);
        buffer = '';
      });
    };

    attach('stdout');
    attach('stderr');

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const combined = stripAnsi(`${stdout}\n${stderr}`).replace(/\r/g, '');
      resolve({ code, stdout, stderr, combined, timedOut, cancelled });
    };

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code) => {
      if (cancelled) {
        finish(130);
      } else if (timedOut) {
        finish(124);
      } else {
        finish(code ?? 1);
      }
    });
  });
}

export function firstErrorLine(result: CliResult): string {
  const lines = result.combined
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[◇◆●│└┌├╮╯─]/.test(line));
  return (
    lines.find((line) => /error|failed|not found|cannot|unable|invalid/i.test(line)) ??
    lines[lines.length - 1] ??
    '技能引擎执行失败'
  );
}
