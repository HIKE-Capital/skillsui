import { build as viteBuild } from 'vite';
import { spawnSync } from 'node:child_process';

console.log('Building web assets…');
await viteBuild({ configFile: 'vite.config.ts' });

console.log('Building server bundle…');
const result = spawnSync(process.execPath, ['scripts/build-server.mjs'], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('Build complete.');
