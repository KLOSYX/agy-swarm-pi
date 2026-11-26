# agy-swarm-pi (`swarm-pi`)

[English](README.md) · 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 **Google Antigravity** 中通过 `/swarm_pi` **直接并发调度外部 Pi**（`@mariozechner/pi-coding-agent`）执行编码、审查与调研任务——**零中间代理模型开销**，内置 Git Worktree 隔离、按角色模型/思考档位配置以及实时 **Pi Swarm 共享消息板**。

## 特性

- **MCP 直调零代理层（`/swarm_pi`）**：由主对话直接调用 `swarm-pi_pi`（`pi_create_swarm` / `pi_swarm_post` / `pi_swarm_read`），不再额外消耗 `flash_lite` 等中间代理模型额度；免终端网络沙盒审批，具备 Fail-Closed 强熔断护栏。
- **内置 Git Worktree 隔离**：`pi_submit_task(..., worktree: true)` 自动创建独立 worktree 与 `swarm-pi/*` 分支供并发写代码使用，完成后自动返回 `diff_stat` 与真实执行的 `actual_model`，并支持清理临时工作树。
- **消息板、任务和设置面板（Pi Swarm）**：在 Antigravity 侧边栏或右上角 `+` 菜单打开 **Pi Swarm**，查看命名成员之间的消息、向成员追加指令，或查看并发 Pi 任务的实际模型、思考档位、工具调用、Worktree 变更与输出结果，并可在「模型与角色设置」页自定义全局默认与 `coder`/`verifier`/`researcher` 等角色预设。
- **开箱即用零依赖**：仓库及 Release 包已内置打包好的单文件 MCP Server（`bin/server.bundle.mjs`）与单文件 MCP App UI（`ui/dist/settings.html`），目标机器无需执行 `npm install`，自动复用系统 Node.js 或 Antigravity 内置 `agy-node`。

---

## 前置要求

目标机器需安装 Pi CLI 并配置对应模型 Provider 凭证：

```bash
npm install -g @mariozechner/pi-coding-agent
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

卸载：

```bash
~/.gemini/config/plugins/swarm-pi/install.sh --uninstall
```

---

## 使用说明

1. 安装完成后，如客户端已打开，请在右上角 `... > MCP Servers` 刷新 `swarm-pi_pi`（或重启 Antigravity 窗口）。
2. 在 Antigravity 侧边栏或对话右上角 `+` 菜单打开 **Pi Swarm**。面板默认使用英文，可在顶部 **Language** 中选择 **简体中文**。切换到 **模型与角色设置**，点击 **检测 Pi / 刷新模型**，设置全局默认及按角色的模型与思考档位并保存。
3. 在对话中输入 `/swarm_pi <你的任务>`，协调器创建消息板、添加命名成员并派发任务。在 **Pi Swarm > 共享消息板** 查看成员和消息，选择成员并发送追加指令。空闲成员会接着原 Pi 会话处理，工作中的成员会依次处理排队消息。

Pi worker 通过最终回复中的 `SWARM_POST @成员 消息` 交接。每轮 Pi 执行结束后，MCP 服务负责按成员投递，保留该成员的会话及工作区。消息板和排队状态随 MCP 进程存活。任务日志与 Pi 会话文件保存在插件数据目录。

---

## 本地开发与打包

```bash
npm install
npm run build      # 重新打包 ui/dist/settings.html 与 bin/server.bundle.mjs
npm test           # 运行单元测试与集成测试
npm run pack       # 生成 dist/swarm-pi-v*.zip 与 .tar.gz 及 sha256
```

推送与插件版本一致的 `vX.Y.Z` 标签后，GitHub Actions 会构建并测试插件，校验两个安装包，然后将安装包及 SHA-256 校验文件发布到 GitHub Releases。
