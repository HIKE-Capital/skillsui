import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const env = { ...process.env, SKILLSUI_DEV: '1' };
const children = [];

function run(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...env, ...extraEnv },
    windowsHide: false,
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`);
    }
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(code), 200);
}

const tsxCli = 'node_modules/tsx/dist/cli.mjs';
const viteCli = 'node_modules/vite/bin/vite.js';

if (!existsSync(tsxCli) || !existsSync(viteCli)) {
  console.error('Dependencies are missing. Run `npm install` first.');
  process.exit(1);
}

run('api', process.execPath, [tsxCli, 'src/server/index.ts', '--dev', '--no-open']);
run('web', process.execPath, [viteCli]);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\nSkillsui dev');
console.log('  Web: http://localhost:5173');
console.log('  API: http://127.0.0.1:4317 (auth disabled in dev)\n');
