import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceKind, SourceScan, SourceSkill } from '../../shared/types.js';
import { AppError } from '../errors.js';
import { skillsuiHome } from '../paths.js';
import { runCliCapture, stripAnsi } from './cli.js';

export interface GithubTarget {
  owner: string;
  repo: string;
  ref: string;
  subpath: string | null;
  tarballUrl: string;
  display: string;
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

function githubTarballUrl(owner: string, repo: string, ref: string): string {
  const safeRef = ref
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${safeRef}`;
}

export function parseGithubInput(input: string): GithubTarget | null {
  const raw = input.trim();
  if (!raw) return null;

  // owner/repo shorthand
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) && !raw.includes('://')) {
    const [owner, repo] = raw.split('/') as [string, string];
    return {
      owner,
      repo: repo.replace(/\.git$/i, ''),
      ref: 'HEAD',
      subpath: null,
      tarballUrl: githubTarballUrl(owner, repo.replace(/\.git$/i, ''), 'HEAD'),
      display: `${owner}/${repo.replace(/\.git$/i, '')}`,
    };
  }

  // git@github.com:owner/repo.git
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  if (ssh) {
    const owner = ssh[1]!;
    const repo = ssh[2]!;
    return {
      owner,
      repo,
      ref: 'HEAD',
      subpath: null,
      tarballUrl: githubTarballUrl(owner, repo, 'HEAD'),
      display: `${owner}/${repo}`,
    };
  }

  let url: URL;
  try {
    url = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, '');
  let ref = 'HEAD';
  let subpath: string | null = null;

  const mode = parts[2];
  if (mode === 'tree' || mode === 'blob') {
    if (parts[3]) ref = decodeURIComponent(parts[3]);
    if (parts.length > 4) subpath = parts.slice(4).join('/');
  } else if (mode === 'archive') {
    // Fall through to a direct URL; this is not a repo browser URL.
    return null;
  }

  if (url.hash) {
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.startsWith('ref=')) ref = fragment.slice(4);
    else if (fragment && !fragment.includes('=')) ref = fragment;
  }

  return {
    owner,
    repo,
    ref,
    subpath,
    tarballUrl: githubTarballUrl(owner, repo, ref),
    display: `${owner}/${repo}${ref !== 'HEAD' ? ` @ ${ref}` : ''}`,
  };
}

/**
 * Build the source argument for the official Git-based flow. The CLI treats
 * `owner/repo` and GitHub `/tree/<ref>` URLs as GitHub sources, which makes it
 * write the official lock file (and enables `npx skills update` later).
 * Returns null when the ref cannot be represented in that syntax; callers then
 * fall back to the tarball URL.
 */
export function standardGithubSource(target: GithubTarget): string | null {
  const repo = `${target.owner}/${target.repo}`;
  if (!target.ref || target.ref === 'HEAD') return repo;

  // The CLI parses a ref as a single path segment; refs containing "/" are
  // only supported by the tarball mode.
  if (target.ref.includes('/')) return null;

  const ref = encodeURIComponent(target.ref);
  if (target.subpath) {
    const subpath = target.subpath.split('/').map(encodeURIComponent).join('/');
    return `https://github.com/${repo}/tree/${ref}/${subpath}`;
  }
  return `https://github.com/${repo}/tree/${ref}`;
}

export interface Classification {
  kind: SourceKind;
  input: string;
  github: GithubTarget | null;
  url: string | null;
  localPath: string | null;
}

export function classifySource(input: string): Classification {
  const raw = input.trim();
  if (!raw) throw new AppError('EMPTY_SOURCE', '请输入 skill 地址。');

  if (
    raw.startsWith('./') ||
    raw.startsWith('../') ||
    raw.startsWith('/') ||
    raw.startsWith('~/') ||
    raw === '~'
  ) {
    return { kind: 'unknown', input: raw, github: null, url: null, localPath: raw };
  }

  const github = parseGithubInput(raw);
  if (github) {
    return { kind: 'github', input: raw, github, url: github.tarballUrl, localPath: null };
  }

  if (/^(https?:\/\/)/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError('INVALID_URL', '地址格式不正确。');
    }
    if (url.pathname.toLowerCase().endsWith('.git')) {
      throw new AppError(
        'GIT_URL_UNSUPPORTED',
        'v1 不支持 git 协议地址，请粘贴 GitHub 仓库页面地址或 owner/repo。'
      );
    }
    return { kind: 'http', input: raw, github: null, url: raw, localPath: null };
  }

  // A bare host/path such as q.hikecapital.com
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/.*)?$/.test(raw)) {
    return { kind: 'http', input: `https://${raw}`, github: null, url: `https://${raw}`, localPath: null };
  }

  return { kind: 'unknown', input: raw, github: null, url: null, localPath: raw };
}

interface WellKnownEntry {
  name?: unknown;
  description?: unknown;
  files?: unknown;
  internal?: unknown;
  version?: unknown;
}

