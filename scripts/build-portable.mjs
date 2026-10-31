import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const ROOT = resolve('.');
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
const NODE_VERSION = '24.22.1';
const ENGINE_VERSION = '1.7.4';
const CACHE = join(ROOT, '.cache');
const RELEASE = join(ROOT, 'release');
const NODE_CACHE = join(CACHE, 'node');
const ENGINE_CACHE = join(CACHE, 'engine');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function log(message) {
  console.log(`\n▸ ${message}`);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// Finder/Spotlight can recreate .DS_Store while a release directory is being
// removed, which surfaces as ENOTEMPTY. Retry briefly instead of failing the
// whole portable build.
function removeTree(path) {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 120,
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return;
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`  downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`download failed: ${url} (${response.status})`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

async function ensureNodeAssets() {
  mkdirSync(NODE_CACHE, { recursive: true });
  const sumsPath = join(NODE_CACHE, 'SHASUMS256.txt');
  await download(
    `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
    sumsPath
  );
  const sums = readFileSync(sumsPath, 'utf-8');
  const expected = (file) => {
    const line = sums.split('\n').find((row) => row.endsWith(`  ${file}`));
    return line ? line.split(/\s+/)[0] : null;
  };

  const macFile = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
  const winFile = `node-v${NODE_VERSION}-win-x64.zip`;
  const macArchive = join(NODE_CACHE, macFile);
  const winArchive = join(NODE_CACHE, winFile);
  await download(`https://nodejs.org/dist/v${NODE_VERSION}/${macFile}`, macArchive);
  await download(`https://nodejs.org/dist/v${NODE_VERSION}/${winFile}`, winArchive);

  for (const [file, archive] of [
    [macFile, macArchive],
    [winFile, winArchive],
  ]) {
    const want = expected(file);
    if (!want) fail(`checksum missing for ${file}`);
    if (sha256(archive) !== want) fail(`checksum mismatch for ${file}`);
  }

  const macDir = join(NODE_CACHE, `node-v${NODE_VERSION}-darwin-arm64`);
  const winDir = join(NODE_CACHE, `node-v${NODE_VERSION}-win-x64`);
  if (!existsSync(join(macDir, 'bin', 'node'))) {
    log(`Extracting ${macFile}`);
    run('tar', ['-xzf', macArchive, '-C', NODE_CACHE]);
  }
  if (!existsSync(join(winDir, 'node.exe'))) {
    log(`Extracting ${winFile}`);
    rmSync(winDir, { recursive: true, force: true });
    mkdirSync(NODE_CACHE, { recursive: true });
    new AdmZip(winArchive).extractAllTo(NODE_CACHE, true);
  }
  return {
    macNode: join(macDir, 'bin', 'node'),
    macLicense: join(macDir, 'LICENSE'),
    winNode: join(winDir, 'node.exe'),
    winLicense: join(winDir, 'LICENSE'),
  };
}

function ensureEngine() {
  mkdirSync(ENGINE_CACHE, { recursive: true });
  const pkgPath = join(ENGINE_CACHE, 'package.json');
  const pkg = {
    name: 'skillsui-engine',
    private: true,
    description: 'Bundled skills engine for Skillsui',
    dependencies: { skills: ENGINE_VERSION },
  };
  const serialized = JSON.stringify(pkg, null, 2) + '\n';
  if (!existsSync(pkgPath) || readFileSync(pkgPath, 'utf-8') !== serialized) {
    writeFileSync(pkgPath, serialized, 'utf-8');
  }

  const skillsPkg = join(ENGINE_CACHE, 'node_modules', 'skills', 'package.json');
  let installed = null;
  try {
    installed = JSON.parse(readFileSync(skillsPkg, 'utf-8')).version;
  } catch {
    installed = null;
  }
  if (installed !== ENGINE_VERSION) {
    rmSync(join(ENGINE_CACHE, 'node_modules'), { recursive: true, force: true });
    log(`Installing bundled skills@${ENGINE_VERSION}`);
    run('npm', [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      ENGINE_CACHE,
    ]);
  }
  const cli = join(ENGINE_CACHE, 'node_modules', 'skills', 'bin', 'cli.mjs');
  if (!existsSync(cli)) fail('bundled skills engine is missing bin/cli.mjs');
  return join(ENGINE_CACHE, 'node_modules');
}

