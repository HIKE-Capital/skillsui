import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  InstallRequest,
  InstalledSkill,
  RemoveRequest,
  Scope,
  UpdateOutcome,
  UpdateRequest,
} from '../../shared/types.js';
import {
  getGithubInstall,
  listGithubInstalls,
  loadConfig,
  makeGithubId,
  removeGithubInstall,
  scopeKey,
  upsertGithubInstall,
  type GithubInstallRecord,
} from '../config.js';
import { AppError } from '../errors.js';
import { skillsuiHome } from '../paths.js';
import { agentDisplayName, agentExists, allAgentKeys } from './agent-service.js';
import { runCli, type CliResult } from './cli.js';
import { getGitInfo } from './git.js';
import { invalidateIconForSource } from './icons.js';
import type { JobContext } from './jobs.js';
import { listInstalledSkills } from './list.js';
import { parseGithubInput, standardGithubSource } from './sources.js';

function requireProject(scope: Scope, projectPath: string | null): string | null {
  if (scope === 'global') return null;
  if (!projectPath) throw new AppError('PROJECT_REQUIRED', '请先选择一个项目。');
  if (!existsSync(projectPath)) {
    throw new AppError('PROJECT_NOT_FOUND', `项目文件夹不存在：${projectPath}`);
  }
  return projectPath;
}

function cwdFor(scope: Scope, projectPath: string | null): string {
  return scope === 'project' ? projectPath! : skillsuiHome();
}

function scopeArgs(scope: Scope, mode: 'add' | 'update' | 'check' = 'add'): string[] {
  if (scope === 'global') return ['-g'];
  if (mode === 'add') return [];
  return ['-p'];
}

function validateInstall(request: InstallRequest): void {
  requireProject(request.scope, request.projectPath);
  if (!request.skills || request.skills.length === 0) {
    throw new AppError('NO_SKILLS_SELECTED', '请至少选择一个 skill。');
  }
  if (!request.agents || request.agents.length === 0) {
    throw new AppError('NO_AGENTS_SELECTED', '请至少选择一个 agent。');
  }
  for (const key of request.agents) {
    if (!agentExists(key)) {
      throw new AppError('UNKNOWN_AGENT', `未知的 agent：${key}`);
    }
  }
}

function sourceForInstall(request: InstallRequest): string {
  if (request.kind === 'well-known') {
    return request.displaySource || request.input;
  }
  if (request.kind === 'github') {
    // Never let the direct path fall through to `owner/repo`; that would use
    // Git even when direct mode was requested or Git is unavailable.
    return (
      request.tarballUrl ||
      parseGithubInput(request.input)?.tarballUrl ||
      request.input
    );
  }
  return request.tarballUrl || request.input;
}

export interface InstallOutcome {
  installed: string[];
  source: string;
  scope: Scope;
}

async function standardGithubActive(): Promise<boolean> {
  if (loadConfig().githubMode === 'direct') return false;
  return (await getGitInfo()).available;
}

function addArgs(request: InstallRequest, source: string): string[] {
  return [
    'add',
    source,
    '-s',
    ...request.skills,
    '-a',
    ...request.agents,
    ...scopeArgs(request.scope),
    '-y',
  ];
}

/**
 * A standard (Git) install may fail for reasons the tarball path can survive:
 * no Git binary in the spawned environment, blocked network, or a repository
 * that GitHub serves but `git clone` cannot reach. Retry those with the
 * tarball URL rather than making the "Git machine" a worse experience.
 */
function shouldFallbackToDirect(result: CliResult): boolean {
  if (result.code === 0 || result.cancelled || result.timedOut) return false;
  return /failed to clone|cloning repository|git clone|spawn git|not found: git|enoent|authentication|terminal prompts disabled|permission denied|could not resolve host|ssl certificate|proxy|repository not found/i.test(
    result.combined
  );
}

