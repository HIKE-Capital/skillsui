# Skillsui

一个面向非命令行用户的本地图形界面，用来管理 AI agent 的 skills：安装、卸载、更新、查看已安装内容，并区分**全局**与**项目**作用域，同时正确处理一台电脑上的多个 agent。

界面中英双语可切换，默认跟随系统语言。

## 交付物

便携包（推荐给最终用户）：

- `release/Skillsui-macOS-arm64.zip` — macOS Apple Silicon，`.app`，内置 Node 与 skills 引擎
- `release/Skillsui-Windows-x64.zip` — Windows x64，`Skillsui.exe`，内置 Node 与 skills 引擎

解压后按包内 `README.txt` 操作即可，**不需要安装 Node 或 npm**。Git 是可选的：检测到 Git 时，GitHub 来源会走官方标准流程（写入官方锁，可由 `npx skills` 更新）；没有 Git 时自动使用免 Git 的直链模式。

## 功能

- 从任意来源安装 skill：
  - 标准 well-known 来源，例如 `https://q.hikecapital.com`
  - GitHub 公开仓库，例如 `op7418/Humanizer-zh` 或 GitHub 仓库 URL
  - 直接 SKILL.md / zip / tar 下载地址
- 多 agent 选择：自动探测本机 agent，支持 79 个 agent 路径
- 全局 / 多项目库分别管理，项目路径可保存、切换
- 单个更新、全部更新
- 卸载 skill，并清理官方锁文件与 Skillsui 元数据
- 中英双语、浅色界面、键盘可访问、支持减少动态效果

## 关键设计

- **不重写安装逻辑**：捆绑官方 [`skills`](https://github.com/vercel-labs/skills) `1.7.4`，安装/卸载/更新通过它执行，行为与 CLI 保持一致。
- **GitHub 双模式**：检测到 Git 时用 `owner/repo` 让官方 CLI 走 `git clone`，写入官方锁文件，`npx skills check/update` 可以直接管理；没有 Git（或设置里选了“始终直链”）时回退到 `codeload.github.com/.../tar.gz`，由 Skillsui 记录来源与 ETag。标准模式失败时也会自动回退直链，避免“有 Git 反而更容易失败”。
- **官方锁文件只读**：项目 `skills-lock.json`、全局 `~/.agents/.skill-lock.json` 由官方 CLI 维护，Skillsui 不直接改写。
- **直链模式元数据**：官方 CLI 对直链下载不写锁文件，因此 Skillsui 在 `~/.skillsui/github-installs.json` 记录来源、ETag、agent、scope，用于更新与卸载。标准模式成功后，同一 skill 的旧记录会被删除，以官方锁为准。
- **本地优先**：服务只监听 `127.0.0.1`，随机端口 + 随机 token + HttpOnly cookie；遥测关闭；不执行 skill 内容。

## 开发

要求 Node.js >= 22.20。

```bash
npm install
npm run dev        # Vite: http://localhost:5173, API: 127.0.0.1:4317
npm test
npm run typecheck
```

生产构建：

```bash
npm run build      # dist/server/index.mjs + dist/web
npm start          # 启动本地服务并打开浏览器
```

## 构建便携包

```bash
npm run portable
```

会依次：

1. 构建前端与服务端
2. 下载并校验 Node v24.22.1（macOS arm64 / Windows x64）
3. 安装内置 `skills@1.7.4`
4. 组装 `Skillsui.app`（macOS）与 `Skillsui-Windows-x64`（Windows）
5. 对 macOS `.app` 做 ad-hoc 签名
6. 输出 zip 到 `release/`

Windows 启动器需要 Go（`brew install go`）交叉编译；macOS 启动器使用系统 clang。

## 环境变量（调试用）

| 变量 | 作用 |
|---|---|
| `SKILLSUI_HOME` | 覆盖 `~/.skillsui` 数据目录 |
| `SKILLSUI_ENGINE_DIR` | 指定内置 skills 引擎目录 |
| `SKILLSUI_WEB_DIR` | 指定前端静态资源目录 |
| `SKILLSUI_NO_OPEN` | 设为 `1` 时不自动打开浏览器 |
| `SKILLSUI_DEV` | 设为 `1` 时进入开发模式（禁用本地 token） |
| `SKILLSUI_GIT` | 指定 Git 可执行文件路径（优先于自动探测；调试用） |

## 已知限制

- **GitHub 只支持公开仓库**。私有仓库需要 Git 凭据/Token，v1 不支持；界面会提示。
- **GitLab / Azure / 任意 git URL** 不在 v1 范围内。
- **直链模式的 GitHub 安装不会写入官方 `skills-lock.json`**，由 Skillsui 的元数据管理；`npx skills list` 会显示 `Source: local`。标准模式没有这个限制。模式自动选择，不需要配置。
- macOS 使用 ad-hoc 签名，首次打开从网络下载的包需要右键 →“打开”；没有付费 Developer ID 公证。
- Windows 包未签名，SmartScreen 会提示“更多信息 → 仍要运行”。
- Windows 构建已在 macOS 上交叉编译并通过文件/结构检查，但真实安装/更新/卸载仍需在 Windows 上验收。

## 目录

```
src/server/            本地服务、技能引擎适配、来源解析、任务队列
src/web/               React 界面
src/shared/            前后端共享类型
scripts/               开发、构建、便携打包、启动器
tests/                 解析器与来源分类单元测试
release/               便携包产物
```

## 第三方

- [`skills`](https://github.com/vercel-labs/skills) — MIT，Skillsui 捆绑其 CLI 作为执行引擎。
- Agent 路径表派生自 `skills` 的 `src/agents.ts`（MIT），许可证文本见 `THIRD_PARTY_LICENSES/skills-LICENSE.txt`。
- Node.js — 其许可证随便携包一起分发在 `licenses/` 中。
