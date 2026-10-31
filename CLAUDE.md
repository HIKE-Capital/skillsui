# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install

# Development: tsx API on 127.0.0.1:4317 (SKILLSUI_DEV=1, auth disabled)
# + Vite on localhost:5173, proxying /api to the API.
# The dev API does NOT hot-reload: restart `npm run dev` after server-side changes.
npm run dev

npm run typecheck
npm test

# There is no lint script; `npm run typecheck` is the static check.
# One test file / one test
npx vitest run --config vitest.config.ts tests/parsers.test.ts
npx vitest run --config vitest.config.ts tests/parsers.test.ts -t "parses names"

# Production build: dist/web + bundled dist/server/index.mjs
npm run build
npm start

# Partial builds
npm run build:web
npm run build:server

# Portable bundles: release/Skillsui-macOS-arm64.zip and release/Skillsui-Windows-x64.zip
npm run portable

# Electron packages: electron/release/ (DMG arm64 + Setup.exe x64)
node electron/build.mjs
# Shell-logic iteration without packaging: `npx electron main.cjs` (uses the staged resources-mac/)

# Verify the ad-hoc-signed macOS bundle
codesign --verify --deep --strict release/Skillsui-macOS-arm64/Skillsui.app

# Verify the shipped DMG seal: mount it, then deep-verify the app inside
hdiutil attach electron/release/Skillsui-<v>-arm64.dmg -mountpoint /tmp/m -nobrowse && codesign --verify --deep --strict /tmp/m/Skillsui.app && hdiutil detach /tmp/m

# Release: stage version-less copies (Skillsui-macOS.dmg, Skillsui-Windows-Setup.exe, SHA256SUMS.txt), then
gh release upload vX.Y.Z --clobber <assets> && gh release edit vX.Y.Z --draft=false

# Run without opening a browser (useful for API/acceptance tests)
SKILLSUI_HOME=/tmp/skillsui-test SKILLSUI_NO_OPEN=1 node dist/server/index.mjs
# Port/token are then in /tmp/skillsui-test/runtime.json
```

`npm run portable` runs `npm run build`, downloads Node 24.22.1 with SHA-256 verification, stages `skills@1.7.4` under `.cache/engine`, and assembles both platforms. It needs `clang` for the macOS launcher and Go (`brew install go`) for the Windows launcher. Build artifacts go to `release/`; the Node/engine cache is `.cache/`.

## Architecture

Skillsui is a **local web GUI that wraps the official `skills` CLI**, packaged as a portable app. The browser talks to a Fastify server on loopback; the server spawns the bundled CLI for every install/remove/update. Do not reimplement install logic — the CLI is the source of truth.

```
Browser -> Fastify /api -> serial job queue -> skills CLI -> agent skill dirs + official lock files
                                        \-> ~/.skillsui/github-installs.json (GitHub HTTPS installs)
