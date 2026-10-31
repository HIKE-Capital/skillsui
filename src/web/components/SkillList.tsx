import { useState } from 'react';
import type { InstalledSkill } from '../../shared/types.js';
import { SOURCE_LANDING_PAGES } from '../../shared/sourcePages.js';
import type { Translate } from '../i18n.js';
import { AlertIcon, ExternalIcon, RefreshIcon, TrashIcon } from './Icons.js';

interface SkillListProps {
  t: Translate;
  skills: InstalledSkill[];
  loading: boolean;
  filter: string;
  onUpdate: (skill: InstalledSkill) => void;
  onRemove: (skill: InstalledSkill) => void;
  onRemoveGroup: (group: { label: string; skills: InstalledSkill[] }) => void;
  onClearFilter: () => void;
}

function skillInitials(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? name;
  return [...last].slice(0, 2).join('').toUpperCase();
}

function sourceLabel(t: Translate, skill: InstalledSkill): string {
  if (skill.repo) return skill.repo;
  if (skill.source) return skill.source;
  if (skill.managedBy === 'skillsui') return t('source.managed');
  return t('source.untracked');
}

function sourceTone(skill: InstalledSkill): 'jade' | 'amber' | 'muted' {
  if (skill.managedBy === 'skillsui') return 'amber';
  if (skill.source) return 'jade';
  return 'muted';
}

/** GitHub repository URL for a skill, when the source is a GitHub repo. */
function githubUrlFor(skill: InstalledSkill): string | null {
  const candidate = skill.repo ?? (skill.sourceType === 'github' ? skill.source : null);
  if (!candidate) return null;
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(candidate);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  const hosted = /github\.com\/([^/]+)\/([^/#?]+)/.exec(candidate);
  if (hosted) return `https://github.com/${hosted[1]}/${hosted[2]!.replace(/\.git$/, '')}`;
  return null;
}

/** Sources whose skill listing lives on a dedicated page instead of the site root. */
/** Hostname of a URL source (bare host or parsed from an http URL); null otherwise. */
function sourceHostFor(skill: InstalledSkill): string | null {
  const candidate = skill.source;
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      return new URL(candidate).hostname || null;
    } catch {
      return null;
    }
  }
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(candidate)) return candidate.toLowerCase();
  return null;
}

/** GitHub login of the skill's source repo, when there is one. */
function githubOwnerFor(skill: InstalledSkill): string | null {
  const candidate = skill.repo ?? (skill.sourceType === 'github' ? skill.source : null);
  if (!candidate) return null;
  const shorthand = /^([A-Za-z0-9][A-Za-z0-9-]*)\/[A-Za-z0-9._-]+?(?:\.git)?$/.exec(candidate);
  if (shorthand) return shorthand[1]!;
  const hosted = /github\.com\/([^/]+)/.exec(candidate);
  return hosted ? hosted[1]! : null;
}

/** Server icon endpoint for a skill row; null falls back to the letter mark. */
function iconEndpointFor(skill: InstalledSkill): string | null {
  const owner = githubOwnerFor(skill);
  if (owner) return `/api/icons/github/${owner.toLowerCase()}`;
  if (skill.sourceType === 'github' || skill.sourceType === 'local') return null;
  const host = sourceHostFor(skill);
  return host ? `/api/icons/site/${host.toLowerCase()}` : null;
}

/** Website URL for a skill's source; null when there is nothing sensible to open. */
function sourceUrlFor(skill: InstalledSkill): string | null {
  const github = githubUrlFor(skill);
  if (github) return github;
  if (skill.sourceType === 'github' || skill.sourceType === 'local') return null;
  const host = sourceHostFor(skill);
  if (!host) return null;
  const key = host.toLowerCase();
  return SOURCE_LANDING_PAGES[key] ?? `https://${key}/`;
}

function timeAgo(t: Translate, iso: string | null): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const diff = Date.now() - time;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t('common.justNow');
  if (minutes < 60) return t('common.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('common.daysAgo', { n: days });
  return new Date(time).toLocaleDateString();
}

function groupSkills(t: Translate, skills: InstalledSkill[]) {
  const groups = new Map<string, InstalledSkill[]>();
  for (const skill of skills) {
    const label = sourceLabel(t, skill);
    const list = groups.get(label) ?? [];
    list.push(skill);
    groups.set(label, list);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === t('source.untracked')) return 1;
    if (b === t('source.untracked')) return -1;
    return a.localeCompare(b);
  });
}

