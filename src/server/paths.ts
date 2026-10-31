import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const APP_VERSION = '0.1.0';

export function homeDir(): string {
  return homedir();
}

export function skillsuiHome(): string {
  return process.env.SKILLSUI_HOME?.trim() || join(homeDir(), '.skillsui');
}

export function configPath(): string {
  return join(skillsuiHome(), 'config.json');
}

export function githubStatePath(): string {
  return join(skillsuiHome(), 'github-installs.json');
}

export function runtimePath(): string {
  return join(skillsuiHome(), 'runtime.json');
}

export function logsDir(): string {
  return join(skillsuiHome(), 'logs');
}

export function ensureSkillsuiHome(): void {
  mkdirSync(skillsuiHome(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}

function candidateEngineRoots(): string[] {
  const roots: string[] = [];
  const envRoot = process.env.SKILLSUI_ENGINE_DIR?.trim();
  if (envRoot) roots.push(resolve(envRoot));

  // Portable layout: <Resources>/node and <Resources>/engine
  roots.push(join(dirname(process.execPath), 'engine'));

  // Development / npm layout
  roots.push(resolve(process.cwd(), 'node_modules', 'skills'));

  try {
    const require = createRequire(import.meta.url);
    roots.push(dirname(require.resolve('skills/package.json')));
  } catch {
    // Not resolvable from the server bundle; portable layout handles it.
  }

  return roots;
}

export function engineRoot(): string {
  for (const root of candidateEngineRoots()) {
    if (existsSync(join(root, 'bin', 'cli.mjs'))) return root;
    if (existsSync(join(root, 'node_modules', 'skills', 'bin', 'cli.mjs'))) return root;
  }
  throw new Error(
    '找不到内置的 skills 引擎。请确认安装包完整，或设置 SKILLSUI_ENGINE_DIR。'
  );
}

export function engineCliPath(): string {
  const root = engineRoot();
  const direct = join(root, 'bin', 'cli.mjs');
  if (existsSync(direct)) return direct;
  const nested = join(root, 'node_modules', 'skills', 'bin', 'cli.mjs');
  if (existsSync(nested)) return nested;
  throw new Error('找不到 skills CLI 入口文件。');
}

export function engineVersion(): string {
  try {
    const root = engineRoot();
    const pkgPath = existsSync(join(root, 'package.json'))
      ? join(root, 'package.json')
      : join(root, 'node_modules', 'skills', 'package.json');
    const require = createRequire(import.meta.url);
    const pkg = require(pkgPath) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function webDistDir(): string {
  const envDir = process.env.SKILLSUI_WEB_DIR?.trim();
  if (envDir) return resolve(envDir);
  const portable = join(dirname(process.execPath), 'app', 'web');
  if (existsSync(join(portable, 'index.html'))) return portable;
  return resolve(process.cwd(), 'dist', 'web');
}

