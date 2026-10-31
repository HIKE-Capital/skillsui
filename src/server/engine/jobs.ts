import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobLogLine, JobSnapshot, JobStatus } from '../../shared/types.js';
import { AppError } from '../errors.js';
import { ensureSkillsuiHome, logsDir } from '../paths.js';

export interface JobContext {
  log: (text: string, stream?: JobLogLine['stream']) => void;
  signal: AbortSignal;
}

export type JobEvent = { type: 'log'; line: JobLogLine } | { type: 'status'; job: JobSnapshot };

interface InternalJob {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  logs: JobLogLine[];
  result: unknown;
  error: string | null;
  controller: AbortController;
  listeners: Set<(event: JobEvent) => void>;
  runner: (ctx: JobContext) => Promise<unknown>;
}

const MAX_LOGS = 5000;
const MAX_FINISHED_JOBS = 40;

const jobs = new Map<string, InternalJob>();
const queue: string[] = [];
let running = false;

function snapshot(job: InternalJob): JobSnapshot {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    logs: [...job.logs],
    result: job.result,
    error: job.error,
  };
}

function emit(job: InternalJob, event: JobEvent): void {
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch {
      // Subscriber failures must not break the job.
    }
  }
}

function appendLog(job: InternalJob, text: string, stream: JobLogLine['stream'] = 'system'): void {
  const line: JobLogLine = { at: Date.now(), stream, text };
  job.logs.push(line);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
  emit(job, { type: 'log', line });
}

function evictOldJobs(): void {
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  while (finished.length > MAX_FINISHED_JOBS) {
    const victim = finished.shift();
    if (victim) jobs.delete(victim.id);
  }
}

function finish(job: InternalJob, status: JobStatus, error: string | null): void {
  job.status = status;
  job.error = error;
  job.finishedAt = Date.now();
  try {
    ensureSkillsuiHome();
    const logPath = join(logsDir(), `${job.id}.log`);
    const content = job.logs
      .map((line) => `[${new Date(line.at).toISOString()}] ${line.stream}: ${line.text}`)
      .join('\n');
    writeFileSync(logPath, content + '\n', 'utf-8');
  } catch {
    // Log files are best-effort.
  }
  emit(job, { type: 'status', job: snapshot(job) });
  evictOldJobs();
}

async function pump(): Promise<void> {
  if (running) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job) {
    await pump();
    return;
  }
  running = true;
  job.status = 'running';
  job.startedAt = Date.now();
  emit(job, { type: 'status', job: snapshot(job) });

  try {
    job.result = await job.runner({
      log: (text, stream) => appendLog(job, text, stream ?? 'system'),
      signal: job.controller.signal,
    });
    if (job.controller.signal.aborted) {
      finish(job, 'cancelled', '已取消');
    } else {
      finish(job, 'succeeded', null);
    }
  } catch (error) {
    if (job.controller.signal.aborted) {
      finish(job, 'cancelled', '已取消');
    } else {
      const message =
        error instanceof AppError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      appendLog(job, message, 'stderr');
      finish(job, 'failed', message);
    }
  } finally {
    running = false;
    void pump();
  }
}

export function enqueueJob(
  type: string,
  title: string,
  runner: (ctx: JobContext) => Promise<unknown>
): JobSnapshot {
  const job: InternalJob = {
    id: randomUUID(),
    type,
    title,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    logs: [],
    result: null,
    error: null,
    controller: new AbortController(),
    listeners: new Set(),
    runner,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  appendLog(job, title);
  void pump();
  return snapshot(job);
}

export function getJob(id: string): JobSnapshot | null {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function subscribeJob(id: string, listener: (event: JobEvent) => void): (() => void) | null {
  const job = jobs.get(id);
  if (!job) return null;
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    const index = queue.indexOf(id);
    if (index !== -1) queue.splice(index, 1);
    finish(job, 'cancelled', '已取消');
    return true;
  }
  if (job.status === 'running') {
    job.controller.abort();
    return true;
  }
  return false;
}

export function listJobs(): JobSnapshot[] {
  return [...jobs.values()]
    .map(snapshot)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
}
