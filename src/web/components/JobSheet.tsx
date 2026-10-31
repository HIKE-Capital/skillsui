import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobSnapshot, UpdateOutcome } from '../../shared/types.js';
import type { Translate } from '../i18n.js';
import { AlertIcon, CheckIcon, SpinnerIcon, TerminalIcon } from './Icons.js';
import { Modal } from './Modal.js';

interface InstallOutcome {
  installed: string[];
  source: string;
  scope: string;
}

interface RemoveOutcome {
  removed: string[];
  failed: string[];
}

interface JobSheetProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  job: JobSnapshot | null;
  onCancel: () => void;
}

function statusTone(status: JobSnapshot['status']): string {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'muted';
  return 'running';
}

export function JobSheet({ open, onClose, t, job, onCancel }: JobSheetProps) {
  const [showLogs, setShowLogs] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const running = job?.status === 'running' || job?.status === 'queued';

  useEffect(() => {
    if (!open) return;
    setShowLogs(false);
  }, [open]);

  useEffect(() => {
    if (!running || !showLogs) return;
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [job?.logs, running, showLogs]);

  const summary = useMemo(() => {
    if (!job) return null;
    if (job.status === 'failed') {
      return (
        <div className="job-summary job-summary--danger">
          <AlertIcon size={18} />
          <div>
            <strong>{t('job.failed')}</strong>
            {job.error ? <p>{job.error}</p> : null}
          </div>
        </div>
      );
    }
    if (job.status === 'cancelled') {
      return (
        <div className="job-summary job-summary--muted">
          <AlertIcon size={18} />
          <div>
            <strong>{t('job.cancelled')}</strong>
          </div>
        </div>
      );
    }
    if (job.status !== 'succeeded') return null;

    if (job.type === 'install') {
      const result = job.result as InstallOutcome | null;
      return (
        <div className="job-summary job-summary--success">
          <CheckIcon size={18} />
          <div>
            <strong>{t('install.success')}</strong>
            <p>{result?.installed.join(', ')}</p>
          </div>
        </div>
      );
    }

    if (job.type === 'remove') {
      const result = job.result as RemoveOutcome | null;
      return (
        <div className="job-summary job-summary--success">
          <CheckIcon size={18} />
          <div>
            <strong>{t('remove.success')}</strong>
            <p>{result?.removed.join(', ')}</p>
            {result?.failed.length ? (
              <p className="job-summary-fail">
                {t('job.failed')}: {result.failed.join(', ')}
              </p>
            ) : null}
          </div>
        </div>
      );
    }

    if (job.type === 'update') {
      const result = job.result as UpdateOutcome | null;
      const updated = result?.updated.filter((name) => name !== '*') ?? [];
      return (
        <div className="job-summary job-summary--success">
          <CheckIcon size={18} />
          <div>
            <strong>{t('update.success')}</strong>
            {updated.length > 0 ? <p>{updated.join(', ')}</p> : <p>{t('update.none')}</p>}
            {result?.failed.length ? (
              <p className="job-summary-fail">
                {t('job.failed')}: {result.failed.map((item) => item.name).join(', ')}
              </p>
            ) : null}
          </div>
        </div>
      );
    }

    return null;
  }, [job, t]);

  if (!job) return null;

  const logs = job.logs;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={job.title}
      // Terminal states are announced by the big summary block below — the
      // title pill would duplicate it. Keep the pill for queued/running (and
      // as a fallback when a job type has no summary).
      subtitle={
        running || !summary ? (
          <span className={`job-status job-status--${statusTone(job.status)}`}>
            {running ? <SpinnerIcon size={14} /> : null}
            {t(
              job.status === 'queued'
                ? 'job.queued'
                : job.status === 'running'
                  ? 'job.running'
                  : job.status === 'succeeded'
                    ? 'job.succeeded'
                    : job.status === 'failed'
                      ? 'job.failed'
                      : 'job.cancelled'
            )}
          </span>
        ) : null
      }
      width="md"
      footer={
        <>
          {running ? (
            <button type="button" className="btn btn--ghost btn--danger-ghost" onClick={onCancel}>
              {t('job.cancel')}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn ${running ? 'btn--ghost' : 'btn--primary'}`}
            onClick={onClose}
          >
            {running ? t('actions.close') : t('actions.done')}
          </button>
        </>
      }
    >
      <div className="job">
        {summary}
        {running ? <p className="job-note">{t('job.closeHint')}</p> : null}

        <div className="job-logs-head">
          <span className="job-logs-title">
            <TerminalIcon size={15} />
            {t('job.logs')}
          </span>
          <button
            type="button"
            className="btn btn--text btn--small"
            onClick={() => setShowLogs((value) => !value)}
          >
            {showLogs ? t('job.hideLogs') : t('job.showLogs')}
          </button>
        </div>
        {showLogs ? (
          <pre ref={logRef} className="job-log" aria-live="polite">
            {logs.length === 0 ? (
              <span className="job-log-empty">{t('common.loading')}</span>
            ) : (
              logs.map((line, index) => (
                <span
                  key={`${line.at}-${index}`}
                  className={`log-line log-line--${line.stream}`}
                >
                  {line.text}
                  {'\n'}
                </span>
              ))
            )}
          </pre>
        ) : null}
      </div>
    </Modal>
  );
}
