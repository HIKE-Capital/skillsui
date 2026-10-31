import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist/server', { recursive: true });

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.mjs',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: true,
  sourcemap: true,
  packages: 'bundle',
  legalComments: 'none',
  banner: {
    js: [
      "import { createRequire as __skillsuiCreateRequire } from 'node:module';",
      "const require = __skillsuiCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
});
