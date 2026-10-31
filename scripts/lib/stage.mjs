// Shared staging recipe for both bundlers (portable + Electron). The staged
// layout — node binary, app/server.mjs, app/web, engine/node_modules,
// licenses, app/build.json — is what src/server/paths.ts resolves at runtime,
// so every packager must produce it through this one function.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  cpSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const NODE_VERSION = '24.22.1';

const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function log(message) {
  console.log(`\n▸ ${message}`);
}

export function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
}

export function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

export function copyDir(src, dest) {
  if (!existsSync(src)) fail(`missing directory: ${src}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

export function copyFile(src, dest, mode) {
  if (!existsSync(src)) fail(`missing file: ${src}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  if (mode) chmodSync(dest, mode);
}

export function write(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
  if (mode) chmodSync(file, mode);
}

function appVersion() {
  return JSON.parse(readFileSync(join(LIB_ROOT, 'package.json'), 'utf-8')).version;
}

function skillsVersion(engineModules) {
  try {
    return JSON.parse(
      readFileSync(join(engineModules, 'skills', 'package.json'), 'utf-8')
    ).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Stage the shared runtime payload into `dest`.
 * options.nodeBin / nodeLicense come from the platform Node runtime;
 * options.engineModules is the prepared engine's node_modules tree;
 * options.target names the build for app/build.json.
 */
export function stageResources(dest, { nodeBin, nodeLicense, engineModules, target }) {
  if (!existsSync(join(engineModules, 'skills', 'bin', 'cli.mjs'))) {
    fail('bundled skills engine is missing bin/cli.mjs');
  }
  copyFile(nodeBin, join(dest, target === 'macos-arm64' ? 'node' : 'node.exe'), 0o755);
  copyFile(join(LIB_ROOT, 'dist', 'server', 'index.mjs'), join(dest, 'app', 'server.mjs'));
  copyDir(join(LIB_ROOT, 'dist', 'web'), join(dest, 'app', 'web'));
  copyDir(engineModules, join(dest, 'engine', 'node_modules'));
  rmSync(join(dest, 'engine', 'node_modules', '.bin'), { recursive: true, force: true });
  copyFile(
    join(engineModules, 'skills', 'LICENSE'),
    join(dest, 'licenses', 'skills-LICENSE.txt')
  );
  if (nodeLicense) copyFile(nodeLicense, join(dest, 'licenses', 'node-LICENSE.txt'));
  write(
    join(dest, 'app', 'build.json'),
    JSON.stringify(
      {
        name: 'Skillsui',
        version: appVersion(),
        target,
        node: NODE_VERSION,
        skills: skillsVersion(engineModules),
        builtAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}
