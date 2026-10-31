import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitInfo {
  available: boolean;
  version: string | null;
  path: string | null;
  /** Directories to prepend to PATH so the CLI's `git` lookup finds this binary. */
  dirs: string[];
}

const UNAVAILABLE: GitInfo = {
  available: false,
  version: null,
  path: null,
  dirs: [],
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; info: GitInfo } | null = null;

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

/**
 * Return a copy of `env` with the detected Git directories prepended to PATH.
 * The official CLI spawns `git` by name, so an app launched from Finder or the
 * Windows shell may otherwise miss Homebrew / Git for Windows installations.
 */
export function envWithGit(info: GitInfo, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (info.dirs.length === 0) return env;
  const key = pathKey(env);
  const existing = env[key] ?? '';
  return {
    ...env,
    [key]: `${info.dirs.join(delimiter)}${existing ? `${delimiter}${existing}` : ''}`,
  };
}

function addCandidate(list: string[], seen: Set<string>, value: string | undefined | null): void {
  if (!value) return;
  const path = value.trim();
  if (!path || seen.has(path)) return;
  seen.add(path);
  list.push(path);
}

function candidatePaths(): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';

  // Explicit override, useful for development and unusual installations.
  addCandidate(list, seen, process.env.SKILLSUI_GIT);

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    // /usr/bin/git is a Command Line Tools shim on macOS. Running it without
    // CLT opens the installer dialog, so it is probed separately below.
    if (process.platform === 'darwin' && candidate === '/usr/bin/git') continue;
    addCandidate(list, seen, candidate);
  }

  if (process.platform === 'darwin') {
    addCandidate(list, seen, '/opt/homebrew/bin/git');
    addCandidate(list, seen, '/usr/local/bin/git');
    addCandidate(list, seen, '/opt/local/bin/git');
  } else if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
      process.env.ProgramData ? join(process.env.ProgramData, 'chocolatey', 'bin') : undefined,
      process.env.USERPROFILE
        ? join(process.env.USERPROFILE, 'scoop', 'apps', 'git', 'current')
        : undefined,
    ];
    for (const root of roots) {
      if (!root) continue;
      // ProgramData\chocolatey\bin and scoop's cmd dir differ from the
      // Program Files layout; try both shapes and let existsSync decide.
      addCandidate(list, seen, join(root, 'git.exe'));
      addCandidate(list, seen, join(root, 'Git', 'cmd', 'git.exe'));
      addCandidate(list, seen, join(root, 'cmd', 'git.exe'));
    }
  }

  return list.filter((path) => existsSync(path));
}

async function commandLineToolsReady(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const { stdout } = await execFileAsync('/usr/bin/xcode-select', ['-p'], {
      timeout: 3_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function probe(path: string): Promise<GitInfo | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      timeout: 5_000,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    const match = /git version\s+(\S+)/i.exec(stdout);
    if (!match) return null;

    const dirs = [dirname(path)];
    if (process.platform === 'win32') {
      // Git for Windows keeps its HTTPS helper and DLLs under mingw64 (or
      // mingw32 for very old installs); the cmd/git.exe shim needs them.
      const root = dirname(dirname(path));
      for (const extra of [join(root, 'mingw64', 'bin'), join(root, 'mingw32', 'bin')]) {
        if (existsSync(extra) && !dirs.includes(extra)) dirs.push(extra);
      }
    }

    return {
      available: true,
      version: match[1] ?? null,
      path,
      dirs,
    };
  } catch {
    return null;
  }
}

export async function detectGit(force = false): Promise<GitInfo> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.info;
  }

  for (const path of candidatePaths()) {
    const info = await probe(path);
    if (info) {
      cache = { at: Date.now(), info };
      return info;
    }
  }

  // /usr/bin/git is a Command Line Tools shim on macOS. Running it without
  // CLT opens the installer dialog, so only probe it once xcode-select says
  // the tools are present.
  if (process.platform === 'darwin' && (await commandLineToolsReady())) {
    const info = await probe('/usr/bin/git');
    if (info) {
      cache = { at: Date.now(), info };
      return info;
    }
  }

  cache = { at: Date.now(), info: UNAVAILABLE };
  return UNAVAILABLE;
}

export function getGitInfo(): Promise<GitInfo> {
  return detectGit(false);
}

export function refreshGitInfo(): Promise<GitInfo> {
  return detectGit(true);
}
