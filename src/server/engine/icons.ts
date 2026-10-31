import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsuiHome } from '../paths.js';
import { SOURCE_LANDING_PAGES } from '../../shared/sourcePages.js';

/**
 * Source icons for the skill list: GitHub owner avatars and site favicons.
 *
 * Everything is fetched by the server (never the browser), only from the
 * source's own host — no third-party icon services — and cached on disk under
 * `~/.skillsui/icons/` so the app works offline after the first fetch.
 * Failures are negatively cached for a day and the UI falls back to the
 * letter placeholder.
 */

const FETCH_TIMEOUT_MS = 6000;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // refetch after a month
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // retry failures after a day

export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export const SITE_HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

interface IconCacheMeta {
  url: string;
  contentType: string;
  ok: boolean;
  fetchedAt: number;
}

interface IconPayload {
  data: Buffer;
  contentType: string;
}

const iconsDir = () => join(skillsuiHome(), 'icons');
const inflight = new Map<string, Promise<IconPayload | null>>();

function cachePaths(key: string): { img: string; meta: string } {
  return { img: join(iconsDir(), `${key}.img`), meta: join(iconsDir(), `${key}.json`) };
}

function cacheKey(kind: 'github' | 'site', id: string): string {
  return createHash('sha256').update(`${kind}:${id.toLowerCase()}`).digest('hex').slice(0, 24);
}

async function fetchBuffer(url: string, maxBytes: number): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'Skillsui/0.1 (local skill manager)' },
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    return { buf, contentType };
  } catch {
    return null;
  }
}

function isImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}

/** First `<link rel*="icon">` href on the page, or null. */
function extractIconHref(html: string, pageUrl: string): string | null {
  const base = (() => {
    try {
      return new URL(pageUrl);
    } catch {
      return null;
    }
  })();
  if (!base) return null;
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const rel = /rel\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1] ?? '';
    if (!/icon/i.test(rel)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    if (href.startsWith('data:')) return href;
    try {
      return new URL(href, base).toString();
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchDataUrl(dataUrl: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(dataUrl);
  if (!match) return null;
  const contentType = (match[1] ?? 'text/plain').toLowerCase();
  if (!isImage(contentType)) return null;
  const base64 = match[2];
  const payload = match[3]!;
  const buf = base64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
  return { buf, contentType };
}

async function fetchGithubAvatar(owner: string): Promise<IconPayload | null> {
  const url = `https://github.com/${owner}.png?size=128`;
  const res = await fetchBuffer(url, MAX_ICON_BYTES);
  if (!res || !isImage(res.contentType)) return null;
  return { data: res.buf, contentType: res.contentType };
}

async function fetchSiteIcon(host: string): Promise<IconPayload | null> {
  const lower = host.toLowerCase();

  // 1. Conventional path.
  const favicon = await fetchBuffer(`https://${lower}/favicon.ico`, MAX_ICON_BYTES);
  if (favicon && isImage(favicon.contentType)) {
    return { data: favicon.buf, contentType: favicon.contentType };
  }

  // 2. Parse HTML for a declared icon. Landing pages from SOURCE_LANDING_PAGES
  //    come first because site roots sometimes omit the <link> tag.
  const candidates = [SOURCE_LANDING_PAGES[lower], `https://${lower}/`]
    .filter((url, index, all): url is string => Boolean(url) && all.indexOf(url) === index);
  for (const pageUrl of candidates) {
    const page = await fetchBuffer(pageUrl, MAX_HTML_BYTES);
    if (!page) continue;
    const html = page.buf.toString('utf8');
    const href = extractIconHref(html, pageUrl);
    if (!href) continue;
    if (href.startsWith('data:')) {
      const data = await fetchDataUrl(href);
      if (data) return { data: data.buf, contentType: data.contentType };
      continue;
    }
    const icon = await fetchBuffer(href, MAX_ICON_BYTES);
    if (icon && isImage(icon.contentType)) {
      return { data: icon.buf, contentType: icon.contentType };
    }
  }
  return null;
}

async function loadFromCache(key: string): Promise<IconPayload | null> {
  const { img, meta } = cachePaths(key);
  if (!existsSync(meta)) return null;
  try {
    const parsed = JSON.parse(readFileSync(meta, 'utf8')) as IconCacheMeta;
    const age = Date.now() - parsed.fetchedAt;
    if (parsed.ok && age < POSITIVE_TTL_MS && existsSync(img)) {
      return { data: readFileSync(img), contentType: parsed.contentType };
    }
    if (!parsed.ok && age < NEGATIVE_TTL_MS) return null; // still considered failing
    return null;
  } catch {
    return null;
  }
}

function storeToCache(key: string, url: string, payload: IconPayload | null): void {
  mkdirSync(iconsDir(), { recursive: true });
  const { img, meta } = cachePaths(key);
  try {
    if (payload) writeFileSync(img, payload.data);
    const record: IconCacheMeta = {
      url,
      contentType: payload?.contentType ?? '',
      ok: payload !== null,
      fetchedAt: Date.now(),
    };
    writeFileSync(meta, `${JSON.stringify(record)}\n`);
  } catch {
    // Cache write failures must never break listing; fall through.
  }
}

async function resolveIcon(kind: 'github' | 'site', id: string): Promise<IconPayload | null> {
  const lower = id.toLowerCase();
  const key = cacheKey(kind, lower);
  const cached = await loadFromCache(key);
  if (cached) return cached;

  const url = kind === 'github' ? `https://github.com/${lower}.png` : `https://${lower}/`;
  const existing = inflight.get(key);
  const promise = (existing ?? (async () => {
    const payload = kind === 'github' ? await fetchGithubAvatar(lower) : await fetchSiteIcon(lower);
    storeToCache(key, url, payload);
    return payload;
  })());
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key);
  }
}