export async function installSkills(
  request: InstallRequest,
  ctx: JobContext
): Promise<InstallOutcome> {
  validateInstall(request);
  const projectPath = requireProject(request.scope, request.projectPath);
  const directSource = sourceForInstall(request);
  if (!directSource) throw new AppError('INVALID_SOURCE', '来源地址为空。');

  const target = request.kind === 'github' ? parseGithubInput(request.input) : null;
  const standardSource =
    target && (await standardGithubActive()) ? standardGithubSource(target) : null;

  const runAdd = (source: string) => {
    ctx.log(`正在安装：${request.skills.join(', ')}`, 'system');
    ctx.log(`来源：${source}`, 'system');
    if (source !== directSource) ctx.log('模式：Git 标准模式', 'system');
    else if (request.kind === 'github') ctx.log('模式：直链模式', 'system');
    return runCli(addArgs(request, source), {
      cwd: cwdFor(request.scope, projectPath),
      signal: ctx.signal,
      timeoutMs: 20 * 60 * 1000,
      onLine: (line, stream) => ctx.log(line, stream),
    });
  };

  let source = standardSource ?? directSource;
  let usedStandard = standardSource !== null;
  let result = await runAdd(source);

  if (standardSource && shouldFallbackToDirect(result)) {
    ctx.log('Git 标准模式失败，改用直链模式重试。', 'system');
    source = directSource;
    usedStandard = false;
    result = await runAdd(source);
  }

  if (result.cancelled) throw new AppError('CANCELLED', '已取消。', 499);
  if (result.timedOut) throw new AppError('TIMEOUT', '安装超时，请检查网络后重试。', 504);
  if (result.code !== 0) {
    throw new AppError(
      'INSTALL_FAILED',
      '安装失败，请查看日志了解详情。',
      400,
      result.combined.slice(-8000)
    );
  }

  const listed = await listInstalledSkills(request.scope, projectPath);
  const installedNames = new Set(listed.skills.map((skill) => skill.name));
  const installed = request.skills.filter((name) => installedNames.has(name));

  if (usedStandard) {
    // The official CLI wrote a lock entry; drop any stale Skillsui record so
    // the lock stays the single source of truth.
    for (const name of installed) {
      removeGithubInstall(makeGithubId(request.scope, projectPath, name));
    }
  } else if ((request.kind === 'github' || request.kind === 'http') && installed.length > 0) {
    const meta = await fetchHttpMeta(directSource);
    const now = new Date().toISOString();
    for (const name of installed) {
      const id = makeGithubId(request.scope, projectPath, name);
      const existing = getGithubInstall(id);
      upsertGithubInstall({
        id,
        name,
        kind: request.kind === 'github' ? 'github' : 'http',
        repo: request.repo ?? null,
        ref: request.ref ?? null,
        url: directSource,
        etag: meta.etag,
        lastModified: meta.lastModified,
        agents: request.agents,
        scope: request.scope,
        projectPath,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      });
    }
  }

  if (installed.length > 0) {
    // The source may ship a new icon; drop the cached one so the list refetches.
    invalidateIconForSource(request.input, request.repo);
  }

  return { installed, source, scope: request.scope };
}

async function fetchHttpMeta(
  url: string
): Promise<{ etag: string | null; lastModified: string | null }> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'skillsui/0.1' },
    });
    if (!response.ok) return { etag: null, lastModified: null };
    return {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  } catch {
    return { etag: null, lastModified: null };
  }
}

export interface RemoveOutcome {
  removed: string[];
  failed: string[];
}

export async function removeSkills(
  request: RemoveRequest,
  ctx: JobContext
): Promise<RemoveOutcome> {
  const projectPath = requireProject(request.scope, request.projectPath);
  if (!request.names || request.names.length === 0) {
    throw new AppError('NO_SKILLS_SELECTED', '请至少选择一个 skill。');
  }

  const args = [
    'remove',
    ...request.names,
    ...scopeArgs(request.scope),
    '-y',
  ];
  const result = await runCli(args, {
    cwd: cwdFor(request.scope, projectPath),
    signal: ctx.signal,
    timeoutMs: 10 * 60 * 1000,
    onLine: (line, stream) => ctx.log(line, stream),
  });

  if (result.cancelled) throw new AppError('CANCELLED', '已取消。', 499);
  if (result.timedOut) throw new AppError('TIMEOUT', '卸载超时。', 504);

  const listed = await listInstalledSkills(request.scope, projectPath);
  const remaining = new Set(listed.skills.map((skill) => skill.name));
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of request.names) {
    if (remaining.has(name)) {
      failed.push(name);
    } else {
      removed.push(name);
      removeGithubInstall(makeGithubId(request.scope, projectPath, name));
    }
  }

  if (result.code !== 0 && removed.length === 0) {
    throw new AppError(
      'REMOVE_FAILED',
      '卸载失败，请查看日志了解详情。',
      400,
      result.combined.slice(-8000)
    );
  }
  return { removed, failed };
}

/** owner/repo (+ optional ref) syntax understood by the official CLI. */
function githubRepoSource(repo: string | null, ref: string | null): string | null {
  if (!repo) return null;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match) return null;
  const [, owner, name] = match;
  if (!ref || ref === 'HEAD') return `${owner}/${name}`;
  if (ref.includes('/')) return null;
  return `https://github.com/${owner}/${name}/tree/${encodeURIComponent(ref)}`;
}

