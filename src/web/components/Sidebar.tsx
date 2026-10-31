import type { AgentInfo, RecentProject, Scope } from '../../shared/types.js';
import type { Translate } from '../i18n.js';
import {
  FolderIcon,
  GlobeIcon,
  OpenFolderIcon,
  PlusIcon,
  PowerIcon,
  SettingsIcon,
  XIcon,
} from './Icons.js';
import { Wordmark } from './Wordmark.js';

interface SidebarProps {
  t: Translate;
  projects: RecentProject[];
  scope: Scope;
  projectPath: string | null;
  agents: AgentInfo[];
  engineVersion: string;
  version: string;
  onSelectGlobal: () => void;
  onSelectProject: (project: RecentProject) => void;
  onAddProject: () => void;
  onRemoveProject: (project: RecentProject) => void;
  onOpenSettings: () => void;
  onQuit: () => void;
}

function projectLabel(project: RecentProject): string {
  return project.name || project.path;
}

export function Sidebar({
  t,
  projects,
  scope,
  projectPath,
  agents,
  engineVersion,
  version,
  onSelectGlobal,
  onSelectProject,
  onAddProject,
  onRemoveProject,
  onOpenSettings,
  onQuit,
}: SidebarProps) {
  return (
    <aside className="rail">
      <div className="rail-head">
        <Wordmark />
        <p className="wordmark-tagline">{t('app.tagline')}</p>
      </div>

      <nav className="rail-nav" aria-label="Scopes">
        <button
          type="button"
          className={`rail-scope ${scope === 'global' ? 'is-active' : ''}`}
          onClick={onSelectGlobal}
        >
          <GlobeIcon size={18} />
          <span className="rail-scope-body">
            <span className="rail-scope-title">{t('nav.global')}</span>
            <span className="rail-scope-hint">{t('nav.globalHint')}</span>
          </span>
        </button>

        <div className="rail-section">
          <span className="rail-section-title">{t('nav.projects')}</span>
        </div>

        <div className="rail-projects">
          {projects.length === 0 ? (
            <p className="rail-empty">{t('nav.emptyProjects')}</p>
          ) : (
            projects.map((project) => {
              const active = scope === 'project' && projectPath === project.path;
              return (
                <div key={project.path} className={`rail-project-wrap ${active ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    className={`rail-project ${active ? 'is-active' : ''}`}
                    onClick={() => onSelectProject(project)}
                    title={project.path}
                  >
                    {active ? <OpenFolderIcon size={17} /> : <FolderIcon size={17} />}
                    <span className="rail-project-body">
                      <span className="rail-project-name">{projectLabel(project)}</span>
                      <span className="rail-project-path">{project.path}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rail-project-remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveProject(project);
                    }}
                    aria-label={t('project.remove')}
                    title={t('project.removeHint')}
                  >
                    <XIcon size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <button type="button" className="rail-add" onClick={onAddProject}>
          <PlusIcon size={16} />
          {t('nav.addProject')}
        </button>
      </nav>

      <div className="rail-foot">
        <div className="rail-actions">
          <button
            type="button"
            className="rail-settings"
            onClick={onOpenSettings}
            aria-label={t('nav.settings')}
            title={t('nav.settings')}
          >
            <SettingsIcon size={17} />
            <span className="rail-settings-label">{t('nav.settings')}</span>
          </button>
          <button
            type="button"
            className="rail-quit"
            onClick={onQuit}
            aria-label={t('nav.quit')}
            title={t('nav.quit')}
          >
            <PowerIcon size={17} />
            <span className="rail-settings-label">{t('nav.quit')}</span>
          </button>
        </div>
        <div className="rail-meta">
          <span>v{version}</span>
          <span className="rail-meta-sep">·</span>
          <span>
            {t('footer.engine')} {engineVersion}
          </span>
        </div>
      </div>
    </aside>
  );
}