interface WellKnownIndex {
  skills?: unknown;
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function wellKnownCandidates(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return [];
  }
  const base = new URL(url.toString());
  base.search = '';
  base.hash = '';
  const trimmed = base.toString().replace(/\/$/, '');
  const origin = base.origin;
  const candidates = new Set<string>();
  for (const root of [trimmed, origin]) {
    candidates.add(`${root}/.well-known/agent-skills/index.json`);
    candidates.add(`${root}/.well-known/skills/index.json`);
  }
  return [...candidates];
}

export interface WellKnownScan {
  baseUrl: string;
  skills: SourceSkill[];
}

export async function scanWellKnown(input: string, installed: Set<string>): Promise<WellKnownScan | null> {
  for (const candidate of wellKnownCandidates(input)) {
    const json = await fetchJson(candidate);
    if (!json || typeof json !== 'object') continue;
    const index = json as WellKnownIndex;
    if (!Array.isArray(index.skills)) continue;

    const skills: SourceSkill[] = [];
    const seen = new Set<string>();
    for (const item of index.skills) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as WellKnownEntry;
      if (entry.internal === true) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
      const name = entry.name.trim();
      if (seen.has(name)) continue;
      seen.add(name);
      const description =
        typeof entry.description === 'string' ? entry.description.trim() : '';
      const files = Array.isArray(entry.files) ? entry.files.length : 1;
      skills.push({ name, description, files, installed: installed.has(name) });
    }
    if (skills.length === 0) continue;

    const baseUrl = candidate.replace(/\/\.well-known\/(?:agent-skills|skills)\/index\.json$/, '');
    return { baseUrl, skills };
  }
  return null;
}

function normalizeListLine(line: string): { indent: number; text: string } | null {
  const cleaned = stripAnsi(line).replace(/\r/g, '');
  const withoutBar = cleaned.replace(/^\s*[│|]/, '');
  const text = withoutBar.trim();
  if (!text) return null;
  const indent = withoutBar.length - withoutBar.trimStart().length;
  return { indent, text };
}

/**
 * Skill names in `--list` output are kebab-case slugs. Group headers (repos
 * with nested skill folders, e.g. anthropics/skills) render at a shallower
 * indent as display names with spaces — they must not become skills.
 */
const SKILL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function parseAvailableSkills(output: string): SourceSkill[] {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => /Available Skills/i.test(stripAnsi(line)));
  if (start === -1) return parseSkillLogLines(lines);

  const entries: Array<{ indent: number; text: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const plain = stripAnsi(lines[i]!).trim();
    if (/Use --skill|Run without --list|Skill\(s\) available/i.test(plain)) break;
    const normalized = normalizeListLine(lines[i]!);
    if (normalized) entries.push(normalized);
  }
  if (entries.length === 0) return [];

  const skills: SourceSkill[] = [];
  let current: SourceSkill | null = null;
  let currentIndent = 0;
  let currentGroup: string | null = null;

  for (const entry of entries) {
    if (/^Files:\s/i.test(entry.text)) continue;
    if (SKILL_SLUG_PATTERN.test(entry.text)) {
      if (current) skills.push(current);
      current = { name: entry.text, description: '', files: 1, installed: false, group: currentGroup };
      currentIndent = entry.indent;
      continue;
    }
    if (current && entry.indent > currentIndent) {
      current.description = current.description
        ? `${current.description} ${entry.text}`
        : entry.text;
      continue;
    }
    // A shallow non-slug line is a group header (nested skill folders).
    currentGroup = entry.text;
  }
  if (current) skills.push(current);

  const parsed = skills.filter((skill) => skill.name.length > 0);
  if (parsed.length === 0) return parseAvailableSkillsByIndent(entries);
  return parsed;
}

/** Fallback for output whose name lines are not slugs: minimum indent wins. */
function parseAvailableSkillsByIndent(entries: Array<{ indent: number; text: string }>): SourceSkill[] {
  const nameIndent = Math.min(...entries.map((entry) => entry.indent));
  const skills: SourceSkill[] = [];
  let current: SourceSkill | null = null;

  for (const entry of entries) {
    if (entry.indent === nameIndent) {
      if (current) skills.push(current);
      current = { name: entry.text, description: '', files: 1, installed: false };
      continue;
    }
    if (/^Files:\s/i.test(entry.text)) continue;
    if (current && entry.indent > nameIndent) {
      current.description = current.description
        ? `${current.description} ${entry.text}`
        : entry.text;
    }
  }
  if (current) skills.push(current);

  return skills.filter((skill) => skill.name.length > 0);
}

function parseSkillLogLines(lines: string[]): SourceSkill[] {
  const skills: SourceSkill[] = [];
  let current: SourceSkill | null = null;
  for (const line of lines) {
    const plain = stripAnsi(line).replace(/\r/g, '').trim();
    const nameMatch = /^(?:[│|●◇◆]\s*)*Skill:\s*(.+)$/.exec(plain);
    if (nameMatch) {
      if (current) skills.push(current);
      current = {
        name: nameMatch[1]!.trim(),
        description: '',
        files: 1,
        installed: false,
      };
      continue;
    }
    if (current) {
      const text = plain.replace(/^[│|]\s*/, '').trim();
      if (!text || /^Files:/.test(text) || /^Done!/.test(text)) continue;
      if (/^[◇◆●└┌├╮╯─]/.test(text)) continue;
      if (!current.description) current.description = text;
    }
  }
  if (current) skills.push(current);
  return skills;
}