async function updateHttpRecords(
  records: GithubInstallRecord[],
  ctx: JobContext,
  standardGithub: boolean
): Promise<UpdateOutcome> {
  const updated: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const record of records) {
    if (ctx.signal.aborted) break;
    const meta = await fetchHttpMeta(record.url);
    const unchanged =
      record.etag && meta.etag && record.etag === meta.etag;
    if (unchanged) continue;

    // Prefer converting a GitHub record to the official lock when Git is
    // available. This is also the migration path for records created by the
    // old tarball-only mode: after one successful update the lock owns it.
    const repoSource = standardGithub
      ? githubRepoSource(record.repo, record.ref)
      : null;
    if (repoSource) {
      try {
        ctx.log(`更新（标准模式）：${record.name}`, 'system');
        const result = await runCli(
          [
            'add',
            repoSource,
            '-s',
            record.name,
            '-a',
            ...record.agents,
            ...(record.scope === 'global' ? ['-g'] : []),
            '-y',
          ],
          {
            cwd: cwdFor(record.scope, record.projectPath),
            signal: ctx.signal,
            timeoutMs: 20 * 60 * 1000,
            onLine: (line, stream) => ctx.log(line, stream),
          }
        );
        if (result.code === 0) {
          removeGithubInstall(record.id);
          updated.push(record.name);
          continue;
        }
        ctx.log('标准模式更新失败，改用直链重试。', 'system');
      } catch (error) {
        ctx.log(
          `标准模式更新失败：${error instanceof Error ? error.message : String(error)}，改用直链重试。`,
          'system'
        );
      }
    }

    try {
      ctx.log(`更新：${record.name}`, 'system');
      const args = [
        'add',
        record.url,
        '-s',
        record.name,
        '-a',
        ...record.agents,
        ...(record.scope === 'global' ? ['-g'] : []),
        '-y',
      ];
      const result = await runCli(args, {
        cwd: cwdFor(record.scope, record.projectPath),
        signal: ctx.signal,
        timeoutMs: 20 * 60 * 1000,
        onLine: (line, stream) => ctx.log(line, stream),
      });
      if (result.code !== 0) {
        failed.push({
          name: record.name,
          error: result.combined.split('\n').filter(Boolean).slice(-1)[0] ?? '更新失败',
        });
        continue;
      }
      const after = await fetchHttpMeta(record.url);
      upsertGithubInstall({
        ...record,
        etag: after.etag ?? meta.etag,
        lastModified: after.lastModified ?? meta.lastModified,
        updatedAt: new Date().toISOString(),
      });
      updated.push(record.name);
    } catch (error) {
      failed.push({
        name: record.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { updated, failed };
}

export async function updateSkills(
  request: UpdateRequest,
  ctx: JobContext
): Promise<UpdateOutcome> {
  const projectPath = requireProject(request.scope, request.projectPath);
  const names = request.names?.filter(Boolean) ?? [];
  const updated: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const listed = await listInstalledSkills(request.scope, projectPath);
  const byName = new Map(listed.skills.map((skill) => [skill.name, skill]));
  const cliNames = names.filter((name) => {
    const skill = byName.get(name);
    return !skill || skill.managedBy === 'cli';
  });

  // Drop stale records for skills the official lock already owns.
  const allRecords = listGithubInstalls(request.scope, projectPath);
  for (const record of allRecords) {
    if (byName.get(record.name)?.managedBy === 'cli') {
      removeGithubInstall(record.id);
    }
  }
  const records = allRecords.filter((record) => {
    if (byName.get(record.name)?.managedBy === 'cli') return false;
    return names.length > 0 ? names.includes(record.name) : true;
  });

  if (names.length === 0 || cliNames.length > 0) {
    const args = [
      'update',
      ...(names.length > 0 ? cliNames : []),
      ...scopeArgs(request.scope, 'update'),
      '-y',
    ];
    ctx.log(`更新官方管理的技能${names.length > 0 ? `：${cliNames.join(', ')}` : ''}`, 'system');
    const result = await runCli(args, {
      cwd: cwdFor(request.scope, projectPath),
      signal: ctx.signal,
      timeoutMs: 15 * 60 * 1000,
      onLine: (line, stream) => ctx.log(line, stream),
    });
    if (result.code !== 0) {
      failed.push({
        name: cliNames.join(', ') || 'all',
        error: result.combined.split('\n').filter(Boolean).slice(-1)[0] ?? '更新失败',
      });
    } else if (cliNames.length > 0) {
      updated.push(...cliNames);
    } else {
      const match = /Updated (\d+) skill\(s\)/i.exec(result.combined);
      if (match && Number(match[1]) > 0) updated.push('*');
    }
  }

  if (request.includeSkillsuiManaged !== false && records.length > 0) {
    const http = await updateHttpRecords(records, ctx, await standardGithubActive());
    updated.push(...http.updated);
    failed.push(...http.failed);
  }

  return { updated, failed };
}

export async function refreshInstalled(
  scope: Scope,
  projectPath: string | null
): Promise<InstalledSkill[]> {
  return (await listInstalledSkills(scope, projectPath)).skills;
}

export function agentName(key: string): string {
  return agentDisplayName(key);
}

export function knownAgents(): string[] {
  return allAgentKeys();
}

export function projectScopeKey(scope: Scope, projectPath: string | null): string {
  return scopeKey(scope, projectPath);
}

export function defaultHome(): string {
  return homedir();
}

export function configProject(): string | null {
  return loadConfig().activeProject;
}