```

### Process and request lifecycle

- `src/server/index.ts` is the entry point. It enforces a single instance through `~/.skillsui/runtime.json`, picks a random loopback port and random token, opens the browser, and logs to `~/.skillsui/logs/server.log`.
- `src/server/app.ts` owns token/cookie auth (`/?token=...` sets `skillsui_session`, then redirects), same-host Origin checks, the API routes, and a **custom static handler** (`serveWeb`) with a path-traversal guard. `@fastify/static` was deliberately removed; do not reintroduce it without checking the advisory history.
- Long-running mutations (`install`, `remove`, `update`) are serialized through `src/server/engine/jobs.ts`. Jobs stream over SSE (`/api/jobs/:id/events`), cap in-memory logs at 5000 lines, and persist finished logs under `~/.skillsui/logs/`.
- The frontend (`src/web/App.tsx`) is a thin orchestrator over `src/web/api.ts`: bootstrap, scope switching, skill list, install sheet, job sheet. Jobs continue if the sheet is closed.

### Engine adapter (`src/server/engine/`)

- `cli.ts` spawns `process.execPath <engine>/bin/cli.mjs`. It strips agent-environment variables, sets `DISABLE_TELEMETRY=1`, `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`, raises download/extract limits, strips ANSI/carriage-return spinners, and supports cancellation/timeouts.
- `agents.ts` is a vendored copy of the upstream agent table (72 entries — astrbot, eve, gemini-cli, openclaw, warp, zencoder, zenflow are removed locally; see the header note in the file) plus detection. The table is UI-side only (detection/display): every mutation goes through the skills CLI, which validates agent keys against its own table and rejects unknown ones. `agent-service.ts` maps it to UI `AgentInfo` and enforces global-support rules. When upgrading `skills`, re-sync this file from upstream and re-apply the local removals.
- `git.ts` probes for a usable Git binary (`SKILLSUI_GIT`, PATH, Homebrew/MacPorts paths, Git for Windows/MinGit locations) and prepends its directories to PATH for every CLI child process. On macOS it never probes `/usr/bin/git` before `xcode-select -p` succeeds, because the shim opens the Command Line Tools installer. Results are cached for 60s.
- `icons.ts` serves row icons via `/api/icons/github/:owner` (owner avatar from `github.com/<owner>.png`) and `/api/icons/site/:host` (favicon chain: `/favicon.ico`, then `<link rel*=icon>` parsing of the `SOURCE_LANDING_PAGES` page and the site root, including `data:` URLs). Results are cached under `~/.skillsui/icons/` (30-day positive / 24h negative TTL) with in-flight dedupe; a successful install calls `invalidateIconForSource()` to drop that source's entry so the next render refetches; failures return 404 and the UI falls back to letter marks. Responses use `Cache-Control: private, no-cache` + a content-hash ETag, so the browser revalidates every render (304 when unchanged) and picks up refreshed icons immediately. Only the source's own host is contacted — no third-party icon services.
- `sources.ts` classifies input as well-known, GitHub, or direct HTTP. It fetches `/.well-known/agent-skills/index.json` natively, builds both the standard `owner/repo` source (`standardGithubSource`) and the `codeload.github.com/<owner>/<repo>/tar.gz/<ref>` fallback, and parses the CLI's human-readable `add --list` output for GitHub/direct sources; skill lines are recognized as kebab-case slugs — group headers from nested repos (e.g. anthropics/skills) become `SourceSkill.group` for sticky section labels in the install picker. Parsing is pinned to `skills@1.7.4` output.
- `operations.ts` performs mutations through `runCli` (`add`, `remove`, `update`) and handles the two tracking models below. GitHub installs use the standard flow when Git is available and `config.githubMode` is not `direct`; Git-specific failures retry once with the tarball URL, and standard updates delete the stale Skillsui record so the official lock takes over.
- `list.ts` reads `skills list --json`, overlays `github-installs.json`, reads descriptions from each installed `SKILL.md`, and adds global lock timestamps.

### Two kinds of installs (important)

1. **CLI-managed** — well-known sources (e.g. `https://q.hikecapital.com`), GitHub sources installed through `owner/repo` when Git is available, and anything else that causes the CLI to write a lock. The official CLI writes `skills-lock.json` / `~/.agents/.skill-lock.json`; `check`/`update` handle updates. Local paths are intentionally not exposed by the UI.
2. **Skillsui-managed** — GitHub tarball downloads (Git unavailable, `githubMode = direct`, or a successful fallback) and direct HTTP downloads. The CLI treats these as `directDownload` and **does not write a lock file**. Skillsui records repo/ref/url/ETag/agents/scope in `~/.skillsui/github-installs.json` and updates them via `HEAD` + re-`add`. `InstalledSkill.managedBy` drives the UI, update path, and metadata cleanup.

`list.ts` gives the official lock precedence: a skill with a lock `source` is always `managedBy: cli`, even if a stale Skillsui record exists. `~/.skillsui/config.json` holds a hidden `githubMode: 'auto' | 'direct'` (no UI toggle; default `auto`); `auto` uses Git only when it was actually detected.

Do not write the official lock files directly. They are owned by the CLI.

UI state lives in `~/.skillsui/config.json` (locale, recent projects, active project, last agents); GitHub tracking lives in `~/.skillsui/github-installs.json`. `runtime.json` and `logs/` are transient.

### Scopes and agent directories

- Project: `<project>/<agent>/skills`, with `.agents/skills` canonical for universal agents; lock at `<project>/skills-lock.json`.
- Global: `~/.agents/skills` and `~/<agent>/skills`; lock at `~/.agents/.skill-lock.json`.
- Universal agents share the canonical `.agents/skills` even if their `globalSkillsDir` differs; dedicated agents get a symlink (or copy fallback). The install sheet's directory count and shared-path display rely on this distinction.

### Portable packaging (`scripts/`)

- `build-portable.mjs` (using the shared staging recipe `scripts/lib/stage.mjs`, also used by the Electron build) downloads Node 24.22.1, stages the engine, assembles `Skillsui.app` and `Skillsui-Windows-x64`, removes npm's `node_modules/.bin` absolute symlinks (they break macOS code signing), ad-hoc signs the `.app`, and zips with `ditto`.
- `scripts/launcher/macos/main.c` is a Mach-O launcher: it sets `SKILLSUI_ENGINE_DIR`/`SKILLSUI_WEB_DIR` and `exec`s the bundled Node. `scripts/launcher/windows/main.go` starts Node detached/hidden and exits.
- `src/server/paths.ts` resolves the engine/web assets in this order: explicit `SKILLSUI_ENGINE_DIR`/`SKILLSUI_WEB_DIR`, then `<dirname(process.execPath)>/engine` and `/app/web`, then development paths (`node_modules/skills`, `dist/web`).

