import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Bootstrap,
  InstalledSkill,
  JobSnapshot,
  RecentProject,
  SourceScan,
} from '../shared/types.js';
import { api, ApiError, subscribeJob, UnauthorizedError } from './api.js';
import { AddProjectDialog } from './components/AddProjectDialog.js';
import { InstallSheet, type InstallSelection } from './components/InstallSheet.js';
import {
  AlertIcon,
  ListReloadIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
} from './components/Icons.js';
import { JobSheet } from './components/JobSheet.js';
import { RemoveDialog } from './components/RemoveDialog.js';
import { RemoveGroupDialog, type RemoveGroupTarget } from './components/RemoveGroupDialog.js';
import { SettingsSheet } from './components/SettingsSheet.js';
import { Sidebar } from './components/Sidebar.js';
import { Wordmark } from './components/Wordmark.js';
import { SkillList } from './components/SkillList.js';
import { SourceBar } from './components/SourceBar.js';
import { Toast, type ToastState } from './components/Toast.js';
import { resolveLocale, translate, type Locale } from './i18n.js';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Recent projects are sorted once when the page loads. Selecting a project
 * updates lastOpened in the background, but the sidebar order stays fixed for
 * the rest of the session; the new order appears on the next page load.
 */
function sortProjectsByLastOpened(projects: RecentProject[]): RecentProject[] {
  return [...projects].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
}

function Splash({ message }: { message: string }) {
  return (
    <div className="splash">
      <Wordmark large />
      <div className="splash-loading">
        <SpinnerIcon size={18} />
        <span>{message}</span>
      </div>
    </div>
  );
}

function AccessScreen({ locale }: { locale: Locale }) {
  return (
    <div className="screen">
      <div className="screen-card">
        <Wordmark />
        <h1 className="screen-title">{translate(locale, 'error.unauthorized')}</h1>
        <p className="screen-body">{translate(locale, 'error.unauthorizedBody')}</p>
      </div>
    </div>
  );
}

