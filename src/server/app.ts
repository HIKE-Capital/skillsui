import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  AppConfig,
  Bootstrap,
  GitStatus,
  InstallRequest,
  RemoveRequest,
  Scope,
  SettingsRequest,
  UpdateRequest,
} from '../shared/types.js';
import {
  addRecentProject,
  isProjectDir,
  loadConfig,
  patchConfig,
  removeRecentProject,
  resolveProjectPath,
} from './config.js';
import { AppError } from './errors.js';
import {
  APP_VERSION,
  engineRoot,
  engineVersion,
  skillsuiHome,
  webDistDir,
} from './paths.js';
import { listAgents, agentExists } from './engine/agent-service.js';
import { getGitInfo, refreshGitInfo } from './engine/git.js';
import { cancelJob, enqueueJob, getJob, listJobs, subscribeJob } from './engine/jobs.js';
import { listInstalledSkills } from './engine/list.js';
import { githubIcon, siteIcon } from './engine/icons.js';
import { installSkills, removeSkills, updateSkills } from './engine/operations.js';
import { scanSource } from './engine/sources.js';

const execFileAsync = promisify(execFile);

export interface AppOptions {
  token: string;
  dev?: boolean;
  port: number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function errorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code, detail: error.detail },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: message, code: 'INTERNAL' } };
}

function assertScope(value: unknown): Scope {
  if (value === 'global' || value === 'project') return value;
  throw new AppError('INVALID_SCOPE', '作用域参数不正确。');
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('INVALID_INPUT', `缺少参数：${field}`);
  }
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeProject(scope: Scope, value: unknown): string | null {
  if (scope === 'global') return null;
  const path = assertString(value, 'projectPath');
  if (!isProjectDir(path)) {
    throw new AppError('PROJECT_NOT_FOUND', `项目文件夹不存在：${path}`);
  }
  return resolve(path);
}

async function installedNameSet(scope: Scope, projectPath: string | null): Promise<Set<string>> {
  try {
    const listed = await listInstalledSkills(scope, projectPath);
    return new Set(listed.skills.map((skill) => skill.name));
  } catch {
    return new Set();
  }
}

async function currentGitStatus(config: AppConfig): Promise<GitStatus> {
  const info = await getGitInfo();
  return {
    available: info.available,
    version: info.version,
    standard: config.githubMode !== 'direct' && info.available,
  };
}

