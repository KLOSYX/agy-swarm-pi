# agy-swarm-pi (`swarm-pi`)

English · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Run named Pi workers in parallel from Google Antigravity with `/swarm_pi`. Workers coordinate on a shared message board, and you can send follow-up instructions from the Pi Swarm panel.

## Features

- **Direct MCP orchestration**. The main Antigravity conversation calls `swarm-pi_pi` to create a swarm, assign tasks, and read the board. Pi executes the tasks directly. If Pi is unavailable, the plugin reports the error.
- **Named workers and shared messages**. Workers can hand off tasks with `@mentions`. Each worker keeps its Pi session and working directory for follow-ups. The panel also shows the actual model, thinking level, tool calls, and worktree changes.
- **Git worktree isolation**. Give parallel writers separate worktrees and `swarm-pi/*` branches. Review the changes and clean up the worktrees when finished.
- **Per-role settings**. Set a default Pi model and thinking level, then override them for roles such as coder, verifier, and researcher.
- **Prebuilt plugin**. The repository and release archives include the MCP server and panel bundles. The plugin can run on system Node.js or Antigravity's bundled `agy-node`.

## Prerequisites

Install the Pi CLI and configure credentials for your model provider.

```bash
npm install -g @mariozechner/pi-coding-agent
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

To remove a global installation, run the installed script with `--uninstall`.

```bash
~/.gemini/config/plugins/swarm-pi/install.sh --uninstall
```

## Use Pi Swarm

1. If Antigravity was open during installation, refresh the `swarm-pi_pi` MCP server or restart Antigravity.
2. Open **Pi Swarm** from the sidebar or the conversation's **+** menu. The panel opens in English by default. Choose **简体中文** from **Language** if you prefer. In **Model and role settings**, detect Pi, refresh the model list, and save your settings.
3. Run `/swarm_pi <your task>` in the main conversation. The coordinator creates the board, names the workers, and assigns tasks.
4. Open **Shared message board** to follow the conversation. To send a follow-up, select a worker, enter your instructions, and send them. An idle worker resumes its session immediately. A busy worker processes queued messages in order.

Workers hand off work by including `SWARM_POST @worker message` in their final reply. The MCP server routes the message after that Pi turn finishes. Boards and queued messages live in the MCP process. Task logs and Pi session files are saved in the plugin data directory.

## Develop and package

```bash
npm install
npm run build
npm test
npm run pack
```

`npm run pack` builds the bundles and writes ZIP and tar.gz archives with SHA-256 checksum files to `dist/`. Pushing a `vX.Y.Z` tag that matches the plugin version triggers GitHub Actions to build, test, verify, and publish the archives and checksums.
