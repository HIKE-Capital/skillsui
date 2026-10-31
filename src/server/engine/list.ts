import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InstalledSkill, Scope } from '../../shared/types.js';
import {
  listGithubInstalls,
  loadConfig,
  scopeKey,
} from '../config.js';
import { skillsuiHome } from '../paths.js';
import { agents } from './agents.js';
import { runCliCapture } from './cli.js';

interface RawListEntry {
  name: string;
  path: string | null;
  scope: Scope;
  agents: string[];
  source: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
}

const descriptionCache = new Map<string, { mtimeMs: number; description: string | null }>();

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillDescription(skillDir: string): string | null {
  const file = join(skillDir, 'SKILL.md');
  try {
    const stat = statSync(file);
    const cached = descriptionCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.description;

    const text = readFileSync(file, 'utf-8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    let description: string | null = null;
    if (match) {
      const body = match[1] ?? '';
      const lines = body.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = /^description:\s*(.*)$/.exec(line);
        if (!m) continue;
        let value = m[1]!.trim();
        if (value === '|' || value === '>' || value === '|-' || value === '>-') {
          const collected: string[] = [];
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j]!;
            if (/^\S/.test(next)) break;
            collected.push(next.trim());
          }
          value = collected.join(' ').trim();
        }
        description = unquote(value) || null;
        break;
      }
    }
    descriptionCache.set(file, { mtimeMs: stat.mtimeMs, description });
    return description;
  } catch {
    return null;
  }
}

function extractJsonArray(output: string): RawListEntry[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('无法解析 skills list 的输出。');
  }
  const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('skills list 返回了非数组结果。');
  return parsed as RawListEntry[];
}

interface LockTimestamps {
  installedAt?: string;
  updatedAt?: string;
}

function readGlobalLockTimestamps(): Record<string, LockTimestamps> {
  const xdgState = process.env.XDG_STATE_HOME?.trim();
  const path = xdgState
    ? join(xdgState, 'skills', '.skill-lock.json')
    : join(homedir(), '.agents', '.skill-lock.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      skills?: Record<string, { installedAt?: string; updatedAt?: string }>;
    };
    return raw.skills ?? {};
  } catch {
    return {};
  }
}

function reverseAgentNames(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, config] of Object.entries(agents)) {
    map.set(config.displayName.toLowerCase(), key);
  }
  return map;
}

export interface ListResult {
  skills: InstalledSkill[];
  warnings: string[];
}

export async function listInstalledSkills(
  scope: Scope,
  projectPath: string | null
): Promise<ListResult> {
  if (scope === 'project' && !projectPath) {
    throw new Error('请先选择一个项目。');
  }
  const args = ['list', '--json'];
  if (scope === 'global') args.push('-g');

  const result = await runCliCapture(args, {
    cwd: scope === 'project' ? projectPath! : skillsuiHome(),
    timeoutMs: 90_000,
  });

  if (result.code !== 0 && !result.stdout.includes('[')) {
    throw new Error(result.combined.trim() || '读取已安装技能失败。');
  }

  const raw = extractJsonArray(result.stdout);
  const metadata = listGithubInstalls(scope, projectPath);
  const metadataByName = new Map(metadata.map((record) => [record.name, record]));
  const lockTimestamps = scope === 'global' ? readGlobalLockTimestamps() : {};
  const agentNameToKey = reverseAgentNames();

  const skills = raw.map((entry): InstalledSkill => {
    const record = metadataByName.get(entry.name);
    const path = entry.path ? resolve(entry.path) : null;
    const exists = path ? existsSync(path) : false;
    const description = path && exists ? parseSkillDescription(path) : null;

    // The official lock always wins. A Skillsui record for the same skill is
    // stale (for example after a tarball install was upgraded to the standard
    // Git flow) and must not drive updates.
    const lockManaged = !!entry.source;
    const managedBy: InstalledSkill['managedBy'] = lockManaged
      ? 'cli'
      : record
        ? 'skillsui'
        : 'cli';

    let status: InstalledSkill['status'];
    if (!path || !exists) status = 'missing';
    else status = lockManaged ? 'tracked' : 'untracked';

    const agentKeys =
      managedBy === 'skillsui' && record
        ? record.agents
        : entry.agents
            .map((name) => agentNameToKey.get(name.toLowerCase()))
            .filter((key): key is string => !!key);

    return {
      name: entry.name,
      description,
      path,
      scope: entry.scope ?? scope,
      agents: entry.agents ?? [],
      agentKeys,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      sourceType: entry.sourceType,
      managedBy,
      status,
      repo: managedBy === 'skillsui' ? (record?.repo ?? null) : null,
      ref: managedBy === 'skillsui' ? (record?.ref ?? null) : null,
      installedAt:
        managedBy === 'skillsui'
          ? (record?.installedAt ?? null)
          : (lockTimestamps[entry.name]?.installedAt ?? null),
      updatedAt:
        managedBy === 'skillsui'
          ? (record?.updatedAt ?? null)
          : (lockTimestamps[entry.name]?.updatedAt ?? null),
    };
  });

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings: [] };
}


