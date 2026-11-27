# agy-swarm-pi (`swarm-pi`)

[English](README.md) · 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 **Google Antigravity** 中通过 `/swarm_pi` 直接并发调度 **Pi** 或 **Codex** 执行编码、审查与调研任务。先在设置中选择一个执行器，再通过 **Pi Swarm** 共享消息板查看进度与追加指令。

## 特性

- **后台协调**。通过 MCP 派工，使用 Pi Swarm 面板查看成员进度。看板出现需要跟进的事件时，自动唤醒原会话。
- **Git Worktree 隔离**。`pi_submit_task(..., worktree: true)` 为并发写入创建独立 worktree 和 `swarm-pi/*` 分支。任务完成后可查看变更并清理工作树。
- **共享消息板和角色设置**。在 Pi Swarm 面板选择成员的 Subagent 卡片，可查看该成员的职责说明，以及最近任务的状态、耗时、工具调用、模型、工作树和日志路径等可用信息。可为 `coder`、`verifier`、`researcher` 等角色配置模型、推理档位和超时。Pi 可配置工具白名单，Codex 可配置沙箱。
- **预构建安装包**。仓库和 Release 包包含 MCP 服务、面板与协调器 Sidecar。Antigravity 直接通过 Node.js 启动服务。

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

从 [GitHub Releases](https://github.com/KLOSYX/agy-swarm-pi/releases) 下载对应版本的安装包。以下以 v0.5.0 为例。

```bash
curl -fsSLO https://github.com/KLOSYX/agy-swarm-pi/releases/download/v0.5.0/swarm-pi-v0.5.0.tar.gz
tar -xzf swarm-pi-v0.5.0.tar.gz
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

成员通过最终回复中的 `SWARM_POST @成员 消息` 交接。重复交接或达到安全上限时，协调器可查看被暂缓的原始消息，再决定是否继续派单。切换执行器前，请先等待任务完成或取消任务。旧看板可继续查看，切回原执行器后可继续发消息。

插件数据目录保存看板历史、协调器游标、派单去重键、任务日志、Pi 会话文件和 Codex 会话 ID。MCP 重启时会恢复看板，并把尚未确认的派单标记为中断，供协调器核对后续处理。Codex 会话正文由其 CLI 保存。Codex 的 JSONL 输出未上报实际模型，面板会单独显示配置模型。

### 从面板更新

在**设置 → 插件更新**点击**检查更新**，对比运行版本与 GitHub 最新稳定版。通过发行包安装的插件可点击**安装更新**并确认。安装会验证发布包的 SHA-256，并保留旧插件目录的备份。有运行或排队任务时，面板会阻止安装。

安装后请在 Antigravity 中手动重载插件。重载会恢复已持久化的看板。支持持久化之前创建的看板随旧进程结束。插件目录以外的设置和会话数据会保留。从 Git 克隆运行的插件请通过 Git 更新。目录链接请更新链接指向的源目录。

如果面板提示数据位于插件目录内，请先完成所有任务并退出 Antigravity，将数据目录（通常为 `.data`）复制到插件目录之外并确认备份可读。以原安装目录为目标运行安装脚本，再把数据复制回原路径，然后打开 Antigravity。手动安装脚本会替换目标目录。

### 按事件自动跟进

协调器通过 `swarm-pi_pi` 派工后结束当前回合。开板时默认订阅创建该看板的会话。在 Antigravity 的 `~/.gemini/config/config.json` 中合并以下配置并重载 Antigravity，即可接收自动唤醒。

```json
{"sidecars": {"swarm-pi/coordinator": {"enabled": true}}}
```

发给协调器的消息、成员报错或队列执行完毕会唤醒原会话。协调器从收件箱读取待处理消息并确认进度，必要时可按消息号读取完整原帖。用相同去重键和参数重试派单时，工具返回原回执。自动唤醒不可用时，仍可在 Pi Swarm 面板查看进度和追加指令。[Antigravity Sidecar 文档](https://antigravity.google/docs/sidecars/#agentapi)

---

## 本地开发与打包

```bash
npm install
npm run build      # 重新打包 ui/dist/settings.html 与 bin/server.bundle.mjs
npm test           # 运行单元测试与集成测试
npm run pack       # 生成 dist/swarm-pi-v*.zip 与 .tar.gz 及 sha256
```

推送与插件版本一致的 `vX.Y.Z` 标签后，GitHub Actions 会构建并测试插件，校验两个安装包，然后将安装包及 SHA-256 校验文件发布到 GitHub Releases。
