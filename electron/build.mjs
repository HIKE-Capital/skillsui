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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

// macOS: electron-builder writes extraResources AFTER its (skipped) signing
// pass, which leaves a broken seal — Gatekeeper reports the app as damaged
// once quarantined. Re-ad-hoc-sign in dependency order (nested frameworks →
// helper apps → outer bundle), then build the DMG from the signed app.
// Do NOT use codesign --deep here: re-sealing Electron's versioned frameworks
// through it produces an invalid seal again.
log('packaging macOS app (dir)');
runHere('npx', ['electron-builder', '--mac', '--dir', '--arm64'], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

const macApp = join(HERE, 'release', 'mac-arm64', 'Skillsui.app');
log('ad-hoc signing Skillsui.app (nested code first)');
const frameworksDir = join(macApp, 'Contents', 'Frameworks');
for (const entry of readdirSync(frameworksDir)) {
  if (entry.endsWith('.framework')) {
    runHere('codesign', ['--force', '--sign', '-', join(frameworksDir, entry)]);
  }
}
for (const entry of readdirSync(frameworksDir)) {
  if (entry.endsWith('.app')) {
    runHere('codesign', ['--force', '--sign', '-', join(frameworksDir, entry)]);
  }
}
runHere('codesign', ['--force', '--sign', '-', macApp]);
runHere('codesign', ['--verify', '--deep', macApp]);

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const dmg = join(HERE, 'release', `Skillsui-${pkg.version}-arm64.dmg`);
log(`building ${basename(dmg)} from the signed app`);
const dmgStage = join(HERE, 'release', 'dmg-stage');
rmSync(dmgStage, { recursive: true, force: true });
mkdirSync(dmgStage, { recursive: true });
// ditto, not cp: it preserves the framework-root symlinks. Node's cpSync
// dereferences directory symlinks, which breaks the framework seal and
// Gatekeeper then reports the app as damaged.
runHere('ditto', [macApp, join(dmgStage, 'Skillsui.app')]);
symlinkSync('/Applications', join(dmgStage, 'Applications'));
runHere('hdiutil', [
  'create', '-volname', 'Skillsui', '-srcfolder', dmgStage,
  '-format', 'UDZO', '-ov', dmg,
]);
rmSync(dmgStage, { recursive: true, force: true });

log('packaging Windows (x64 nsis)');
runHere('npx', ['electron-builder', '--win', '--x64']);

log('done — see electron/release/');