async function pickFolder(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Select a project folder")'],
        { timeout: 120_000 }
      );
      const path = stdout.trim().replace(/\/$/, '');
      return path || null;
    }
    if (process.platform === 'win32') {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "$d.Description = 'Select a project folder'; " +
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', script],
        { timeout: 120_000, windowsHide: true }
      );
      const path = stdout.trim();
      return path || null;
    }
    const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory'], {
      timeout: 120_000,
    });
    const path = stdout.trim().replace(/\/$/, '');
    return path || null;
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendWebFile(filePath: string, requestPath: string, reply: FastifyReply): FastifyReply {
  reply.type(MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  reply.header(
    'Cache-Control',
    requestPath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  );
  return reply.send(createReadStream(filePath));
}

function serveWeb(
  request: FastifyRequest,
  reply: FastifyReply,
  webRoot: string
): FastifyReply {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  } catch {
    return reply.code(400).type('text/plain').send('Bad request');
  }
  if (pathname.includes('\u0000')) {
    return reply.code(400).type('text/plain').send('Bad request');
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(webRoot, relative);
  const rootPrefix = webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`;
  if (candidate !== webRoot && !candidate.startsWith(rootPrefix)) {
    return reply.code(404).type('text/plain').send('Not found');
  }

  let isFile = false;
  try {
    isFile = statSync(candidate).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) return sendWebFile(candidate, pathname, reply);

  if (extname(pathname)) {
    return reply.code(404).type('text/plain').send('Not found');
  }

  const index = join(webRoot, 'index.html');
  if (!existsSync(index)) {
    return reply.code(503).type('text/plain').send('Skillsui web assets are not built.');
  }
  return sendWebFile(index, '/index.html', reply);
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const token = options.token;
  const dev = options.dev === true;
  const webRoot = webDistDir();
  const hasWeb = existsSync(join(webRoot, 'index.html'));

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Token bootstrap: /?token=... sets an HttpOnly same-site cookie.
    if (request.method === 'GET' && request.url.startsWith('/') && !request.url.startsWith('/api/')) {
      const url = new URL(request.url, 'http://127.0.0.1');
      const queryToken = url.searchParams.get('token');
      if (queryToken) {
        if (!tokensEqual(queryToken, token)) {
          return reply.code(401).type('text/plain').send('Invalid Skillsui token.');
        }
        reply.header(
          'Set-Cookie',
          `skillsui_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
        );
        return reply.redirect('/');
      }
    }

    if (!request.url.startsWith('/api/')) return;
    if (dev) return;
    if (request.url === '/api/health') return;

    const origin = request.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const host = request.headers.host;
        if (!host || originUrl.host !== host) {
          return reply.code(403).send({ error: 'Origin not allowed', code: 'FORBIDDEN' });
        }
      } catch {
        return reply.code(403).send({ error: 'Origin not allowed', code: 'FORBIDDEN' });
      }
    }

    const cookies = parseCookies(request.headers.cookie);
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : null;
    const provided = bearer ?? cookies.skillsui_session ?? '';
    if (!provided || !tokensEqual(provided, token)) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = errorBody(error);
    if (status >= 500) console.error(error);
    reply.code(status).send(body);
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: APP_VERSION,
    engineVersion: engineVersion(),
  }));

  app.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    const config = loadConfig();
    let scope = config.activeScope;
    let projectPath = config.activeProject;
    if (scope === 'project' && (!projectPath || !isProjectDir(projectPath))) {
      scope = 'global';
      projectPath = null;
    }
    const agents = await listAgents(projectPath);
    const git = await currentGitStatus(config);
    return {
      version: APP_VERSION,
      engineVersion: engineVersion(),
      platform: process.platform,
      config,
      agents,
      git,
      scope,
      projectPath,
      projects: config.recentProjects,
      paths: {
        globalSkillsDir: join(homedir(), '.agents', 'skills'),
        configDir: skillsuiHome(),
        engineDir: (() => {
          try {
            return engineRoot();
          } catch {
            return 'unknown';
          }
        })(),
      },
    };
  });

  app.get('/api/skills', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const scope = assertScope(query.scope ?? 'global');
    const projectPath = scope === 'project' ? normalizeProject(scope, query.project) : null;
    const result = await listInstalledSkills(scope, projectPath);
    return { scope, projectPath, skills: result.skills };
  });

  // Icons revalidate on every render (no-cache + ETag): after an install
  // invalidates the server cache, the browser must be able to see the change
  // immediately instead of serving its own copy for a day. Loopback round
  // trips are free; unchanged icons answer with 304.
  const sendIcon = (
    reply: FastifyReply,
    request: FastifyRequest,
    icon: { data: Buffer; contentType: string }
  ) => {
    const etag = `"${createHash('sha256').update(icon.data).digest('hex').slice(0, 20)}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'private, no-cache');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('content-type', icon.contentType);
    return reply.send(icon.data);
  };

  app.get('/api/icons/github/:owner', async (request, reply) => {
    const { owner } = request.params as { owner: string };
    const icon = await githubIcon(owner);
    if (!icon) {
      reply.header('cache-control', 'private, no-cache');
      return reply.code(404).send({});
    }
    return sendIcon(reply, request, icon);
  });

  app.get('/api/icons/site/:host', async (request, reply) => {
    const { host } = request.params as { host: string };
    const icon = await siteIcon(host);
    if (!icon) {
      reply.header('cache-control', 'private, no-cache');
      return reply.code(404).send({});
    }
    return sendIcon(reply, request, icon);
  });

  app.post('/api/sources/scan', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = assertString(body.input, 'input');
    const scope = assertScope(body.scope ?? 'global');
    const projectPath = scope === 'project' ? normalizeProject(scope, body.projectPath) : null;
    const installed = await installedNameSet(scope, projectPath);
    const config = loadConfig();
    const standardGithub =
      config.githubMode !== 'direct' && (await getGitInfo()).available;
    return scanSource(input, {
      scope,
      projectPath,
      installedNames: installed,
      standardGithub,
    });
  });

  app.post('/api/install', async (request) => {
    const body = (request.body ?? {}) as InstallRequest;
    const scope = assertScope(body.scope);
    const projectPath = scope === 'project' ? normalizeProject(scope, body.projectPath) : null;
    const installRequest: InstallRequest = {
      input: assertString(body.input, 'input'),
      displaySource: typeof body.displaySource === 'string' ? body.displaySource : null,
      scope,
      projectPath,
      skills: stringArray(body.skills),
      agents: stringArray(body.agents),
      kind: body.kind,
      repo: typeof body.repo === 'string' ? body.repo : null,
      ref: typeof body.ref === 'string' ? body.ref : null,
      tarballUrl: typeof body.tarballUrl === 'string' ? body.tarballUrl : null,
    };
    if (!['well-known', 'github', 'http'].includes(installRequest.kind)) {
      throw new AppError('INVALID_SOURCE', '来源类型不正确。');
    }
    const job = enqueueJob(
      'install',
      `安装 ${installRequest.skills.length} 个 skill`,
      (ctx) => installSkills(installRequest, ctx)
    );
    return { jobId: job.id };
  });

  app.post('/api/remove', async (request) => {
    const body = (request.body ?? {}) as RemoveRequest;
    const scope = assertScope(body.scope);
    const projectPath = scope === 'project' ? normalizeProject(scope, body.projectPath) : null;
    const removeRequest: RemoveRequest = {
      names: stringArray(body.names),
      scope,
      projectPath,
    };
    if (removeRequest.names.length === 0) {
      throw new AppError('NO_SKILLS_SELECTED', '请至少选择一个 skill。');
    }
    const job = enqueueJob(
      'remove',
      `卸载 ${removeRequest.names.join(', ')}`,
      (ctx) => removeSkills(removeRequest, ctx)
    );
    return { jobId: job.id };
  });

  app.post('/api/update', async (request) => {
    const body = (request.body ?? {}) as UpdateRequest;
    const scope = assertScope(body.scope);
    const projectPath = scope === 'project' ? normalizeProject(scope, body.projectPath) : null;
    const updateRequest: UpdateRequest = {
      names: stringArray(body.names),
      scope,
      projectPath,
      includeSkillsuiManaged: body.includeSkillsuiManaged !== false,
    };
    const job = enqueueJob('update', '更新技能', (ctx) => updateSkills(updateRequest, ctx));
    return { jobId: job.id };
  });

  app.get('/api/jobs', async () => listJobs());

  app.get('/api/jobs/:id', async (request) => {
    const params = request.params as { id: string };
    const job = getJob(params.id);
    if (!job) throw new AppError('JOB_NOT_FOUND', '任务不存在。', 404);
    return job;
  });

  app.post('/api/jobs/:id/cancel', async (request) => {
    const params = request.params as { id: string };
    return { cancelled: cancelJob(params.id) };
  });

  app.get('/api/jobs/:id/events', async (request, reply) => {
    const params = request.params as { id: string };
    const job = getJob(params.id);
    if (!job) throw new AppError('JOB_NOT_FOUND', '任务不存在。', 404);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: 1500\n\n`);
    raw.write(`event: snapshot\ndata: ${JSON.stringify(job)}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        raw.write(`: ping\n\n`);
      } catch {
        // ignore
      }
    }, 15_000);
    heartbeat.unref();

    const unsubscribe = subscribeJob(params.id, (event) => {
      try {
        if (event.type === 'log') {
          raw.write(`event: log\ndata: ${JSON.stringify(event.line)}\n\n`);
        } else {
          raw.write(`event: status\ndata: ${JSON.stringify(event.job)}\n\n`);
          if (['succeeded', 'failed', 'cancelled'].includes(event.job.status)) {
            setTimeout(() => {
              try {
                raw.end();
              } catch {
                // ignore
              }
            }, 50);
          }
        }
      } catch {
        // ignore
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  app.post('/api/projects', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const path = assertString(body.path, 'path');
    const config = addRecentProject(path);
    const agents = await listAgents(config.activeProject);
    return { config, agents };
  });

  app.post('/api/projects/pick', async () => {
    const path = await pickFolder();
    if (!path) return { cancelled: true, config: loadConfig() };
    if (!isProjectDir(path)) {
      throw new AppError('PROJECT_NOT_FOUND', `文件夹不存在：${path}`);
    }
    return { cancelled: false, config: loadConfig(), path };
  });

  app.post('/api/projects/remove', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const path = assertString(body.path, 'path');
    return { config: removeRecentProject(path) };
  });

  app.post('/api/settings', async (request) => {
    const body = (request.body ?? {}) as SettingsRequest;
    const patch: Partial<AppConfig> = {};
    if (body.locale === 'zh-CN' || body.locale === 'en' || body.locale === 'system') {
      patch.locale = body.locale;
    }
    if (body.activeScope) {
      const scope = assertScope(body.activeScope);
      if (scope === 'project') {
        const config = loadConfig();
        const path = body.activeProject ?? config.activeProject;
        if (!path || !isProjectDir(path)) {
          throw new AppError('PROJECT_REQUIRED', '请先选择一个项目。');
        }
        patch.activeScope = 'project';
        patch.activeProject = resolve(path);
      } else {
        patch.activeScope = 'global';
      }
    }
    if (Array.isArray(body.lastAgents)) {
      patch.lastAgents = body.lastAgents.filter(
        (key): key is string => typeof key === 'string' && agentExists(key)
      );
    }
    if (body.githubMode === 'auto' || body.githubMode === 'direct') {
      patch.githubMode = body.githubMode;
      // The user may have installed Git since launch; re-probe on save.
      await refreshGitInfo();
    }
    if (body.activeProject !== undefined && body.activeProject !== null) {
      const path = resolveProjectPath(body.activeProject);
      const config = addRecentProject(path);
      return { config, git: await currentGitStatus(config) };
    }
    const config = patchConfig(patch);
    return { config, git: await currentGitStatus(config) };
  });

  app.post('/api/quit', async (_request, reply) => {
    reply.send({ ok: true });
    setTimeout(() => process.exit(0), 120);
    return reply;
  });

  app.get('/', (request, reply) => serveWeb(request, reply, webRoot));
  app.get('/*', (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
    }
    return serveWeb(request, reply, webRoot);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
    }
    if (hasWeb && request.method === 'GET') {
      return serveWeb(request, reply, webRoot);
    }
    return reply
      .code(503)
      .type('text/plain')
      .send('Skillsui web assets are not built. Run `npm run build:web` first.');
  });

  return app;
}

export async function startServer(app: FastifyInstance, port: number): Promise<number> {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (address && typeof address === 'object') return address.port;
  return port;
}
