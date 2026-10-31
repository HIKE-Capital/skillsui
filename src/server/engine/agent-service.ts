import type { AgentInfo, Scope } from '../../shared/types.js';
import { agents, detectInstalledAgents, getAgentConfig, isUniversalAgent } from './agents.js';

export function allAgentKeys(): string[] {
  return Object.keys(agents);
}

export function agentDisplayName(key: string): string {
  return agents[key]?.displayName ?? key;
}

export function agentExists(key: string): boolean {
  return Object.hasOwn(agents, key);
}

export async function listAgents(projectPath: string | null): Promise<AgentInfo[]> {
  const detected = new Set(await detectInstalledAgents(projectPath ?? process.cwd()));
  return Object.entries(agents)
    .map(([key, config]) => ({
      key,
      displayName: config.displayName,
      projectDir: config.skillsDir,
      globalDir: config.globalSkillsDir ?? null,
      universal: isUniversalAgent(key),
      supportsGlobal: config.globalSkillsDir !== undefined,
      detected: detected.has(key),
    }))
    .sort((a, b) => {
      if (a.detected !== b.detected) return a.detected ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
}