/** Skill row mark: letter placeholder with the source icon layered on top. */
function SkillMark({ tone, initial, icon }: { tone: string; initial: string; icon: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`skill-mark skill-mark--${tone}`} aria-hidden>
      {initial}
      {icon && !failed ? (
        <img
          className="skill-mark-img"
          src={icon}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}

export function SkillList({
  t,
  skills,
  loading,
  filter,
  onUpdate,
  onRemove,
  onRemoveGroup,
  onClearFilter,
}: SkillListProps) {
  if (loading) {
    return (
      <div className="catalog catalog--loading" aria-busy="true" aria-label={t('common.loading')}>
        {[0, 1, 2, 3].map((index) => (
          <div className="skeleton-row" key={index}>
            <div className="skeleton-mark" />
            <div className="skeleton-body">
              <div className="skeleton-line skeleton-line--name" />
              <div className="skeleton-line skeleton-line--desc" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="empty">
        <div className="empty-mark" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <h3 className="empty-title">
          {filter ? t('installed.noMatch') : t('installed.emptyTitle')}
        </h3>
        {filter ? (
          <>
            <p className="empty-body">{t('installed.filter')}</p>
            <button type="button" className="btn btn--ghost btn--small" onClick={onClearFilter}>
              {t('actions.retry')}
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="catalog">
      {groupSkills(t, skills).map(([source, group]) => {
        const sourceUrl = group.map(sourceUrlFor).find((url) => url !== null) ?? null;
        return (
        <section className="source-group" key={source}>
          <header className="source-group-head">
            {sourceUrl ? (
              <a
                className="source-group-name source-group-link"
                href={sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                title={sourceUrl}
              >
                {source}
              </a>
            ) : (
              <span className="source-group-name" title={source}>
                {source}
              </span>
            )}
            <span className="source-group-count">{group.length}</span>
            <div className="source-group-actions">
              {sourceUrl ? (
                <a
                  className="icon-button icon-button--small"
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={t('group.openSource')}
                  title={t('group.openSource')}
                >
                  <ExternalIcon size={14} />
                </a>
              ) : null}
              <button
                type="button"
                className="icon-button icon-button--small"
                onClick={() => onRemoveGroup({ label: source, skills: group })}
                aria-label={t('group.remove')}
                title={t('group.remove')}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </header>
          <div className="skill-rows">
            {group.map((skill) => {
              const missing = skill.status === 'missing';
              const markTone = missing
                ? 'danger'
                : skill.managedBy === 'skillsui'
                  ? 'amber'
                  : 'jade';
              const initial = skillInitials(skill.name);
              const icon = iconEndpointFor(skill);
              const agents = skill.agents;
              const shownAgents = agents.slice(0, 3);
              const hiddenAgents = agents.length - shownAgents.length;
              const updated = timeAgo(t, skill.updatedAt ?? skill.installedAt);

              return (
                <article className={`skill-row ${missing ? 'is-missing' : ''}`} key={skill.name}>
                  <SkillMark tone={markTone} initial={initial} icon={icon} />
                  <div className="skill-body">
                    <div className="skill-title-line">
                      <h3 className="skill-name">{skill.name}</h3>
                      {missing ? (
                        <span className="badge badge--danger">
                          <AlertIcon size={13} />
                          {t('status.missing')}
                        </span>
                      ) : null}
                      {skill.managedBy === 'skillsui' ? (
                        <span className={`chip chip--${sourceTone(skill)}`}>
                          {t('source.managed')}
                        </span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="skill-desc">{skill.description}</p>
                    ) : (
                      <p className="skill-desc skill-desc--empty">
                        {missing ? t('status.missingHint') : t('installed.title')}
                      </p>
                    )}
                    <div className="skill-meta">
                      {shownAgents.map((agent) => (
                        <span className="agent-chip" key={agent}>
                          {agent}
                        </span>
                      ))}
                      {hiddenAgents > 0 ? (
                        <span className="agent-chip agent-chip--more">
                          {t('agents.more', { n: hiddenAgents })}
                        </span>
                      ) : null}
                      {skill.sourceType ? (
                        <span className="skill-source-type">
                          {skill.sourceType === 'well-known'
                            ? t('source.wellKnown')
                            : skill.sourceType === 'github'
                              ? 'GitHub'
                              : skill.sourceType === 'download'
                                ? t('source.http')
                                : skill.sourceType === 'local'
                                  ? t('source.local')
                                  : skill.sourceType}
                        </span>
                      ) : null}
                      {updated ? <span className="skill-time">{updated}</span> : null}
                    </div>
                  </div>
                  <div className="skill-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--small btn--icon"
                      onClick={() => onUpdate(skill)}
                      aria-label={t('actions.update')}
                      title={t('actions.update')}
                    >
                      <RefreshIcon size={15} />
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small btn--danger-ghost btn--icon"
                      onClick={() => onRemove(skill)}
                      aria-label={t('actions.remove')}
                      title={t('actions.remove')}
                    >
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        );
      })}
    </div>
  );
}
