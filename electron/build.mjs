// Assembles Electron packages for Skillsui (macOS arm64 + Windows x64).
//
// The runtime payload is staged by scripts/lib/stage.mjs — the exact recipe
// the portable bundler uses — and handed to electron-builder via
// per-platform extraResources. Run from anywhere:
//
//   node electron/build.mjs
//
// Requirements: repo was built (dist/), `npm run portable` ran at least once
// (populates .cache/node and .cache/engine), and `npm install` ran in electron/.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NODE_VERSION, copyDir, copyFile, fail, log, run, stageResources } from '../scripts/lib/stage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CACHE = join(ROOT, '.cache');

function ensureIcon() {
  const icon = join(HERE, 'icons', 'icon.png');
  if (existsSync(icon)) return;
  const svg = join(ROOT, 'src', 'web', 'public', 'favicon.svg');
  if (!existsSync(svg)) fail('favicon.svg missing; cannot generate app icon');
  log('generating icons/icon.png from favicon.svg (qlmanage)');
  mkdirSync(join(HERE, 'icons'), { recursive: true });
  const res = spawnSync('qlmanage', ['-t', '-s', '1024', '-o', join(HERE, 'icons'), svg], {
    stdio: 'ignore',
  });
  const generated = join(HERE, 'icons', 'favicon.svg.png');
  if (res.status !== 0 || !existsSync(generated)) {
    fail('qlmanage could not render the icon; place a 1024px icons/icon.png manually');
  }
  renameSync(generated, icon);
}

function stage(target) {
  const isWin = target === 'win';
  const out = join(HERE, isWin ? 'resources-win' : 'resources-mac');
  log(`staging ${out}`);
  rmSync(out, { recursive: true, force: true });

  const nodeBin = isWin
    ? join(CACHE, 'node', `node-v${NODE_VERSION}-win-x64`, 'node.exe')
    : join(CACHE, 'node', `node-v${NODE_VERSION}-darwin-arm64`, 'bin', 'node');
  const nodeLicense = isWin
    ? join(CACHE, 'node', `node-v${NODE_VERSION}-win-x64`, 'LICENSE')
    : join(CACHE, 'node', `node-v${NODE_VERSION}-darwin-arm64`, 'LICENSE');

  stageResources(out, {
    nodeBin,
    nodeLicense,
    engineModules: join(CACHE, 'engine', 'node_modules'),
    target: isWin ? 'windows-x64' : 'macos-arm64',
  });
}

// Shared run(), anchored to electron/ so npm/builder work from any cwd.
function runHere(command, args, options = {}) {
  run(command, args, { cwd: HERE, ...options });
}

ensureIcon();

if (!existsSync(join(HERE, 'node_modules', 'electron', 'dist'))) {
  log('installing electron + electron-builder (first run only)');
  runHere('npm', ['install', '--no-audit', '--no-fund']);
}

if (!existsSync(join(ROOT, 'dist', 'server', 'index.mjs'))) {
  fail('dist/ is missing; run `npm run build` in the repo root first');
}
if (!existsSync(join(CACHE, 'engine', 'node_modules', 'skills', 'bin', 'cli.mjs'))) {
  fail('.cache/engine is missing; run `npm run portable` in the repo root once first');
}

stage('mac');
stage('win');

log('packaging macOS (arm64 dmg)');
runHere('npx', ['electron-builder', '--mac', '--arm64'], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

const macApp = join(HERE, 'release', 'mac-arm64', 'Skillsui.app');
if (existsSync(macApp)) {
  log('ad-hoc signing Skillsui.app');
  runHere('codesign', ['--force', '--deep', '--sign', '-', macApp]);
}

log('packaging Windows (x64 nsis)');
runHere('npx', ['electron-builder', '--win', '--x64']);

log('done — see electron/release/');
