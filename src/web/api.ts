import type {
  AgentInfo,
  AppConfig,
  Bootstrap,
  GitStatus,
  InstallRequest,
  InstalledSkill,
  JobLogLine,
  JobSnapshot,
  RemoveRequest,
  Scope,
  SettingsRequest,
  SourceScan,
  UpdateRequest,
} from '../shared/types.js';

export class ApiError extends Error {
  code: string;
  detail?: string;
  status: number;

  constructor(message: string, code = 'UNKNOWN', status = 500, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super('Unauthorized', 'UNAUTHORIZED', 401);
    this.name = 'UnauthorizedError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Network error',
      'NETWORK',
      0
    );
  }

  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      detail?: string;
    };
    throw new ApiError(
      body.error ?? `HTTP ${response.status}`,
      body.code ?? 'HTTP_ERROR',
      response.status,
      body.detail
    );
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  skills: (scope: Scope, projectPath: string | null) => {
    const params = new URLSearchParams({ scope });
    if (scope === 'project' && projectPath) params.set('project', projectPath);
    return request<{ scope: Scope; projectPath: string | null; skills: InstalledSkill[] }>(
      `/api/skills?${params.toString()}`
    );
  },
  scan: (input: string, scope: Scope, projectPath: string | null) =>
    request<SourceScan>('/api/sources/scan', {
      method: 'POST',
      body: JSON.stringify({ input, scope, projectPath }),
    }),
  install: (body: InstallRequest) =>
    request<{ jobId: string }>('/api/install', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  remove: (body: RemoveRequest) =>
    request<{ jobId: string }>('/api/remove', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (body: UpdateRequest) =>
    request<{ jobId: string }>('/api/update', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  job: (id: string) => request<JobSnapshot>(`/api/jobs/${id}`),
  cancelJob: (id: string) =>
    request<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  addProject: (path: string) =>
    request<{ config: AppConfig; agents: AgentInfo[] }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  pickProject: () =>
    request<{ cancelled: boolean; config: AppConfig; path?: string; agents?: AgentInfo[] }>(
      '/api/projects/pick',
      { method: 'POST' }
    ),
  removeProject: (path: string) =>
    request<{ config: AppConfig }>('/api/projects/remove', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  settings: (body: SettingsRequest) =>
    request<{ config: AppConfig; git: GitStatus }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  quit: () => request<{ ok: boolean }>('/api/quit', { method: 'POST' }),
};

export interface JobHandlers {
  onSnapshot?: (job: JobSnapshot) => void;
  onLog?: (line: JobLogLine) => void;
  onStatus?: (job: JobSnapshot) => void;
}

export function subscribeJob(jobId: string, handlers: JobHandlers): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener('snapshot', (event) => {
    try {
      handlers.onSnapshot?.(JSON.parse((event as MessageEvent).data) as JobSnapshot);
    } catch {
      // ignore malformed events
    }
  });
  source.addEventListener('log', (event) => {
    try {
      handlers.onLog?.(JSON.parse((event as MessageEvent).data) as JobLogLine);
    } catch {
      // ignore
    }
  });
  source.addEventListener('status', (event) => {
    try {
      const job = JSON.parse((event as MessageEvent).data) as JobSnapshot;
      handlers.onStatus?.(job);
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        setTimeout(close, 30);
      }
    } catch {
      // ignore
    }
  });
  source.onerror = () => {
    // EventSource retries automatically; the server closes cleanly after a
    // terminal status, so a dead connection after that is harmless.
  };

  return close;
}
