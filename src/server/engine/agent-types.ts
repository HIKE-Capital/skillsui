export interface AgentConfig {
  name: string;
  displayName: string;
  skillsDir: string;
  globalSkillsDir?: string;
  createProjectSkillsDirByDefault?: boolean;
  showInUniversalPrompt?: boolean;
  showInUniversalList?: boolean;
  detectInstalled: () => Promise<boolean>;
}

export type AgentType = string;