function ErrorScreen({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="screen">
      <div className="screen-card">
        <Wordmark />
        <h1 className="screen-title">{message}</h1>
        {detail ? <pre className="screen-detail">{detail}</pre> : null}
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loadingBootstrap, setLoadingBootstrap] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [quitting, setQuitting] = useState(false);

  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [sourceInput, setSourceInput] = useState('');
  const [scan, setScan] = useState<SourceScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);

  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [jobOpen, setJobOpen] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [removeSkill, setRemoveSkill] = useState<InstalledSkill | null>(null);
  const [removeGroup, setRemoveGroup] = useState<RemoveGroupTarget | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const finishedJobs = useRef(new Set<string>());
  const pendingAgents = useRef<string[] | null>(null);

  const locale = resolveLocale(bootstrap?.config.locale, navigator.language);
  const t = useCallback(
    (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );
  const fallbackLocale = resolveLocale('system', navigator.language);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const showToast = useCallback((tone: ToastState['tone'], message: string) => {
    setToast({ id: Date.now(), tone, message });
  }, []);

  const loadBootstrap = useCallback(async () => {
    setLoadingBootstrap(true);
    setFatalError(null);
    try {
      const data = await api.bootstrap();
      setBootstrap({ ...data, projects: sortProjectsByLastOpened(data.projects) });
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else setFatalError(errorMessage(error));
    } finally {
      setLoadingBootstrap(false);
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const scope = bootstrap?.scope ?? 'global';
  const projectPath = bootstrap?.projectPath ?? null;
  const currentProject = useMemo(
    () => bootstrap?.projects.find((project) => project.path === projectPath) ?? null,
    [bootstrap?.projects, projectPath]
  );
  const installProjectPath =
    projectPath ?? bootstrap?.config.activeProject ?? bootstrap?.projects[0]?.path ?? null;
  const installProjectName =
    bootstrap?.projects.find((project) => project.path === installProjectPath)?.name ?? null;

  const loadSkills = useCallback(async () => {
    if (!bootstrap) return;
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const result = await api.skills(
        bootstrap.scope,
        bootstrap.scope === 'project' ? bootstrap.projectPath : null
      );
      setSkills(result.skills);
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else setSkillsError(errorMessage(error));
    } finally {
      setSkillsLoading(false);
    }
  }, [bootstrap?.scope, bootstrap?.projectPath]);

  useEffect(() => {
    if (!bootstrap) return;
    void loadSkills();
  }, [bootstrap?.scope, bootstrap?.projectPath, loadSkills]);

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
    };
  }, []);

  const handleFinished = useCallback(
    (finished: JobSnapshot) => {
      if (finishedJobs.current.has(finished.id)) return;
      finishedJobs.current.add(finished.id);
      void loadSkills();

      if (finished.type === 'install') {
        if (finished.status === 'succeeded') {
          showToast('success', translate(locale, 'install.success'));
          const agents = pendingAgents.current;
          if (agents && agents.length > 0) {
            void api
              .settings({ lastAgents: agents })
              .then((response) =>
                setBootstrap((prev) => (prev ? { ...prev, config: response.config } : prev))
              )
              .catch(() => undefined);
          }
        } else if (finished.status === 'failed') {
          showToast('error', finished.error ?? translate(locale, 'job.failed'));
        }
        return;
      }

      if (finished.type === 'remove') {
        if (finished.status === 'succeeded') {
          showToast('success', translate(locale, 'remove.success'));
        } else if (finished.status === 'failed') {
          showToast('error', finished.error ?? translate(locale, 'job.failed'));
        }
        return;
      }

      if (finished.type === 'update') {
        if (finished.status === 'succeeded') {
          showToast('success', translate(locale, 'job.succeeded'));
        } else if (finished.status === 'failed') {
          showToast('error', finished.error ?? translate(locale, 'job.failed'));
        }
        return;
      }

      if (finished.status === 'failed') {
        showToast('error', finished.error ?? translate(locale, 'job.failed'));
      }
    },
    [loadSkills, locale, showToast]
  );

  const attachJob = useCallback(
    async (jobId: string) => {
      unsubscribeRef.current?.();
      setJobOpen(true);
      try {
        const initial = await api.job(jobId);
        setJob(initial);
        if (['succeeded', 'failed', 'cancelled'].includes(initial.status)) {
          handleFinished(initial);
        }
      } catch {
        // The SSE stream will provide the snapshot.
      }
      unsubscribeRef.current = subscribeJob(jobId, {
        onSnapshot: (snapshot) => setJob(snapshot),
        onLog: (line) =>
          setJob((prev) =>
            prev && prev.id === jobId ? { ...prev, logs: [...prev.logs, line] } : prev
          ),
        onStatus: (snapshot) => {
          setJob(snapshot);
          if (['succeeded', 'failed', 'cancelled'].includes(snapshot.status)) {
            handleFinished(snapshot);
          }
        },
      });
    },
    [handleFinished]
  );

  const scanningOrBusy =
    scanning || (job !== null && (job.status === 'running' || job.status === 'queued'));

  const scanFor = useCallback(
    async (input: string) => {
      const value = input.trim();
      if (!value || scanningOrBusy || !bootstrap) return;
      setInstallOpen(true);
      setScanning(true);
      setScanError(null);
      setScan(null);
      try {
        const result = await api.scan(
          value,
          bootstrap.scope,
          bootstrap.scope === 'project' ? bootstrap.projectPath : null
        );
        setScan(result);
      } catch (error) {
        if (error instanceof UnauthorizedError) setUnauthorized(true);
        else setScanError(errorMessage(error));
      } finally {
        setScanning(false);
      }
    },
    [bootstrap, scanningOrBusy]
  );

  const handleScan = (value?: string) => {
    void scanFor(value ?? sourceInput);
  };

  const handleInstall = async (selection: InstallSelection) => {
    if (!scan || !bootstrap) return;
    pendingAgents.current = selection.agents;
    try {
      const { jobId } = await api.install({
        input: sourceInput,
        displaySource: scan.displaySource,
        scope: selection.scope,
        projectPath: selection.projectPath,
        skills: selection.skills,
        agents: selection.agents,
        kind: scan.kind,
        repo: scan.repo,
        ref: scan.ref,
        tarballUrl: scan.tarballUrl,
      });
      setInstallOpen(false);
      setScan(null);
      await attachJob(jobId);
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const runUpdate = async (names: string[]) => {
    if (!bootstrap || scanningOrBusy) return;
    try {
      const { jobId } = await api.update({
        names,
        scope: bootstrap.scope,
        projectPath: bootstrap.scope === 'project' ? bootstrap.projectPath : null,
        includeSkillsuiManaged: true,
      });
      await attachJob(jobId);
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const confirmRemove = async (skill: InstalledSkill) => {
    if (!bootstrap) return;
    try {
      const { jobId } = await api.remove({
        names: [skill.name],
        scope: bootstrap.scope,
        projectPath: bootstrap.scope === 'project' ? bootstrap.projectPath : null,
      });
      await attachJob(jobId);
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const confirmRemoveGroup = async (skills: InstalledSkill[]) => {
    if (!bootstrap || skills.length === 0) return;
    try {
      const { jobId } = await api.remove({
        names: skills.map((skill) => skill.name),
        scope: bootstrap.scope,
        projectPath: bootstrap.scope === 'project' ? bootstrap.projectPath : null,
      });
      await attachJob(jobId);
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const selectGlobal = async () => {
    try {
      const response = await api.settings({ activeScope: 'global' });
      setBootstrap((prev) =>
        prev ? { ...prev, config: response.config, scope: 'global', projectPath: null } : prev
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const selectProject = async (project: RecentProject) => {
    try {
      const response = await api.addProject(project.path);
      setBootstrap((prev) =>
        prev
          ? {
              ...prev,
              config: response.config,
              agents: response.agents,
              scope: 'project',
              projectPath: response.config.activeProject,
              projects: prev.projects,
            }
          : prev
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const addProject = async (path: string) => {
    const response = await api.addProject(path);
    const activePath = response.config.activeProject;
    const added =
      response.config.recentProjects.find((project) => project.path === activePath) ?? null;
    setBootstrap((prev) => {
      if (!prev) return prev;
      const exists = prev.projects.some((project) => project.path === activePath);
      return {
        ...prev,
        config: response.config,
        agents: response.agents,
        scope: 'project',
        projectPath: activePath,
        projects: exists || !added ? prev.projects : [added, ...prev.projects],
      };
    });
  };

  const pickProject = async (): Promise<string | null> => {
    const response = await api.pickProject();
    return response.cancelled ? null : (response.path ?? null);
  };

  const removeProject = async (project: RecentProject) => {
    try {
      const response = await api.removeProject(project.path);
      setBootstrap((prev) =>
        prev
          ? {
              ...prev,
              config: response.config,
              projects: prev.projects.filter((entry) => entry.path !== project.path),
              scope: response.config.activeScope,
              projectPath: response.config.activeProject,
            }
          : prev
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const saveLocale = async (nextLocale: 'system' | 'zh-CN' | 'en') => {
    try {
      const response = await api.settings({ locale: nextLocale });
      setBootstrap((prev) =>
        prev ? { ...prev, config: response.config, git: response.git } : prev
      );
      showToast(
        'success',
        translate(resolveLocale(nextLocale, navigator.language), 'settings.saved')
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) setUnauthorized(true);
      else showToast('error', errorMessage(error));
    }
  };

  const quit = async () => {
    setQuitting(true);
    try {
      await api.quit();
    } catch {
      // The server may close the connection before responding.
    }
  };

  const filteredSkills = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        (skill.description ?? '').toLowerCase().includes(query) ||
        (skill.source ?? '').toLowerCase().includes(query) ||
        (skill.repo ?? '').toLowerCase().includes(query)
    );
  }, [skills, filter]);

  if (unauthorized) {
    return <AccessScreen locale={fallbackLocale} />;
  }

  if (quitting) {
    return (
      <div className="quit">
        <div className="quit-mark" aria-hidden>
          <span className="quit-halo" />
          <span className="mark-card mark-card--back quit-card-back" />
          <span className="mark-card mark-card--front quit-card-front" />
        </div>
        <h1 className="quit-title">{translate(locale, 'quit.title')}</h1>
        <p className="quit-body">{translate(locale, 'quit.body')}</p>
      </div>
    );
  }

  if (loadingBootstrap) {
    return <Splash message={translate(fallbackLocale, 'common.loading')} />;
  }

  if (fatalError || !bootstrap) {
    return (
      <ErrorScreen
        message={fatalError ?? translate(locale, 'error.unknown')}
        detail={undefined}
      />
    );
  }

  const pageTitle = scope === 'global' ? t('nav.global') : (currentProject?.name ?? t('nav.projects'));
  const pageSub = scope === 'global' ? t('nav.globalHint') : (projectPath ?? t('scope.projectHint'));

  return (
    <div className="app">
      <Sidebar
        t={t}
        projects={bootstrap.projects}
        scope={scope}
        projectPath={projectPath}
        agents={bootstrap.agents}
        engineVersion={bootstrap.engineVersion}
        version={bootstrap.version}
        quitAvailable={bootstrap.quitAvailable}
        onSelectGlobal={() => void selectGlobal()}
        onSelectProject={(project) => void selectProject(project)}
        onAddProject={() => setAddProjectOpen(true)}
        onRemoveProject={(project) => void removeProject(project)}
        onOpenSettings={() => setSettingsOpen(true)}
        onQuit={() => void quit()}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1 className="page-title">{pageTitle}</h1>
            <p className={`page-sub ${scope === 'project' ? 'mono' : ''}`}>{pageSub}</p>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void runUpdate([])}
              disabled={scanningOrBusy || skills.length === 0}
            >
              <RefreshIcon size={16} />
              {t('actions.updateAll')}
            </button>
          </div>
        </header>

        <div className="content">
          <SourceBar
            value={sourceInput}
            onChange={setSourceInput}
            onSubmit={handleScan}
            busy={scanningOrBusy}
            t={t}
          />

          <section className="catalog-section">
            <div className="catalog-head">
              <div className="catalog-title-wrap">
                <h2 className="catalog-title">{t('installed.title')}</h2>
                <span className="catalog-count">
                  {skills.length === 1
                    ? t('unit.skillOne')
                    : t('unit.skillMany', { n: skills.length })}
                </span>
              </div>
              <div className="catalog-tools">
                <label className="filter">
                  <SearchIcon size={16} />
                  <input
                    className="filter-input"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t('installed.filter')}
                    aria-label={t('installed.filter')}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void loadSkills()}
                  disabled={skillsLoading}
                  aria-label={t('installed.refresh')}
                  title={t('installed.refresh')}
                >
                  {skillsLoading ? <SpinnerIcon size={16} /> : <ListReloadIcon size={16} />}
                </button>
              </div>
            </div>

            {skillsError ? (
              <div className="inline-error">
                <AlertIcon size={17} />
                <span>{skillsError}</span>
                <button type="button" className="btn btn--text btn--small" onClick={() => void loadSkills()}>
                  {t('actions.retry')}
                </button>
              </div>
            ) : null}

            <SkillList
              t={t}
              skills={filteredSkills}
              loading={skillsLoading && skills.length === 0}
              filter={filter}
              onUpdate={(skill) => void runUpdate([skill.name])}
              onRemove={(skill) => setRemoveSkill(skill)}
              onRemoveGroup={(group) => setRemoveGroup(group)}
              onClearFilter={() => setFilter('')}
              onTryExample={() => {
                setSourceInput('https://q.hikecapital.com');
                void scanFor('https://q.hikecapital.com');
              }}
            />
          </section>
        </div>
      </main>

      <InstallSheet
        open={installOpen}
        onClose={() => {
          setInstallOpen(false);
          setScan(null);
          setScanError(null);
        }}
        t={t}
        scan={scan}
        scanning={scanning}
        scanError={scanError}
        onRetry={() => void scanFor(sourceInput)}
        scope={scope}
        projectPath={installProjectPath}
        projectName={installProjectName}
        agents={bootstrap.agents}
        lastAgents={bootstrap.config.lastAgents}
        globalSkillsDir={bootstrap.paths.globalSkillsDir}
        onInstall={(selection) => void handleInstall(selection)}
      />

      <JobSheet
        open={jobOpen}
        onClose={() => setJobOpen(false)}
        t={t}
        job={job}
        onCancel={() => {
          if (job) void api.cancelJob(job.id).catch(() => undefined);
        }}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        t={t}
        config={bootstrap.config}
        paths={bootstrap.paths}
        engineVersion={bootstrap.engineVersion}
        version={bootstrap.version}
        platform={bootstrap.platform}
        onSave={(nextLocale) => void saveLocale(nextLocale)}
      />

      <AddProjectDialog
        open={addProjectOpen}
        onClose={() => setAddProjectOpen(false)}
        t={t}
        onAdd={addProject}
        onPick={pickProject}
      />

      <RemoveDialog
        open={removeSkill !== null}
        onClose={() => setRemoveSkill(null)}
        t={t}
        skill={removeSkill}
        onConfirm={(skill) => void confirmRemove(skill)}
      />

      <RemoveGroupDialog
        open={removeGroup !== null}
        onClose={() => setRemoveGroup(null)}
        t={t}
        group={removeGroup}
        onConfirm={(skills) => void confirmRemoveGroup(skills)}
      />

      {job && !jobOpen && (job.status === 'running' || job.status === 'queued') ? (
        <button type="button" className="job-pill" onClick={() => setJobOpen(true)}>
          <SpinnerIcon size={16} />
          <span>{job.title}</span>
          <span className="job-pill-status">{t('job.running')}</span>
        </button>
      ) : null}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
