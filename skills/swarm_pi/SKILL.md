---
name: swarm_pi
description: Coordinate workers from the selected Pi or Codex harness on a shared message board via direct MCP. Trigger with /swarm_pi.
disable-model-invocation: true
---

# Pi Swarm

Use the `swarm-pi_pi` MCP server directly from the main conversation. Dispatch through the harness selected by the user in Pi Swarm Settings. Report worker or MCP errors with the relevant board post, task ID, or log. Do not substitute a host model or start a native Swarm or subagent.

1. Call `pi_get_settings` and check `settings.harness` and the corresponding `piStatus` or `codexStatus`. If the selected harness is unavailable, report the error and open the settings panel.
2. Define named workers and a verifier for code changes. Use `pi_create_swarm` with the absolute project path, title, and each member's name, role, brief, and optional `worktree: true` for independent writers. For Codex, omit the Pi tool allowlist and use a role configured with `workspace-write` for writers. Specify ownership, acceptance checks, and the recipient for each handoff in the briefs. Instruct the verifier to use the sender workspace in its board prompt when reviewing an isolated coder and report findings directly to that coder.
3. Call `open_pi_swarm_settings(tab="board", boardId=...)` to open the side panel. Use `pi_swarm_post` to assign work to workers by name. The server queues worker handoffs automatically. The user can post to a worker from the board. A board can dispatch when its original harness is selected in Settings.
4. Use `pi_swarm_read(boardId, after, waitMs=15000)` to read new posts and member states. If there are more than 50 messages, advance the cursor to the last message received. When a worker reports a verified result to the coordinator, independently check the requested acceptance evidence and summarize. Report blocked workers and the associated error. Leave the board open if the user may still send follow-ups.
5. Once the user is done with the board, close it with `pi_swarm_close`. For any isolated work, inspect and land the changes when authorized. Then use `pi_cleanup_worktree` with each member's `worktreeTaskId` after the changes have been retained or the user has explicitly discarded them.