/** Owner avatar for a validated GitHub login, or null when unavailable. */
export function githubIcon(owner: string): Promise<IconPayload | null> {
  if (!GITHUB_OWNER_PATTERN.test(owner)) return Promise.resolve(null);
  return resolveIcon('github', owner);
}

/** Favicon for a validated hostname, or null when unavailable. */
export function siteIcon(host: string): Promise<IconPayload | null> {
  if (!SITE_HOST_PATTERN.test(host)) return Promise.resolve(null);
  return resolveIcon('site', host);
}

function invalidate(kind: 'github' | 'site', id: string): void {
  const { img, meta } = cachePaths(cacheKey(kind, id.toLowerCase()));
  try {
    rmSync(img, { force: true });
    rmSync(meta, { force: true });
  } catch {
    // Removal failures are harmless: the TTL path refreshes eventually.
  }
}

/**
 * Drop the cached icon for a source the user just installed from, so the next
 * list render refetches it. Derives the cache key from the original input
 * (owner/repo, GitHub URL, well-known URL, bare host, or direct URL) — never
 * from a resolved tarball URL, whose host is not the source's own.
 */
export function invalidateIconForSource(input: string, repo?: string | null): void {
  const trimmed = input.trim();
  if (!trimmed) return;
  const githubCandidate =
    repo ??
    (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(trimmed)
      ? trimmed
      : (/^https?:\/\/github\.com\/([^/]+)/i.exec(trimmed)?.[1] ?? null));
  if (githubCandidate) {
    const owner = /^([A-Za-z0-9][A-Za-z0-9-]*)/.exec(githubCandidate)?.[1];
    if (owner) {
      invalidate('github', owner);
      return;
    }
  }
  let host: string | null = null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname || null;
    } catch {
      host = null;
    }
  } else if (SITE_HOST_PATTERN.test(trimmed)) {
    host = trimmed;
  }
  if (host) invalidate('site', host);
}
