# agy-swarm-pi (`swarm-pi`)

[English](README.md) · 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 **Google Antigravity** 中通过 `/swarm_pi` 直接并发调度 **Pi** 或 **Codex** 执行编码、审查与调研任务。先在设置中选择一个执行器，再通过 **Pi Swarm** 共享消息板查看进度与追加指令。

## 特性

- **Antigravity 原生子代理**。轻量转发代理通过 `swarm-pi_pi` 派发和跟踪任务，在 Antigravity 原生 Subagents 界面中可见，任务结束后自动唤醒协调器。实际工作由 Pi 或 Codex 执行。
- **Git Worktree 隔离**。`pi_submit_task(..., worktree: true)` 为并发写入创建独立 worktree 和 `swarm-pi/*` 分支。任务完成后可查看变更并清理工作树。
- **共享消息板和角色设置**。在 Pi Swarm 面板选择成员的 Subagent 卡片，可查看该成员的职责说明，以及最近任务的状态、耗时、工具调用、模型、工作树和日志路径等可用信息。可为 `coder`、`verifier`、`researcher` 等角色配置模型、推理档位和超时。Pi 可配置工具白名单，Codex 可配置沙箱。
- **预构建安装包**。仓库和 Release 包包含 MCP 服务、面板与原生子代理定义。Antigravity 直接通过 Node.js 启动服务。

---

## 前置要求

请确保 Antigravity 的 `PATH` 可以找到 Node.js 20 或更新版本。安装所选的 CLI 并配置对应认证。使用 Pi 时，需配置模型提供方凭证。

```bash
npm install -g @mariozechner/pi-coding-agent
```

使用 Codex 时，插件复用 CLI 已保存的登录状态。模型字段留空时，使用 Codex CLI 的模型配置。

```bash
npm install -g @openai/codex
codex login
```

---

## 快速安装

### 方式一：从 GitHub Release 下载零依赖安装包

从 [GitHub Releases](https://github.com/KLOSYX/agy-swarm-pi/releases) 下载对应版本的安装包。以下以 v0.4.0 为例。

```bash
curl -fsSLO https://github.com/KLOSYX/agy-swarm-pi/releases/download/v0.4.0/swarm-pi-v0.4.0.tar.gz
tar -xzf swarm-pi-v0.4.0.tar.gz
./swarm-pi/install.sh
```

仅安装到某个项目工作区（`<repo>/.agents/plugins/swarm-pi`）：

```bash
./swarm-pi/install.sh --workspace /path/to/your/repo
```

### 方式二：直接 `git clone` 安装

```bash
git clone https://github.com/KLOSYX/agy-swarm-pi.git
./agy-swarm-pi/install.sh
```

或使用 Antigravity CLI：

```bash
agy plugin install ./agy-swarm-pi
```

在 Windows 上可在 PowerShell 中运行上面的 Antigravity CLI 安装命令。如果升级时提示插件文件被占用，退出 Antigravity 后重试。v0.4.0 起，MCP 服务由 `node` 直接启动。升级后如果侧边栏还没有入口，刷新 `swarm-pi_pi` 或重启 Antigravity，并确认同一环境可以运行 `node --version`。

卸载：

```bash
~/.gemini/config/plugins/swarm-pi/install.sh --uninstall
```

---

## 使用说明

1. 安装完成后，如客户端已打开，请在右上角 `... > MCP Servers` 刷新 `swarm-pi_pi`（或重启 Antigravity 窗口）。
2. 在 Antigravity 侧边栏或对话右上角 `+` 菜单打开 **Pi Swarm**。在 **Language** 中可选择 **简体中文**。进入 **模型与角色设置**，在 **当前执行器** 中选 **Pi** 或 **Codex** 后保存。初始选项为 Pi。Codex 默认使用只读沙箱，内置 `coder` 角色可写入工作区。
3. 在对话中输入 `/swarm_pi <你的任务>`，协调器创建消息板、添加命名成员并派发任务。在 **Pi Swarm > 共享消息板** 选择成员并发送追加指令。空闲成员接着原会话处理，工作中的成员依次处理排队消息。

成员通过最终回复中的 `SWARM_POST @成员 消息` 交接。切换执行器前，请先等待任务完成或取消任务。旧看板可继续查看，切回原执行器后可继续发消息。

消息板和队列随 MCP 进程存活。插件数据目录保留任务日志、Pi 会话文件和 Codex 会话 ID。Codex 会话正文由其 CLI 保存。Codex 的 JSONL 输出未上报实际模型，面板会单独显示配置模型。

### 从面板更新

在**设置 → 插件更新**点击**检查更新**，对比运行版本与 GitHub 最新稳定版。通过发行包安装的插件可点击**安装更新**并确认。安装会验证发布包的 SHA-256，并保留旧插件目录的备份。有运行或排队任务时，面板会阻止安装。

安装后请在 Antigravity 中手动重载插件。重载会清除打开的看板。插件目录以外的设置和会话数据会保留。从 Git 克隆运行的插件请通过 Git 更新。

### Antigravity 原生子代理模式（推荐）

`/swarm_pi` 默认通过 `invoke_subagent` 以 `Model="flash_lite"` 为每个可执行的任务启动随插件提供的 `swarm-pi-worker`。协调器启动后结束主对话当前轮次。转发代理通过 `swarm-pi_pi` 跟踪 Pi 或 Codex 任务，在 Antigravity 原生 **Subagents** 列表和聊天中可见。任务完成时，Antigravity 会用完成报告唤醒协调器，主对话无需轮询。转发代理的派发、等待和汇报会消耗宿主模型 token。实际实现和验证由 Pi 或 Codex 执行。[Antigravity 原生子代理文档](https://antigravity.google/docs/subagents/#subagent-lifecycle-and-states)

### MCP 直连消息板模式（备用）

如果希望省去宿主转发代理的轮次，可以在 `/swarm_pi` 请求中指定 MCP 直连消息板模式。协调器直接通过 `swarm-pi_pi` 派发和读取消息。两种模式都可以在 Pi Swarm 侧边面板查看原生风格的 Subagent 卡片和成员详情。

如需按事件自动跟进，在 Antigravity 的 `~/.gemini/config/config.json` 中合并以下配置，并在启动新蜂群前重新加载 Antigravity。

```json
{"sidecars": {"swarm-pi/coordinator": {"enabled": true}}}
```

协调器通过 `pi_swarm_watch` 订阅原看板，派工后结束当前回合。发给协调器的消息、成员报错或队列全部执行完毕时，Sidecar 会唤醒原会话。原生转发代理失败时，可在同一看板开启订阅，只补发缺失的任务。[Antigravity Sidecar 文档](https://antigravity.google/docs/sidecars/#agentapi)

---

## 本地开发与打包

```bash
npm install
npm run build      # 重新打包 ui/dist/settings.html 与 bin/server.bundle.mjs
npm test           # 运行单元测试与集成测试
npm run pack       # 生成 dist/swarm-pi-v*.zip 与 .tar.gz 及 sha256
```

推送与插件版本一致的 `vX.Y.Z` 标签后，GitHub Actions 会构建并测试插件，校验两个安装包，然后将安装包及 SHA-256 校验文件发布到 GitHub Releases。
