# agy-swarm-pi (`swarm-pi`)

[English](README.md) · 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 **Google Antigravity** 中通过 `/swarm_pi` 直接并发调度 **Pi** 或 **Codex** 执行编码、审查与调研任务。先在设置中选择一个执行器，再通过 **Pi Swarm** 共享消息板查看进度与追加指令。

## 特性

- **MCP 直调**。主对话通过 `swarm-pi_pi` 创建协作组、派发任务并读消息。所有任务使用设置中选定的执行器。找不到执行器时，插件会报告具体错误。
- **Git Worktree 隔离**。`pi_submit_task(..., worktree: true)` 为并发写入创建独立 worktree 和 `swarm-pi/*` 分支。任务完成后可查看变更并清理工作树。
- **共享消息板和角色设置**。在面板查看成员消息、任务结果、工具调用及执行器报告的模型。可为 `coder`、`verifier`、`researcher` 等角色配置模型、推理档位和超时。Pi 可配置工具白名单，Codex 可配置沙箱。
- **预构建安装包**。仓库和 Release 包包含 MCP 服务与面板。Antigravity 直接通过 Node.js 启动服务。

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

从 [GitHub Releases](https://github.com/KLOSYX/agy-swarm-pi/releases) 下载对应版本的安装包。以下以 v0.3.1 为例。

```bash
curl -fsSLO https://github.com/KLOSYX/agy-swarm-pi/releases/download/v0.3.1/swarm-pi-v0.3.1.tar.gz
tar -xzf swarm-pi-v0.3.1.tar.gz
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

在 Windows 上可在 PowerShell 中运行上面的 Antigravity CLI 安装命令。v0.4.0 起，MCP 服务由 `node` 直接启动。升级后如果侧边栏还没有入口，刷新 `swarm-pi_pi` 或重启 Antigravity，并确认同一环境可以运行 `node --version`。

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

---

## 本地开发与打包

```bash
npm install
npm run build      # 重新打包 ui/dist/settings.html 与 bin/server.bundle.mjs
npm test           # 运行单元测试与集成测试
npm run pack       # 生成 dist/swarm-pi-v*.zip 与 .tar.gz 及 sha256
```

推送与插件版本一致的 `vX.Y.Z` 标签后，GitHub Actions 会构建并测试插件，校验两个安装包，然后将安装包及 SHA-256 校验文件发布到 GitHub Releases。
