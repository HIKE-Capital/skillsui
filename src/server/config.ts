import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AppConfig, RecentProject, Scope } from '../shared/types.js';
import { configPath, ensureSkillsuiHome, githubStatePath } from './paths.js';

export interface GithubInstallRecord {
  id: string;
  name: string;
  kind: 'github' | 'http';
  repo: string | null;
  ref: string | null;
  url: string;
  etag: string | null;
  lastModified: string | null;
  agents: string[];
  scope: Scope;
  projectPath: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface GithubState {
  version: 1;
  installs: Record<string, GithubInstallRecord>;
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    locale: 'system',
    recentProjects: [],
    activeProject: null,
    lastAgents: [],
    activeScope: 'global',
    githubMode: 'auto',
  };
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      // Ignore backup failures; the caller gets the fallback.
    }
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureSkillsuiHome();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

export function loadConfig(): AppConfig {
  const raw = readJson<Partial<AppConfig>>(configPath(), {});
  const config = defaultConfig();
  if (raw.version === 1) {
    if (raw.locale === 'zh-CN' || raw.locale === 'en' || raw.locale === 'system') {
      config.locale = raw.locale;
    }
    if (Array.isArray(raw.recentProjects)) {
      config.recentProjects = raw.recentProjects
        .filter(
          (p): p is RecentProject =>
            !!p &&
            typeof p.path === 'string' &&
            typeof p.name === 'string' &&
            typeof p.lastOpened === 'string'
        )
        .slice(0, 30);
    }
    if (typeof raw.activeProject === 'string') config.activeProject = raw.activeProject;
    if (Array.isArray(raw.lastAgents)) {
      config.lastAgents = raw.lastAgents.filter((a): a is string => typeof a === 'string');
    }
    if (raw.activeScope === 'global' || raw.activeScope === 'project') {
      config.activeScope = raw.activeScope;
    }
    if (raw.githubMode === 'auto' || raw.githubMode === 'direct') {
      config.githubMode = raw.githubMode;
    }
  }
  if (config.activeProject && !isProjectDir(config.activeProject)) {
    config.activeProject = null;
    if (config.activeScope === 'project') config.activeScope = 'global';
  }
  return config;
}

export function saveConfig(config: AppConfig): void {
  writeJsonAtomic(configPath(), config);
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  const config = { ...loadConfig(), ...patch };
  config.version = 1;
  saveConfig(config);
  return config;
}

export function addRecentProject(input: string): AppConfig {
  const path = resolveProjectPath(input);
  const config = loadConfig();
  const entry: RecentProject = {
    path,
    name: basename(path) || path,
    lastOpened: new Date().toISOString(),
  };
  const index = config.recentProjects.findIndex((p) => p.path === path);
  if (index >= 0) {
    // Selecting an existing project must not reshuffle the sidebar; refresh
    // its timestamp in place. Only genuinely new projects go to the top.
    config.recentProjects[index] = entry;
  } else {
    config.recentProjects = [entry, ...config.recentProjects].slice(0, 20);
  }
  config.activeProject = path;
  config.activeScope = 'project';
  saveConfig(config);
  return config;
}

export function removeRecentProject(path: string): AppConfig {
  const config = loadConfig();
  config.recentProjects = config.recentProjects.filter((p) => p.path !== path);
  if (config.activeProject === path) {
    config.activeProject = config.recentProjects[0]?.path ?? null;
    if (!config.activeProject) config.activeScope = 'global';
  }
  saveConfig(config);
  return config;
}

export function isProjectDir(path: string | null | undefined): boolean {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveProjectPath(input: string): string {
  let value = input.trim();
  if (!value) throw new Error('项目路径不能为空。');
  if (value === '~') value = homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(homedir(), value.slice(2));
  }
  if (!isAbsolute(value)) value = resolve(process.cwd(), value);
  value = resolve(value);
  if (!isProjectDir(value)) throw new Error(`文件夹不存在：${value}`);
  return value;
}

export function scopeKey(scope: Scope, projectPath: string | null): string {
  return scope === 'global' ? 'global' : `project:${projectPath ?? ''}`;
}

export function makeGithubId(
  scope: Scope,
  projectPath: string | null,
  name: string
): string {
  return `${scopeKey(scope, projectPath)}::${name}`;
}

function defaultGithubState(): GithubState {
  return { version: 1, installs: {} };
}

export function loadGithubState(): GithubState {
  const raw = readJson<Partial<GithubState>>(githubStatePath(), defaultGithubState());
  if (raw.version !== 1 || !raw.installs || typeof raw.installs !== 'object') {
    return defaultGithubState();
  }
  return raw as GithubState;
}

export function saveGithubState(state: GithubState): void {
  writeJsonAtomic(githubStatePath(), state);
}

export function upsertGithubInstall(record: GithubInstallRecord): void {
  const state = loadGithubState();
  state.installs[record.id] = record;
  saveGithubState(state);
}

export function removeGithubInstall(id: string): void {
  const state = loadGithubState();
  if (state.installs[id]) {
    delete state.installs[id];
    saveGithubState(state);
  }
}

export function getGithubInstall(id: string): GithubInstallRecord | null {
  return loadGithubState().installs[id] ?? null;
}

export function listGithubInstalls(
  scope: Scope,
  projectPath: string | null
): GithubInstallRecord[] {
  const key = scopeKey(scope, projectPath);
  return Object.values(loadGithubState().installs).filter(
    (record) => scopeKey(record.scope, record.projectPath) === key
  );
}

export function pruneGithubInstalls(existingNames: Set<string>): void {
  const state = loadGithubState();
  let changed = false;
  for (const [id, record] of Object.entries(state.installs)) {
    if (!existingNames.has(id)) {
      delete state.installs[id];
      changed = true;
    }
  }
  if (changed) saveGithubState(state);
}

export function findGithubInstallByName(
  scope: Scope,
  projectPath: string | null,
  name: string
): GithubInstallRecord | null {
  return getGithubInstall(makeGithubId(scope, projectPath, name));
}
