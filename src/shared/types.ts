export type Scope = 'global' | 'project';

export type SourceKind = 'well-known' | 'github' | 'http' | 'unknown';

export type Locale = 'zh-CN' | 'en';

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: string;
}

export type GithubMode = 'auto' | 'direct';

export interface AppConfig {
  version: 1;
  locale: Locale | 'system';
  recentProjects: RecentProject[];
  activeProject: string | null;
  lastAgents: string[];
  activeScope: Scope;
  /**
   * auto: use the official Git-based flow for GitHub sources when Git is
   * available; direct: always use the HTTPS tarball fallback.
   */
  githubMode: GithubMode;
}

export interface GitStatus {
  available: boolean;
  version: string | null;
  /** Effective mode for this run: Git found and the user has not forced direct. */
  standard: boolean;
}

export interface AgentInfo {
  key: string;
  displayName: string;
  projectDir: string;
  globalDir: string | null;
  universal: boolean;
  supportsGlobal: boolean;
  detected: boolean;
}

export interface InstalledSkill {
  name: string;
  description: string | null;
  path: string | null;
  scope: Scope;
  agents: string[];
  agentKeys: string[];
  source: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  managedBy: 'cli' | 'skillsui';
  status: 'tracked' | 'untracked' | 'missing';
  repo: string | null;
  ref: string | null;
  installedAt: string | null;
  updatedAt: string | null;
}

export interface SourceSkill {
  name: string;
  description: string;
  files: number;
  installed: boolean;
  /** Group header the skill is listed under, when the source groups skills. */
  group?: string | null;
}

export interface SourceScan {
  kind: SourceKind;
  input: string;
  displaySource: string;
  repo: string | null;
  ref: string | null;
  tarballUrl: string | null;
  /** How a GitHub source will be installed; null for other source kinds. */
  installMode: 'standard' | 'direct' | null;
  skills: SourceSkill[];
  warnings: string[];
}

export interface UpdateOutcome {
  updated: string[];
  failed: Array<{ name: string; error: string }>;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobLogLine {
  at: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface JobSnapshot {
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
}

export interface Bootstrap {
  version: string;
  engineVersion: string;
  platform: NodeJS.Platform;
  config: AppConfig;
  agents: AgentInfo[];
  git: GitStatus;
  scope: Scope;
  projectPath: string | null;
  projects: RecentProject[];
  paths: {
    globalSkillsDir: string;
    configDir: string;
    engineDir: string;
  };
}

export interface InstallRequest {
  input: string;
  displaySource?: string | null;
  scope: Scope;
  projectPath: string | null;
  skills: string[];
  agents: string[];
  kind: SourceKind;
  repo?: string | null;
  ref?: string | null;
  tarballUrl?: string | null;
}

export interface RemoveRequest {
  names: string[];
  scope: Scope;
  projectPath: string | null;
}

export interface UpdateRequest {
  names?: string[];
  scope: Scope;
  projectPath: string | null;
  includeSkillsuiManaged: boolean;
}

export interface SettingsRequest {
  locale?: Locale | 'system';
  activeScope?: Scope;
  activeProject?: string | null;
  lastAgents?: string[];
  githubMode?: GithubMode;
}

export interface ApiError {
  error: string;
  code?: string;
  detail?: string;
}
