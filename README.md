# agy-swarm-pi (`swarm-pi`)

English · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Run named Pi or Codex workers in parallel from Google Antigravity with `/swarm_pi`. Choose one active harness in the Pi Swarm panel, then use the shared board to follow work and send instructions.

## Features

- **Native Antigravity subagents**. A lightweight wrapper dispatches and monitors each assignment through `swarm-pi_pi`. Antigravity displays the wrapper in its native Subagents UI and wakes the coordinator on completion. Pi or Codex performs the work.
- **Named workers and shared messages**. Workers can hand off tasks with `@mentions`. Each worker keeps its session and working directory for follow-ups. Select a worker's Subagent card in the Pi Swarm panel to inspect its brief, latest task status and elapsed time, tool calls, model, worktree, and log path when available.
- **Git worktree isolation**. Give parallel writers separate worktrees and `swarm-pi/*` branches. Review the changes and clean up the worktrees when finished.
- **Per-role settings**. Configure model, reasoning, and timeout for roles such as coder, verifier, and researcher. Pi exposes a tool allowlist. Codex exposes a sandbox setting.
- **Prebuilt plugin**. The repository and release archives include the MCP server, panel, and native subagent definition. Antigravity starts the server directly with Node.js.

## Prerequisites

Use Node.js 20 or newer on the `PATH` inherited by Antigravity. Install and authenticate the CLI you plan to use.

```bash
npm install -g @mariozechner/pi-coding-agent
```

For Codex, install the CLI and sign in. The plugin reuses the CLI's authentication and loads its configured model when the model field is blank.

```bash
npm install -g @openai/codex
codex login
```

## Install

### From a GitHub release

Download the version you want from [GitHub Releases](https://github.com/KLOSYX/agy-swarm-pi/releases). This example installs v0.3.1.

```bash
curl -fsSLO https://github.com/KLOSYX/agy-swarm-pi/releases/download/v0.3.1/swarm-pi-v0.3.1.tar.gz
tar -xzf swarm-pi-v0.3.1.tar.gz
./swarm-pi/install.sh
```

To install only in one project, use `--workspace`. This installs the plugin under `<repo>/.agents/plugins/swarm-pi`.

```bash
./swarm-pi/install.sh --workspace /path/to/your/repo
```

### From a clone

```bash
git clone https://github.com/KLOSYX/agy-swarm-pi.git
./agy-swarm-pi/install.sh
```

You can also install the cloned plugin with the Antigravity CLI.

```bash
agy plugin install ./agy-swarm-pi
```

On Windows, run the Antigravity CLI command in PowerShell. If Windows reports that the installed plugin is in use during an upgrade, quit Antigravity and retry. Version 0.4.0 and later start the MCP server with `node` directly. If the side panel is missing after upgrading, refresh `swarm-pi_pi` or restart Antigravity and check that `node --version` works in a terminal launched from the same environment.

To remove a global installation, run the installed script with `--uninstall`.

```bash
~/.gemini/config/plugins/swarm-pi/install.sh --uninstall
```

## Use Pi Swarm

1. If Antigravity was open during installation, refresh the `swarm-pi_pi` MCP server or restart Antigravity.
2. Open **Pi Swarm** from the sidebar or the conversation's **+** menu. In **Model and role settings**, choose **Pi** or **Codex** under **Active harness**, set the executable path if needed, and save. Pi is the initial choice. Codex uses `read-only` by default and `workspace-write` for the built-in coder role.
3. Run `/swarm_pi <your task>` in the main conversation. The coordinator creates the board, names the workers, and assigns tasks.
4. Open **Shared message board** to follow the conversation. To send a follow-up, select a worker, enter your instructions, and send them. An idle worker resumes its session immediately. A busy worker processes queued messages in order.

Workers hand off work by including `SWARM_POST @worker message` in their final reply. The MCP server routes the message after the turn finishes. Finish or cancel active tasks before switching harnesses. Existing boards stay readable and become available for posting again when their original harness is selected.

Boards and queues live in the MCP process. The plugin data directory contains task logs, Pi sessions, and Codex session IDs. Codex stores its session transcripts in its own CLI data directory. Codex's JSONL output does not report the actual model, so the panel shows the configured model separately.

### Native Antigravity Subagent Mode (recommended)

By default, `/swarm_pi` uses `invoke_subagent` with `Model="flash_lite"` to launch the bundled `swarm-pi-worker` for each assignment ready to run. The coordinator ends the main turn after launch. Each wrapper monitors its Pi or Codex worker through `swarm-pi_pi`. Antigravity shows the wrapper in its native **Subagents** list and chat, then wakes the coordinator with its completion report. The main conversation uses zero polling. The wrapper adds host-model tokens for dispatching, monitoring, and reporting. Pi or Codex performs all implementation and verification. [Antigravity custom subagents](https://antigravity.google/docs/subagents/#subagent-lifecycle-and-states)

### Direct MCP Board Mode (fallback)

Ask for Direct MCP Board Mode in your `/swarm_pi` request when you want zero host-wrapper turns. The coordinator dispatches and reads the board through `swarm-pi_pi` directly. The Pi Swarm side panel shows native-style Subagent cards and a per-worker inspector in both modes.

## Develop and package

```bash
npm install
npm run build
npm test
npm run pack
```

`npm run pack` builds the bundles and writes ZIP and tar.gz archives with SHA-256 checksum files to `dist/`. Pushing a `vX.Y.Z` tag that matches the plugin version triggers GitHub Actions to build, test, verify, and publish the archives and checksums.
