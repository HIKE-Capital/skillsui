// Skillsui Electron shell.
//
// Reuses the portable bundle layout: <resources>/node runs
// <resources>/app/server.mjs, with the engine and web assets resolved by the
// server itself relative to the node binary. The window just loads the local
// URL; all app logic stays in the server, exactly like the browser flow.
//
// Quit model: there is no in-app quit button — closing the window is the quit
// gesture. The server refuses quit while jobs are running (409), so the shell
// can confirm; whenever the server goes away on its own, the app follows.
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// SKILLSUI_E2E=1 runs headless for automated checks: no visible window; the
// driver is responsible for killing the app under test. A private userData
// dir keeps the single-instance lock separate from any real instance.
const E2E = process.env.SKILLSUI_E2E === '1';
if (E2E) {
  app.setPath('userData', path.join(os.tmpdir(), 'skillsui-e2e-user-data'));
}

// Packaged apps keep resources in process.resourcesPath; unpackaged runs
// (npx electron main.cjs) use the staged copies next to this file.
const RESOURCES = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, process.platform === 'win32' ? 'resources-win' : 'resources-mac');
const NODE_BIN = path.join(RESOURCES, process.platform === 'win32' ? 'node.exe' : 'node');
const SERVER = path.join(RESOURCES, 'app', 'server.mjs');

let win = null;
let server = null; // the process we spawned; null when we adopted a foreign one
let quitting = false;

function runtimeFile() {
  const home = process.env.SKILLSUI_HOME?.trim() || path.join(os.homedir(), '.skillsui');
  return path.join(home, 'runtime.json');
}

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8'));
  } catch {
    return null;
  }
}

async function serverAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.status < 600; // 200/401/302 all prove a server is listening
  } catch {
    return false;
  }
}

async function tryExisting() {
  const rt = readRuntime();
  if (rt?.port && (await serverAlive(rt.port))) return rt;
  return null;
}

async function resolveServer() {
  // 1. An already-running instance (e.g. from the portable bundle).
  const adopted = await tryExisting();
  if (adopted) return { rt: adopted, adopted: true };

  // 2. Start our own bundled server. The child log aids support diagnostics
  // (server stdout/stderr would otherwise be lost).
  const out = fs.openSync(path.join(os.tmpdir(), 'skillsui-server-child.log'), 'a');
  server = spawn(NODE_BIN, [SERVER], {
    stdio: ['ignore', out, out],
    env: { ...process.env, SKILLSUI_NO_OPEN: '1' },
    windowsHide: true,
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break; // exited (crash, or single-instance guard)
    const rt = readRuntime();
    if (rt?.token && rt.port && (await serverAlive(rt.port))) return { rt, adopted: false };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 3. The server may have exited because another instance owns runtime.json.
  const rt = await tryExisting();
  if (rt) return { rt, adopted: true };
  return null;
}

// Whenever the server goes away on its own, the window's page is dead — close
// the app with it. Owned servers are observed exactly via their exit event;
// adopted ones need a (slow) liveness poll.
function watchServerDeath(rt) {
  if (server) {
    server.on('exit', () => {
      if (!quitting) setTimeout(() => app.quit(), 400);
    });
    if (server.exitCode !== null) {
      // Child already died before we attached; quit right away.
      setTimeout(() => app.quit(), 400);
    }
    return;
  }
  let failures = 0;
  const timer = setInterval(async () => {
    if (quitting) {
      clearInterval(timer);
      return;
    }
    if (await serverAlive(rt.port)) {
      failures = 0;
      return;
    }
    failures += 1;
    if (failures >= 2) {
      clearInterval(timer);
      setTimeout(() => app.quit(), 400);
    }
  }, 5000);
}

function showStartupError() {
  dialog.showErrorBox(
    'Skillsui',
    '本地服务启动失败。请重新打开应用；如果问题持续，删除 ~/.skillsui/runtime.json 后重试。'
  );
}

async function createWindow() {
  const resolved = await resolveServer();
  if (!resolved) {
    showStartupError();
    app.quit();
    return;
  }
  const { rt } = resolved;

  win = new BrowserWindow({
    width: 1280,
    height: 840,
    // Minimums fit the install modal (max-width 780 + 24px backdrop padding
    // per side; the skill list is a 52vh column), and the app now only has
    // the desktop layout — no mobile breakpoint.
    minWidth: 840,
    minHeight: 620,
    title: 'Skillsui',
    backgroundColor: '#f4f4ee',
    show: !E2E,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  // In-app target=_blank links (GitHub repos, source sites) open in the
  // system browser; internal navigation stays in the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${rt.port}`)) return { action: 'allow' };
    setImmediate(() => shell.openExternal(url));
    return { action: 'deny' };
  });
  // Closing the window is the quit gesture. The server owns the jobs policy:
  // it answers 409 with a localized message while jobs are in flight.
  win.on('close', (event) => {
    if (quitting) return;
    // preventDefault must run synchronously — Electron decides on the close
    // as soon as the emit returns, before any await resumes.
    event.preventDefault();
    void (async () => {
      let proceed = true;
      let confirmMessage = null;
      try {
        const res = await fetch(`http://127.0.0.1:${rt.port}/api/quit`, {
          method: 'POST',
          signal: AbortSignal.timeout(1500),
        });
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          confirmMessage = body.message; // localized by the server, which owns the policy
          proceed = false;
        }
      } catch {
        // Server unreachable: nothing to protect, close normally.
      }

      if (!proceed) {
        const choice = await dialog.showMessageBox(win, {
          type: 'warning',
          message: confirmMessage,
          buttons: ['取消', '退出'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response !== 1) return;
      }

      quitting = true;
      win.destroy();
      stopServer();
      app.quit();
    })();
  });

  // Watch server death BEFORE the first navigation: if the child dies early,
  // the app must not become a hidden, unquittable leftover.
  watchServerDeath(rt);
  try {
    await win.loadURL(`http://127.0.0.1:${rt.port}/?token=${rt.token}`);
  } catch {
    if (!quitting) {
      showStartupError();
      app.quit();
    }
  }
}

function stopServer() {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
  server = null;
}

app.setName('Skillsui');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    stopServer();
  });
}
