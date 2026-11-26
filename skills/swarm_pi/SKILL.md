---
name: swarm_pi
description: Coordinate independent Pi workers on a shared message board via direct MCP. Trigger with /swarm_pi.
disable-model-invocation: true
---

# Pi Swarm

Use the `swarm-pi_pi` MCP server directly from the main conversation. Keep the work with Pi. Report errors from Pi or MCP with the relevant board post, task ID, or log. Do not substitute a host model or start a native Swarm or subagent.

1. Call `pi_get_settings` to verify Pi and inspect role profiles. If Pi is unavailable, report the error and open the settings panel.
2. Define named workers and a verifier for code changes. Use `pi_create_swarm` with the absolute project path, title, and each member's name, role, brief, and optional `worktree: true` for independent writers. Specify ownership, acceptance checks, and the recipient for each handoff in the briefs. Instruct the verifier to use the sender workspace in its board prompt when reviewing an isolated coder and report findings directly to that coder.
3. Call `open_pi_swarm_settings(tab="board", boardId=...)` to open the side panel. Use `pi_swarm_post` to assign work to workers by name. Workers send their handoffs from Pi and the server queues them automatically. The user can post to a worker from the board.
4. Use `pi_swarm_read(boardId, after, waitMs=15000)` to read new posts and member states. If there are more than 50 messages, advance the cursor to the last message received. When a worker reports a verified result to the coordinator, independently check the requested acceptance evidence and summarize. Report blocked workers and the associated error. Leave the board open if the user may still send follow-ups.
5. Once the user is done with the board, close it with `pi_swarm_close`. For any isolated work, inspect and land the changes when authorized. Then use `pi_cleanup_worktree` with each member's `worktreeTaskId` after the changes have been retained or the user has explicitly discarded them.
