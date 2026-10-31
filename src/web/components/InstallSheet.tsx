import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo, Scope, SourceScan, SourceSkill } from '../../shared/types.js';
import type { Translate } from '../i18n.js';
import { CheckIcon, ChevronDownIcon, SpinnerIcon, AlertIcon } from './Icons.js';
import { Modal } from './Modal.js';

export interface InstallSelection {
  skills: string[];
  agents: string[];
  scope: Scope;
  projectPath: string | null;
}

interface InstallSheetProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  scan: SourceScan | null;
  scanning: boolean;
  scanError: string | null;
  onRetry: () => void;
  scope: Scope;
  projectPath: string | null;
  projectName: string | null;
  agents: AgentInfo[];
  lastAgents: string[];
  globalSkillsDir: string;
  onInstall: (selection: InstallSelection) => void;
}

function joinPath(base: string, relative: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${relative}`;
}

function agentPath(agent: AgentInfo, scope: Scope, projectPath: string | null): string | null {
  if (agent.universal) return null;
  if (scope === 'global') return agent.globalDir;
  if (!projectPath) return null;
  return joinPath(projectPath, agent.projectDir);
}

function defaultAgentKeys(agents: AgentInfo[], scope: Scope, lastAgents: string[]): string[] {
  const selectable = agents.filter((agent) => scope === 'global' || agent.supportsGlobal);
  const keys = new Set(selectable.map((agent) => agent.key));
  const fromLast = lastAgents.filter((key) => keys.has(key));
  if (fromLast.length > 0) return fromLast;
  const detected = selectable.filter((agent) => agent.detected).map((agent) => agent.key);
  if (detected.length > 0) return detected;
  const claude = selectable.find((agent) => agent.key === 'claude-code');
  if (claude) return [claude.key];
  const universal = selectable.find((agent) => agent.universal);
  return universal ? [universal.key] : [];
}

export function InstallSheet({
  open,
  onClose,
  t,
  scan,
  scanning,
  scanError,
  onRetry,
  scope,
  projectPath,
  projectName,
  agents,
  lastAgents,
  globalSkillsDir,
  onInstall,
}: InstallSheetProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [targetScope, setTargetScope] = useState<Scope>(scope);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const [truncatable, setTruncatable] = useState<Set<string>>(new Set());
  const skillListRef = useRef<HTMLDivElement | null>(null);

  const toggleExpandedSkill = (name: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setShowAllAgents(false);
    const nextScope: Scope = scope === 'project' && projectPath ? 'project' : 'global';
    setTargetScope(nextScope);
    setSelectedAgents(new Set(defaultAgentKeys(agents, nextScope, lastAgents)));
  }, [open, scope, projectPath, agents, lastAgents]);

  useEffect(() => {
    if (!scan) {
      setSelectedSkills(new Set());
      return;
    }
    const uninstalled = scan.skills.filter((skill) => !skill.installed).map((skill) => skill.name);
    const initial = uninstalled.length > 0 ? uninstalled : scan.skills.map((skill) => skill.name);
    setSelectedSkills(new Set(initial));
    setExpandedSkills(new Set());
  }, [scan]);

  // Mark descriptions that actually overflow their single line; only those
  // get an expand toggle.
  useEffect(() => {
    if (!scan) {
      setTruncatable(new Set());
      return;
    }
    const el = skillListRef.current;
    if (!el) return;
    const next = new Set<string>();
    for (const desc of el.querySelectorAll<HTMLElement>('.skill-option-desc')) {
      if (desc.scrollWidth <= desc.clientWidth + 1) continue;
      const name = desc.dataset.skill;
      if (name) next.add(name);
    }
    setTruncatable(next);
  }, [scan, step, open]);

  const selectableAgents = useMemo(
    () =>
      agents.filter((agent) => {
        if (targetScope === 'global' && !agent.supportsGlobal) return false;
        return true;
      }),
    [agents, targetScope]
  );

  /** Skill rows interleaved with group headers when the source groups skills. */
  const skillRows = useMemo(() => {
    if (!scan) return [];
    const rows: Array<
      { kind: 'group'; label: string | null; key: string } | { kind: 'skill'; skill: SourceSkill }
    > = [];
    let lastGroup: string | null | undefined;
    for (const skill of scan.skills) {
      const group = skill.group ?? null;
      if (group !== lastGroup) {
        rows.push({ kind: 'group', label: group, key: `group:${group ?? 'none'}` });
        lastGroup = group;
      }
      rows.push({ kind: 'skill', skill });
    }
    return rows;
  }, [scan]);

  const visibleAgents = useMemo(() => {
    const selected = selectedAgents;
    const list = selectableAgents.filter(
      (agent) =>
        showAllAgents ||
        agent.detected ||
        selected.has(agent.key) ||
        lastAgents.includes(agent.key)
    );
    return list.sort((a, b) => {
      if (a.detected !== b.detected) return a.detected ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [selectableAgents, selectedAgents, showAllAgents, lastAgents]);

  const sharedAgents = visibleAgents.filter((agent) => agent.universal);
  const dedicatedAgents = visibleAgents.filter((agent) => !agent.universal);
  const sharedPath =
    targetScope === 'global'
      ? globalSkillsDir
      : projectPath
        ? joinPath(projectPath, '.agents/skills')
        : null;

  const directoryCount = useMemo(
    () =>
      new Set(
        [...selectedAgents]
          .map((key) => agents.find((agent) => agent.key === key))
          .filter((agent): agent is AgentInfo => !!agent)
          .map((agent) =>
            targetScope === 'global'
              ? agent.universal
                ? '__shared__'
                : (agent.globalDir ?? agent.key)
              : agent.projectDir
          )
      ).size,
    [selectedAgents, agents, targetScope]
  );

  const toggleSkill = (skill: SourceSkill) => {
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(skill.name)) next.delete(skill.name);
      else next.add(skill.name);
      return next;
    });
  };

  const toggleAgent = (key: string) => {
    setSelectedAgents((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const changeScope = (nextScope: Scope) => {
    setTargetScope(nextScope);
    const allowed = new Set(
      agents
        .filter((agent) => nextScope === 'global' || agent.supportsGlobal)
        .map((agent) => agent.key)
    );
    setSelectedAgents((current) => new Set([...current].filter((key) => allowed.has(key))));
  };

  const allSelected = !!scan && scan.skills.length > 0 && selectedSkills.size === scan.skills.length;

  const canNext = selectedSkills.size > 0;
  const canInstall = selectedSkills.size > 0 && selectedAgents.size > 0;

  const renderAgent = (agent: AgentInfo, showPath = true) => {
    const path = showPath ? agentPath(agent, targetScope, projectPath) : null;
    const disabled = targetScope === 'global' && !agent.supportsGlobal;
    return (
      <label
        key={agent.key}
        className={`agent-option ${selectedAgents.has(agent.key) ? 'is-selected' : ''} ${
          disabled ? 'is-disabled' : ''
        }`}
      >
        <input
          type="checkbox"
          className="option-input"
          checked={selectedAgents.has(agent.key)}
          onChange={() => toggleAgent(agent.key)}
          disabled={disabled}
        />
        <span className="option-box" aria-hidden>
          <CheckIcon size={13} />
        </span>
        <span className="agent-option-body">
          <span className="agent-option-line">
            <span className="agent-option-name">{agent.displayName}</span>
            {agent.detected ? (
              <span className="detected-badge">{t('install.detected')}</span>
            ) : (
              <span className="muted-badge">{t('install.notDetected')}</span>
            )}
          </span>
          {path ? <span className="agent-path mono">{path}</span> : null}
        </span>
      </label>
    );
  };

  const title = t('install.title');
  const subtitle = scan ? (
    <span className="install-source-line">
      <span className="mono install-source-url" title={scan.displaySource}>
        {scan.displaySource}
      </span>
      <span className={`source-kind source-kind--${scan.kind}`}>
        {scan.kind === 'well-known'
          ? t('source.wellKnown')
          : scan.kind === 'github'
            ? t('source.github')
            : t('source.http')}
      </span>
    </span>
  ) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width="lg"
      className="install-modal"
      footer={
        scanning || scanError ? null : step === 1 ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('actions.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canNext}
              onClick={() => setStep(2)}
            >
              {t('actions.next')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('actions.cancel')}
            </button>
            <span className="modal-foot-spacer" />
            <button type="button" className="btn btn--ghost" onClick={() => setStep(1)}>
              {t('actions.back')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canInstall}
              onClick={() =>
                onInstall({
                  skills: [...selectedSkills],
                  agents: [...selectedAgents],
                  scope: targetScope,
                  projectPath: targetScope === 'project' ? projectPath : null,
                })
              }
            >
              {t('actions.install')} {selectedSkills.size}
            </button>
          </>
        )
      }
    >
      {scanning ? (
        <div className="install-loading">
          <SpinnerIcon size={26} />
          <p>{t('source.fetching')}</p>
        </div>
      ) : scanError ? (
        <div className="install-error">
          <div className="error-mark">
            <AlertIcon size={22} />
          </div>
          <h3>{t('error.title')}</h3>
          <p>{scanError}</p>
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            {t('actions.retry')}
          </button>
        </div>
      ) : scan ? (
        <div className="install">
          <ol className="install-steps">
            <li className={step === 1 ? 'is-current' : 'is-done'}>
              <span className="step-number">1</span>
              {t('install.step1')}
            </li>
            <li className={step === 2 ? 'is-current' : ''}>
              <span className="step-number">2</span>
              {t('install.step2')}
            </li>
          </ol>

          {scan.installMode ? (
            <p className="settings-hint install-mode-hint">
              {scan.installMode === 'standard'
                ? t('install.modeStandard')
                : t('install.modeDirect')}
            </p>
          ) : null}

          {step === 1 ? (
            <>
              <div className="install-list-head">
                <div>
                  <span className="install-count">
                    {scan.skills.length === 1
                      ? t('install.foundOne')
                      : t('install.found', { n: scan.skills.length })}
                  </span>
                  <span className="muted"> · {t('install.selected', { n: selectedSkills.size })}</span>
                </div>
                <div className="install-list-actions">
                  <button
                    type="button"
                    className="btn btn--text btn--small"
                    onClick={() =>
                      setSelectedSkills(
                        new Set(allSelected ? [] : scan.skills.map((skill) => skill.name))
                      )
                    }
                  >
                    {allSelected ? t('install.clear') : t('install.selectAll')}
                  </button>
                </div>
              </div>
              <div className="skill-options" ref={skillListRef}>
                {skillRows.map((row) => {
                  if (row.kind === 'group') {
                    return row.label ? (
                      <div className="skill-option-group" key={row.key}>
                        {row.label}
                      </div>
                    ) : null;
                  }
                  const skill = row.skill;
                  const checked = selectedSkills.has(skill.name);
                  const expanded = expandedSkills.has(skill.name);
                  const canExpand = truncatable.has(skill.name);
                  return (
                    <div
                      key={skill.name}
                      className={`skill-option ${checked ? 'is-selected' : ''} ${expanded ? 'is-expanded' : ''}`}
                      title={skill.description || skill.name}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('.option-input')) return;
                        toggleSkill(skill);
                      }}
                    >
                      <input
                        type="checkbox"
                        className="option-input"
                        checked={checked}
                        onChange={() => toggleSkill(skill)}
                      />
                      <span className="option-box" aria-hidden>
                        <CheckIcon size={12} />
                      </span>
                      <span className="skill-option-body">
                        <span className="skill-option-line">
                          <span className="skill-option-name">{skill.name}</span>
                          {skill.installed ? (
                            <span className="installed-badge">{t('install.installed')}</span>
                          ) : null}
                        </span>
                        {skill.description ? (
                          <span className="skill-option-desc" data-skill={skill.name}>
                            {skill.description}
                          </span>
                        ) : null}
                      </span>
                      {canExpand ? (
                        <span
                          className="skill-option-toggle-zone"
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          aria-label={expanded ? t('install.collapse') : t('install.expand')}
                          title={expanded ? t('install.collapse') : t('install.expand')}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpandedSkill(skill.name);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleExpandedSkill(skill.name);
                            }
                          }}
                        >
                          <ChevronDownIcon size={13} className="skill-option-toggle-chevron" />
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="install-where">
              <section className="where-section">
                <h3 className="where-title">{t('install.scope')}</h3>
                <div className="scope-options">
                  <button
                    type="button"
                    className={`scope-card ${targetScope === 'global' ? 'is-selected' : ''}`}
                    onClick={() => changeScope('global')}
                  >
                    <span className="scope-card-title">{t('install.scopeGlobal')}</span>
                    <span className="scope-card-hint">{t('install.scopeGlobalHint')}</span>
                    <span className="scope-card-path mono">~/.agents/skills</span>
                  </button>
                  <button
                    type="button"
                    className={`scope-card ${targetScope === 'project' ? 'is-selected' : ''}`}
                    onClick={() => changeScope('project')}
                    disabled={!projectPath}
                  >
                    <span className="scope-card-title">{t('install.scopeProject')}</span>
                    <span className="scope-card-hint">
                      {projectName ?? t('install.scopeProjectHint')}
                    </span>
                    <span className="scope-card-path mono">
                      {projectPath ? joinPath(projectPath, '.agents/skills') : t('common.na')}
                    </span>
                  </button>
                </div>
              </section>

              <section className="where-section">
                <div className="where-head">
                  <h3 className="where-title">{t('install.agents')}</h3>
                  <button
                    type="button"
                    className="btn btn--text btn--small"
                    onClick={() => setShowAllAgents((value) => !value)}
                  >
                    {showAllAgents ? t('actions.showDetected') : t('actions.showAll')}
                  </button>
                </div>
                <p className="where-hint">{t('install.agentsHint')}</p>

                {sharedAgents.length > 0 ? (
                  <div className="agent-group">
                    <div className="agent-group-title">
                      {t('install.universal')}
                      {sharedPath ? <span className="agent-group-path mono">{sharedPath}</span> : null}
                    </div>
                    <div className="agent-list">
                      {sharedAgents.map((agent) => renderAgent(agent, false))}
                    </div>
                  </div>
                ) : null}
                {dedicatedAgents.length > 0 ? (
                  <div className="agent-group">
                    <div className="agent-group-title">{t('install.dedicated')}</div>
                    <div className="agent-list">{dedicatedAgents.map((agent) => renderAgent(agent))}</div>
                  </div>
                ) : null}
              </section>

              <div className="install-summary">
                <div className="summary-line">
                  <span className="summary-prefix">{t('install.willInstall')}</span>
                  <strong>
                    {selectedSkills.size === 1
                      ? t('unit.skillOne')
                      : t('unit.skillMany', { n: selectedSkills.size })}
                    {' · '}
                    {directoryCount === 1
                      ? t('unit.dirOne')
                      : t('unit.dirMany', { n: directoryCount })}
                    {' · '}
                    {selectedAgents.size === 1
                      ? t('unit.agentOne')
                      : t('unit.agentMany', { n: selectedAgents.size })}
                  </strong>
                </div>
                <div className="summary-warning">
                  <AlertIcon size={15} />
                  {t('install.permission')}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