export interface ScanOptions {
  scope: 'global' | 'project';
  projectPath: string | null;
  installedNames: Set<string>;
  /** Whether GitHub installs will use the official Git-based flow. */
  standardGithub?: boolean;
}

export async function scanSource(input: string, options: ScanOptions): Promise<SourceScan> {
  const classification = classifySource(input);

  if (classification.kind === 'unknown') {
    throw new AppError(
      'UNSUPPORTED_SOURCE',
      '无法识别这个地址。支持：GitHub 仓库、https 地址、owner/repo。v1 暂不支持本地文件夹。'
    );
  }

  if (classification.kind === 'github' && classification.github) {
    const github = classification.github;
    const result = await runCliCapture(
      ['add', github.tarballUrl, '--list'],
      {
        cwd: options.scope === 'project' ? options.projectPath! : skillsuiHome(),
        timeoutMs: 180_000,
      }
    );
    if (result.code !== 0) {
      throw new AppError(
        'GITHUB_SCAN_FAILED',
        githubScanError(result.combined),
        400,
        result.combined
      );
    }
    const skills = parseAvailableSkills(result.combined).map((skill) => ({
      ...skill,
      installed: options.installedNames.has(skill.name),
    }));
    if (skills.length === 0) {
      throw new AppError(
        'GITHUB_NO_SKILLS',
        '这个仓库里没有找到 SKILL.md。请确认仓库包含 skill，或地址是否正确。',
        400,
        result.combined
      );
    }
    return {
      kind: 'github',
      input,
      displaySource: github.display,
      repo: `${github.owner}/${github.repo}`,
      ref: github.ref === 'HEAD' ? null : github.ref,
      tarballUrl: github.tarballUrl,
      installMode: options.standardGithub ? 'standard' : 'direct',
      skills,
      warnings: [],
    };
  }

  if (classification.kind === 'http' && classification.url) {
    const wellKnown = await scanWellKnown(classification.url, options.installedNames);
    if (wellKnown) {
      return {
        kind: 'well-known',
        input,
        displaySource: wellKnown.baseUrl,
        repo: null,
        ref: null,
        tarballUrl: null,
        installMode: null,
        skills: wellKnown.skills,
        warnings: [],
      };
    }

    const result = await runCliCapture(['add', classification.url, '--list'], {
      cwd: options.scope === 'project' ? options.projectPath! : skillsuiHome(),
      timeoutMs: 180_000,
    });
    if (result.code !== 0) {
      throw new AppError(
        'HTTP_SCAN_FAILED',
        httpScanError(result.combined),
        400,
        result.combined
      );
    }
    const skills = parseAvailableSkills(result.combined).map((skill) => ({
      ...skill,
      installed: options.installedNames.has(skill.name),
    }));
    if (skills.length === 0) {
      throw new AppError(
        'HTTP_NO_SKILLS',
        '这个地址没有找到可安装的 skill。',
        400,
        result.combined
      );
    }
    return {
      kind: 'http',
      input,
      displaySource: classification.url,
      repo: null,
      ref: null,
      tarballUrl: classification.url,
      installMode: null,
      skills,
      warnings: [
        '这个来源不是标准 well-known 索引，安装后由 Skillsui 记录，不会写入官方锁文件。',
      ],
    };
  }

  throw new AppError('UNSUPPORTED_SOURCE', '暂不支持这种来源。');
}

function githubScanError(output: string): string {
  if (/404|not found/i.test(output)) {
    return '找不到这个 GitHub 仓库。HTTPS 模式只支持公开仓库；私有仓库请使用 npx skills + Git。';
  }
  if (/rate limit/i.test(output)) {
    return 'GitHub 访问频率受限，请稍后再试。';
  }
  if (/SKILLS_DOWNLOAD_MAX_BYTES|too large|exceeds/i.test(output)) {
    return '仓库文件超过下载限制（50MB），无法通过 HTTPS 模式安装。';
  }
  return '扫描 GitHub 仓库失败。请确认仓库公开且包含 SKILL.md。';
}

function httpScanError(output: string): string {
  if (/404|not found/i.test(output)) {
    return '这个地址返回 404。请确认 URL 是否正确。';
  }
  if (/SSL|certificate|self signed/i.test(output)) {
    return 'TLS 证书校验失败。如果公司网络使用代理证书，请配置 NODE_EXTRA_CA_CERTS。';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(output)) {
    return '无法连接这个地址。请检查网络或代理。';
  }
  return '扫描来源失败。';
}

export function isLocalPath(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/') || value.startsWith('~/')) {
    return true;
  }
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}
