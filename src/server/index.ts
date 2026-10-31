#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildApp, startServer } from './app.js';
import { addRecentProject } from './config.js';
import { APP_VERSION, ensureSkillsuiHome, logsDir, runtimePath } from './paths.js';

interface RuntimeInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

interface CliArgs {
  help: boolean;
  version: boolean;
  noOpen: boolean;
  dev: boolean;
  project: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    noOpen: false,
    dev: false,
    project: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--no-open') args.noOpen = true;
    else if (arg === '--dev') args.dev = true;
    else if (arg === '--project') {
      const value = argv[++i];
      if (value) args.project = value;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Skillsui ${APP_VERSION}

用法:
  skillsui                 启动本地界面并打开浏览器
  skillsui --no-open       启动但不自动打开浏览器
  skillsui --project <dir> 启动并选中某个项目
  skillsui --version       显示版本
  skillsui --help          显示帮助

说明:
  Skillsui 是一个管理 agent skills 的本地图形界面。
  所有安装/卸载/更新操作都通过内置的 skills 引擎执行。`);
}

function readRuntime(): RuntimeInfo | null {
  try {
    const raw = JSON.parse(readFileSync(runtimePath(), 'utf-8')) as RuntimeInfo;
    if (
      typeof raw.pid === 'number' &&
      typeof raw.port === 'number' &&
      typeof raw.token === 'string'
    ) {
      return raw;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeRuntime(info: RuntimeInfo): void {
  const path = runtimePath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

function writeServerLog(message: string): void {
  try {
    ensureSkillsuiHome();
    appendFileSync(
      `${logsDir()}/server.log`,
      `[${new Date().toISOString()}] ${message}\n`,
      'utf-8'
    );
  } catch {
    // Logging is best-effort.
  }
}

function removeRuntime(): void {
  try {
    const current = readRuntime();
    if (current && current.pid === process.pid) unlinkSync(runtimePath());
  } catch {
    // ignore
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function findExistingInstance(): Promise<RuntimeInfo | null> {
  const info = readRuntime();
  if (!info) return null;
  if (!pidAlive(info.pid)) {
    removeRuntime();
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return info;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    console.log(`请在浏览器打开：${url}`);
  }
}

function checkNodeVersion(): void {
  const [major, minor] = process.versions.node.split('.').map((part) => Number(part));
  if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 20)) return;
  console.error(
    `Skillsui 需要 Node.js 22.20 或更高版本，当前是 ${process.versions.node}。`
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    console.log(APP_VERSION);
    return;
  }

  ensureSkillsuiHome();
  const dev = args.dev || process.env.SKILLSUI_DEV === '1';
  const noOpen = args.noOpen || process.env.SKILLSUI_NO_OPEN === '1';
  writeServerLog(`starting v${APP_VERSION} node ${process.versions.node} platform ${process.platform}`);

  if (args.project) {
    try {
      addRecentProject(args.project);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (!dev) {
    const existing = await findExistingInstance();
    if (existing) {
      const url = `http://127.0.0.1:${existing.port}/?token=${existing.token}`;
      if (!noOpen) openBrowser(url);
      else console.log(`Skillsui 已在运行：${url}`);
      return;
    }
  }

  const token = dev ? 'dev' : randomBytes(24).toString('hex');
  const port = dev ? 4317 : 0;
  const app = await buildApp({ token, dev, port });
  const actualPort = await startServer(app, port);

  if (!dev) {
    writeRuntime({
      pid: process.pid,
      port: actualPort,
      token,
      startedAt: new Date().toISOString(),
      version: APP_VERSION,
    });
  }

  const url = `http://127.0.0.1:${actualPort}/?token=${token}`;
  if (!dev && !noOpen) {
    openBrowser(url);
  } else {
    console.log(`Skillsui API listening on http://127.0.0.1:${actualPort}`);
    if (dev) console.log('Dev mode: open the Vite dev server (npm run dev) instead.');
    else console.log(`Open: ${url}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeServerLog(`shutdown ${signal}`);
    console.log(`\nSkillsui shutting down (${signal})…`);
    try {
      await app.close();
    } catch {
      // ignore
    }
    if (!dev) removeRuntime();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => {
    if (!dev) removeRuntime();
  });
}

checkNodeVersion();
main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeServerLog(`fatal: ${message}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
