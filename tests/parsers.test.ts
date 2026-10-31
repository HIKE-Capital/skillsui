import { describe, expect, it } from 'vitest';
import {
  classifySource,
  parseAvailableSkills,
  parseGithubInput,
  standardGithubSource,
} from '../src/server/engine/sources.js';

describe('parseAvailableSkills', () => {
  it('parses names and indented descriptions from the CLI list block', () => {
    const output = `
│
◇  Available Skills
│
│    alpha
│
│      First line of the description.
│      Second line continues.
│
│    beta-skill
│
│      Another description.
│
└  Use --skill <name> to install specific skills
`;
    const skills = parseAvailableSkills(output);
    expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'beta-skill']);
    expect(skills[0]?.description).toContain('First line');
    expect(skills[0]?.description).toContain('Second line');
    expect(skills[1]?.description).toBe('Another description.');
  });

  it('falls back to Skill: log lines', () => {
    const output = `
◇  Skill: gamma
│
│   Gamma description.
│
◇  Skill: delta
│
│   Delta description.
`;
    expect(parseAvailableSkills(output).map((skill) => skill.name)).toEqual([
      'gamma',
      'delta',
    ]);
  });

  it('skips group headers in grouped repos (e.g. anthropics/skills)', () => {
    const output = `
◇  Found 4 skills

◇  Available Skills
Academy Guide
│
│    academy-guide
│
│      Academy guide description.
│
Document Skills
│
│    docx
│
│      Word documents description.
│
│    pdf
│
│      PDF description.
│
└  Use --skill <name> to install specific skills
`;
    const skills = parseAvailableSkills(output);
    expect(skills.map((skill) => skill.name)).toEqual(['academy-guide', 'docx', 'pdf']);
    expect(skills.map((skill) => skill.group)).toEqual([
      'Academy Guide',
      'Document Skills',
      'Document Skills',
    ]);
    expect(skills[0]?.description).toBe('Academy guide description.');
    expect(skills[1]?.description).toBe('Word documents description.');
    expect(skills[2]?.description).toBe('PDF description.');
  });
});

describe('GitHub source parsing', () => {
  it('parses owner/repo shorthand', () => {
    const parsed = parseGithubInput('vercel-labs/agent-skills');
    expect(parsed?.owner).toBe('vercel-labs');
    expect(parsed?.repo).toBe('agent-skills');
    expect(parsed?.ref).toBe('HEAD');
    expect(parsed?.tarballUrl).toBe(
      'https://codeload.github.com/vercel-labs/agent-skills/tar.gz/HEAD'
    );
  });

  it('parses tree URLs with a ref and subpath', () => {
    const parsed = parseGithubInput('https://github.com/acme/skills/tree/dev/skills/foo');
    expect(parsed?.ref).toBe('dev');
    expect(parsed?.subpath).toBe('skills/foo');
    expect(parsed?.tarballUrl).toBe(
      'https://codeload.github.com/acme/skills/tar.gz/dev'
    );
  });

  it('does not treat non-GitHub hosts as GitHub', () => {
    expect(parseGithubInput('https://q.hikecapital.com')).toBeNull();
  });
});

describe('standardGithubSource', () => {
  const source = (input: string): string | null => {
    const target = parseGithubInput(input);
    return target ? standardGithubSource(target) : null;
  };

  it('returns owner/repo for the default branch', () => {
    expect(source('vercel-labs/agent-skills')).toBe('vercel-labs/agent-skills');
    expect(source('https://github.com/vercel-labs/agent-skills')).toBe(
      'vercel-labs/agent-skills'
    );
  });

  it('returns a tree URL when a ref is specified', () => {
    expect(source('https://github.com/acme/skills/tree/dev')).toBe(
      'https://github.com/acme/skills/tree/dev'
    );
  });

  it('keeps the subpath with a ref', () => {
    expect(source('https://github.com/acme/skills/tree/dev/skills/foo')).toBe(
      'https://github.com/acme/skills/tree/dev/skills/foo'
    );
  });

  it('returns null for refs containing a slash', () => {
    expect(source('https://github.com/acme/skills/tree/feature%2Ffoo')).toBeNull();
  });
});

describe('classifySource', () => {
  it('classifies HTTP sources', () => {
    expect(classifySource('https://q.hikecapital.com').kind).toBe('http');
  });

  it('classifies GitHub shorthand', () => {
    expect(classifySource('vercel-labs/agent-skills').kind).toBe('github');
  });

  it('strips a .git suffix from GitHub URLs', () => {
    const classified = classifySource('https://github.com/acme/skills.git');
    expect(classified.kind).toBe('github');
    expect(classified.github?.repo).toBe('skills');
  });

  it('rejects non-GitHub git URLs in HTTPS mode', () => {
    expect(() => classifySource('https://gitlab.com/acme/skills.git')).toThrow(
      /git 协议/
    );
  });
});
