# agy-swarm-pi (`swarm-pi`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 **Google Antigravity** 中通过 `/swarm_pi` **直接并发调度外部 Pi**（`@mariozechner/pi-coding-agent`）执行编码、审查与调研任务——**零中间代理模型开销**，内置 Git Worktree 隔离、按角色模型/思考档位配置以及实时 **Pi Swarm 任务看板**。

## 特性

- **MCP 直调零代理层（`/swarm_pi`）**：由主对话直接并发调用 `swarm-pi_pi`（`pi_submit_task` / `pi_wait_tasks` / `pi_cleanup_worktree`），不再额外消耗 `flash_lite` 等中间代理模型额度；免终端网络沙盒审批，具备 Fail-Closed 强熔断护栏。
- **内置 Git Worktree 隔离**：`pi_submit_task(..., worktree: true)` 自动创建独立 worktree 与 `swarm-pi/*` 分支供并发写代码使用，完成后自动返回 `diff_stat` 与真实执行的 `actual_model`，并支持清理临时工作树。
- **双标签页可视化面板（Pi Swarm）**：在 Antigravity 侧边栏或右上角 `+` 菜单打开 **Pi Swarm**，实时查看并发 Pi 任务的实际模型、思考档位、工具调用、Worktree 变更与输出结果，并可在「模型与角色设置」页自定义全局默认与 `coder`/`verifier`/`researcher` 等角色预设。
- **开箱即用零依赖**：仓库及 Release 包已内置打包好的单文件 MCP Server（`bin/server.bundle.mjs`）与单文件 MCP App UI（`ui/dist/settings.html`），目标机器无需执行 `npm install`，自动复用系统 Node.js 或 Antigravity 内置 `agy-node`。

---

## 前置要求

目标机器需安装 Pi CLI 并配置对应模型 Provider 凭证：

```bash
npm install -g @mariozechner/pi-coding-agent
```

---

## 快速安装

### 方式一：从 GitHub Release 下载零依赖安装包（推荐）

```bash
curl -fsSLO https://github.com/KLOSYX/agy-swarm-pi/releases/latest/download/swarm-pi-v0.2.0.tar.gz
tar -xzf swarm-pi-v0.2.0.tar.gz
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
2. 在 Antigravity 侧边栏或对话右上角 `+` 菜单打开 **Pi Swarm**，切换到 **模型与角色设置**，点击 **检测 Pi / 刷新模型**，设置全局默认及按角色的模型与思考档位并保存。
3. 在对话中输入 `/swarm_pi <你的任务>`，协调器会直接并行拉起 Pi 任务并在 **Pi Swarm > 任务看板** 展示实时状态与实际执行模型。

---

## 本地开发与打包

```bash
npm install
npm run build      # 重新打包 ui/dist/settings.html 与 bin/server.bundle.mjs
npm test           # 运行单元测试与集成测试
npm run pack       # 生成 dist/swarm-pi-v*.zip 与 .tar.gz 及 sha256
```
