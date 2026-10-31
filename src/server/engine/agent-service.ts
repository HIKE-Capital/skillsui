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
      projectDetected: detected.has(key),
    }))
    .sort((a, b) => {
      if (a.detected !== b.detected) return a.detected ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
}

export function filterSelectableAgents(
  agentInfos: AgentInfo[],
  scope: Scope
): AgentInfo[] {
  return agentInfos.filter((agent) => (scope === 'global' ? agent.supportsGlobal : true));
}

export function resolveDefaultAgents(
  agentInfos: AgentInfo[],
  scope: Scope,
  lastAgents: string[]
): string[] {
  const selectable = new Set(filterSelectableAgents(agentInfos, scope).map((a) => a.key));
  const fromLast = lastAgents.filter((a) => selectable.has(a));
  if (fromLast.length > 0) return fromLast;
  const detected = agentInfos.filter((a) => a.detected && selectable.has(a.key)).map((a) => a.key);
  if (detected.length > 0) return detected;
  // A conservative fallback that works everywhere: Claude Code if available,
  // otherwise the first universal agent.
  const claude = agentInfos.find((a) => a.key === 'claude-code' && selectable.has(a.key));
  if (claude) return [claude.key];
  const universal = agentInfos.find((a) => a.universal && selectable.has(a.key));
  return universal ? [universal.key] : [];
}

export function validateAgents(keys: string[], scope: Scope): string[] {
  const errors: string[] = [];
  for (const key of keys) {
    if (!agentExists(key)) {
      errors.push(`未知的 agent：${key}`);
      continue;
    }
    if (scope === 'global' && getAgentConfig(key).globalSkillsDir === undefined) {
      errors.push(`${agentDisplayName(key)} 不支持全局安装`);
    }
  }
  return errors;
}