function copyDir(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function write(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
  if (mode) chmodSync(file, mode);
}

function readme(target) {
  if (target === 'macos') {
    return `Skillsui v${APP_VERSION} — macOS (Apple Silicon)

启动
  1. 双击 Skillsui.app。
  2. 首次打开如果提示“无法验证开发者”，请右键点击 Skillsui.app → 打开。
  3. 浏览器会自动打开 Skillsui 界面。
  4. 使用完毕后，点击界面左下角的“设置” → “退出 Skillsui”。

说明
  · 所有数据保存在 ~/.skillsui
  · 技能安装到 ~/.agents/skills、~/.claude/skills 等 agent 原生目录
  · 内置 Node ${NODE_VERSION} 与 skills ${ENGINE_VERSION}，不需要另装
  · GitHub 来源使用 HTTPS 下载，只支持公开仓库，不需要安装 Git
  · 不上传任何数据，遥测已关闭

卸载
  退出 Skillsui 后，把 Skillsui.app 移到废纸篓即可。
  已安装的 skill 不会被删除；可以在界面中卸载。

Skillsui v${APP_VERSION} — macOS (Apple Silicon)
  Double-click Skillsui.app. If macOS says the developer cannot be verified,
  right-click the app and choose Open. The browser opens automatically.
  Quit from Settings → Quit Skillsui.
  Data: ~/.skillsui. Bundled Node ${NODE_VERSION} and skills ${ENGINE_VERSION}.
  GitHub sources use HTTPS downloads of public repositories; Git is not required.
`;
  }
  return `Skillsui v${APP_VERSION} — Windows x64

启动
  1. 双击 Skillsui.exe。
  2. 如果 SmartScreen 提示“Windows 已保护你的电脑”，点击“更多信息” → “仍要运行”。
  3. 浏览器会自动打开 Skillsui 界面。
  4. 使用完毕后，点击界面左下角的“设置” → “退出 Skillsui”。

说明
  · 所有数据保存在 %USERPROFILE%\\.skillsui
  · 技能安装到 %USERPROFILE%\\.agents\\skills、%USERPROFILE%\\.claude\\skills 等目录
  · 内置 Node ${NODE_VERSION} 与 skills ${ENGINE_VERSION}，不需要另装
  · GitHub 来源使用 HTTPS 下载，只支持公开仓库，不需要安装 Git
  · 不上传任何数据，遥测已关闭

卸载
  退出 Skillsui 后，删除整个 Skillsui-Windows-x64 文件夹即可。
  已安装的 skill 不会被删除；可以在界面中卸载。

Skillsui v${APP_VERSION} — Windows x64
  Double-click Skillsui.exe. If SmartScreen appears, choose More info → Run anyway.
  The browser opens automatically. Quit from Settings → Quit Skillsui.
  Data: %USERPROFILE%\\.skillsui. Bundled Node ${NODE_VERSION} and skills ${ENGINE_VERSION}.
  GitHub sources use HTTPS downloads of public repositories; Git is not required.
`;
}

function buildInfo(target) {
  return JSON.stringify(
    {
      name: 'Skillsui',
      version: APP_VERSION,
      target,
      node: NODE_VERSION,
      skills: ENGINE_VERSION,
      builtAt: new Date().toISOString(),
    },
    null,
    2
  );
}

function makeIcon() {
  if (process.platform !== 'darwin' || !existsSync(CHROME)) return null;
  const iconDir = join(CACHE, 'icon');
  const png = join(iconDir, 'icon-1024.png');
  const icns = join(iconDir, 'AppIcon.icns');
  if (existsSync(icns)) return icns;

  mkdirSync(iconDir, { recursive: true });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
svg{display:block}
</style></head><body>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="56" y="56" width="912" height="912" rx="214" fill="#1F5C4D"/>
  <rect x="286" y="286" width="360" height="360" rx="76" fill="none" stroke="#F3F5F0" stroke-width="26"/>
  <rect x="430" y="430" width="360" height="360" rx="76" fill="#F3F5F0"/>
</svg>
</body></html>`;
  const htmlPath = join(iconDir, 'icon.html');
  writeFileSync(htmlPath, html, 'utf-8');
  run(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1024,1024',
    '--default-background-color=00000000',
    `--screenshot=${png}`,
    `file://${htmlPath}`,
  ]);

  const iconset = join(iconDir, 'AppIcon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of sizes) {
    run('sips', ['-z', String(size), String(size), png, '--out', join(iconset, name)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  return icns;
}

function buildMac(nodeAssets, engineModules) {
  log('Assembling macOS app');
  const root = join(RELEASE, 'Skillsui-macOS-arm64');
  const app = join(root, 'Skillsui.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  removeTree(root);
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(resources, { recursive: true });

  copyFile(nodeAssets.macNode, join(resources, 'node'));
  chmodSync(join(resources, 'node'), 0o755);
  copyFile(join(ROOT, 'dist', 'server', 'index.mjs'), join(resources, 'app', 'server.mjs'));
  copyDir(join(ROOT, 'dist', 'web'), join(resources, 'app', 'web'));
  copyDir(engineModules, join(resources, 'engine', 'node_modules'));
  rmSync(join(resources, 'engine', 'node_modules', '.bin'), { recursive: true, force: true });
  copyFile(
    join(engineModules, 'skills', 'LICENSE'),
    join(resources, 'licenses', 'skills-LICENSE.txt')
  );
  copyFile(nodeAssets.macLicense, join(resources, 'licenses', 'node-LICENSE.txt'));
  write(join(resources, 'app', 'build.json'), buildInfo('macos-arm64'));

  const icon = makeIcon();
  if (icon) copyFile(icon, join(resources, 'AppIcon.icns'));

  const launcher = join(contents, 'MacOS', 'Skillsui');
  const clang = spawnSync('clang', [
    '-O2',
    '-mmacosx-version-min=12.0',
    '-o',
    launcher,
    join(ROOT, 'scripts', 'launcher', 'macos', 'main.c'),
  ]);
  if (clang.status !== 0) {
    write(
      launcher,
      `#!/bin/sh
set -e
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
export SKILLSUI_ENGINE_DIR="$DIR/engine"
export SKILLSUI_WEB_DIR="$DIR/app/web"
exec "$DIR/node" "$DIR/app/server.mjs"
`,
      0o755
    );
  } else {
    chmodSync(launcher, 0o755);
  }

  write(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Skillsui</string>
  <key>CFBundleDisplayName</key><string>Skillsui</string>
  <key>CFBundleIdentifier</key><string>com.skillsui.app</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundleExecutable</key><string>Skillsui</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
  );
  write(join(root, 'README.txt'), readme('macos'));

  log('Ad-hoc signing macOS app');
  const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], {
    stdio: 'inherit',
  });
  if (sign.status !== 0) {
    console.warn('  ⚠ codesign failed; the app is still usable but Gatekeeper may warn.');
  }

  const zip = join(RELEASE, 'Skillsui-macOS-arm64.zip');
  rmSync(zip, { force: true });
  log('Zipping macOS app');
  run(
    'ditto',
    ['-c', '-k', '--norsrc', '--keepParent', 'Skillsui-macOS-arm64', 'Skillsui-macOS-arm64.zip'],
    { cwd: RELEASE }
  );
  return { root, zip };
}

function buildWindows(nodeAssets, engineModules) {
  log('Assembling Windows app');
  const root = join(RELEASE, 'Skillsui-Windows-x64');
  removeTree(root);
  mkdirSync(root, { recursive: true });

  copyFile(nodeAssets.winNode, join(root, 'node.exe'));
  copyFile(join(ROOT, 'dist', 'server', 'index.mjs'), join(root, 'app', 'server.mjs'));
  copyDir(join(ROOT, 'dist', 'web'), join(root, 'app', 'web'));
  copyDir(engineModules, join(root, 'engine', 'node_modules'));
  rmSync(join(root, 'engine', 'node_modules', '.bin'), { recursive: true, force: true });
  copyFile(
    join(engineModules, 'skills', 'LICENSE'),
    join(root, 'licenses', 'skills-LICENSE.txt')
  );
  copyFile(nodeAssets.winLicense, join(root, 'licenses', 'node-LICENSE.txt'));
  write(join(root, 'app', 'build.json'), buildInfo('windows-x64'));
  write(join(root, 'README.txt'), readme('windows'));

  const go = spawnSync('go', ['version'], { stdio: 'pipe' });
  if (go.status !== 0) {
    fail(
      'Go is required to build the Windows launcher. Install it with `brew install go` (macOS) and retry.'
    );
  }
  log('Building Windows launcher');
  run('go', [
    'build',
    '-trimpath',
    '-ldflags',
    '-s -w -H windowsgui',
    '-o',
    join(root, 'Skillsui.exe'),
    join('scripts', 'launcher', 'windows', 'main.go'),
  ], {
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  });

  const zip = join(RELEASE, 'Skillsui-Windows-x64.zip');
  rmSync(zip, { force: true });
  log('Zipping Windows app');
  run(
    'ditto',
    ['-c', '-k', '--norsrc', '--keepParent', 'Skillsui-Windows-x64', 'Skillsui-Windows-x64.zip'],
    { cwd: RELEASE }
  );
  return { root, zip };
}

async function main() {
  console.log(`Skillsui portable build v${APP_VERSION}`);
  mkdirSync(RELEASE, { recursive: true });

  log('Building server and web assets');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);

  if (!existsSync(join(ROOT, 'dist', 'server', 'index.mjs'))) {
    fail('dist/server/index.mjs is missing');
  }
  if (!existsSync(join(ROOT, 'dist', 'web', 'index.html'))) {
    fail('dist/web/index.html is missing');
  }

  log('Preparing Node runtime');
  const nodeAssets = await ensureNodeAssets();
  log('Preparing skills engine');
  const engineModules = ensureEngine();

  const mac = buildMac(nodeAssets, engineModules);
  const win = buildWindows(nodeAssets, engineModules);

  log('Writing SHA256SUMS.txt');
  const sums = [mac.zip, win.zip]
    .map((file) => {
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
      return `${hash}  release/${file.slice(RELEASE.length + 1)}`;
    })
    .join('\n');
  writeFileSync(join(RELEASE, 'SHA256SUMS.txt'), `${sums}\n`);

  const size = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
  console.log('\n✓ Portable builds ready');
  console.log(`  ${mac.zip} (${size(mac.zip)})`);
  console.log(`  ${win.zip} (${size(win.zip)})`);
  console.log(`  Unpacked: ${mac.root}`);
  console.log(`            ${win.root}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