### Desktop shell (`electron/`)

- `electron/main.cjs` is an Electron wrapper over the same staged layout: it spawns the bundled Node + server, shows a window on the local URL, and quits when the window closes. There is **no in-app quit button** — closing the window is the quit gesture, in both the desktop shell and the browser (a tab is just closed). `POST /api/quit` remains, used by the shell's window-close flow; it answers 409 with a localized message while jobs are running so the shell can confirm.
- `electron/build.mjs` stages the same payload as `build-portable.mjs` (via `scripts/lib/stage.mjs`) and runs electron-builder: DMG (macOS arm64) + NSIS (Windows x64) into `electron/release/`. Iterate without packaging by staging + `npx electron main.cjs`; package only at milestones. electron-builder writes extraResources after its (skipped) signing pass, so the script re-ad-hoc-signs afterwards in dependency order — nested frameworks → helper apps → outer bundle, never `--deep` — and stages the DMG with `ditto`: `fs.cpSync` dereferences the framework-root symlinks and quarantined copies then report as damaged.
- `SKILLSUI_E2E=1` runs the shell headless (hidden window, private userData) for automated checks; the driver kills the app under test.

### Product constraints

- `skills` is pinned to **1.7.4**; parsing is output-sensitive. Re-run tests and re-check `agents.ts` when upgrading.
- Node requirement is **>= 22.20**; portable bundles use 24.22.1.
- GitHub mode is **public repositories only**. With Git it uses the official clone flow; without Git it falls back to HTTPS tarballs and is app-managed. GitLab, Azure, and arbitrary git URLs are out of scope.
- The UI is intentionally core-only: install, remove, update, list, multi-agent, global/project, multi-project. No `find`, `init`, `sync`, or SKILL.md preview.
- The product name is **Skillsui** (UI not capitalized). The UI is desktop-only — the mobile responsive layout was removed; the Electron window floors at 840×620 (sized to the install modal). There is no in-app quit button anywhere: closing the window/tab is the quit gesture.
- The topbar exposes a single **全部更新** action; every installed row has an icon-only **更新** button, and each source group header has a delete-all button plus a link to the source site (GitHub repo or domain, with hardcoded landing pages for a couple of hosts in `src/shared/sourcePages.ts`). There is no "check for updates" feature: `skills@1.7.4` routes `check` to the same `runUpdate()` as `update`, so a "check" button would install updates — `/api/check-updates` and the check code were removed for this reason. Row action buttons are hover-only.
- Job dialogs: terminal states show only the summary block (the status pill is for queued/running); remove confirmations are warning-only — no agent chips, skill lists, or paths.
- UI is bilingual (`zh-CN` default via system locale, English toggle); server error strings are Chinese. Row icons come from the server-side icon cache; the browser never fetches source hosts directly.
- Loopback-only, token-authenticated, no telemetry. Never use `--agent '*'`; pass explicit agent keys.
- The macOS bundle is ad-hoc signed (Gatekeeper: on macOS Sequoia 15+ users must approve via System Settings → Privacy & Security → Open Anyway; the right-click → Open bypass only applies to Sonoma 14 and earlier); Windows is unsigned. The Windows package has been cross-compiled and structurally checked but not run on a real Windows machine.

## Testing

- Unit tests live in `tests/` and currently cover source classification and the `add --list` parser. `vitest.config.ts` deliberately points at the repo root (the Vite root is `src/web`).
- End-to-end acceptance is manual: run the built server with a temporary `SKILLSUI_HOME`, read `runtime.json` for the port/token, exercise install/update/remove, and quit via `POST /api/quit`. For global-write tests, also override `HOME` to a temp directory and create `.claude`/`.codex` so detection has something to find.
- To verify standard GitHub installs, check that `<project>/skills-lock.json` gained an entry and `github-installs.json` stayed empty; `npx skills check` should see it. Force direct mode with `githubMode: direct` in the temp config, or point `SKILLSUI_GIT` at a fake Git that fails clone to exercise the automatic fallback.
- The portable macOS bundle can be verified with `codesign --verify --deep --strict`; launch it with `SKILLSUI_NO_OPEN=1` and probe `/api/health`.
- There is no CI configuration in this repository.

## Known limitations

- GitHub installs in **direct/fallback mode** do not appear in the official `skills-lock.json`; `npx skills list` shows `Source: local`. Standard-mode installs are normal lock entries.
- Private GitHub repositories require Git/tokens and are unsupported in v1.
- The Windows build needs real-device acceptance: SmartScreen, browser launch, symlink fallback, and server start/stop lifecycle.
- See `README.md` for user-facing setup.
