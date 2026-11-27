---
name: swarm_pi
description: Coordinate workers from the selected Pi or Codex harness on a shared message board. Trigger with /swarm_pi.
disable-model-invocation: true
---

# Pi Swarm

Dispatch through the harness selected by the user in Pi Swarm Settings. Use the host's directly registered Swarm Pi MCP tools when present. Fetch a lazy tool's schema only when the current step needs it and its arguments are not already available.

## Start a swarm

1. Call `pi_get_settings` once before creating a new board. Check `settings.harness` and the corresponding `piStatus` or `codexStatus`. If the selected harness is unavailable, report its error and open the settings panel.
2. Use `pi_create_swarm` with the absolute project path, title, and named members. Define a verifier for code changes. Give each member a role, a brief with its ownership and acceptance checks, and clear handoff recipients. Use `worktree: true` for independent writers. For Codex, omit the Pi tool allowlist and choose a role with `workspace-write` for writers. Instruct the verifier to inspect the sender's workspace when reviewing an isolated coder. Leave `hostBinding` unset so Antigravity can bind this conversation and subscribe it to board events.
3. Call `open_pi_swarm_settings(tab="board", boardId=...)`. Use `pi_swarm_post` once per assignment and keep each returned `postedMessageNumber`. Member handoffs and messages sent from the panel are queued by the board. If continuing an existing board, read it first and keep already posted assignments. Resolve a failed or ambiguous post against the board history before retrying.
4. Acknowledge dispatch and end this turn. When `coordinatorWakeReady` is true, the sidecar wakes this conversation for addressed messages, worker errors, or completion of queued work. When it is false, tell the user automatic follow-up is currently unavailable and leave the panel open. The panel can still show progress and send instructions. Do not launch a monitor subagent, wait in a tool call, or poll for progress.

## Follow up on an event or user request

Use the existing board ID. Call `pi_swarm_read` with `waitMs: 0` starting after the last handled message. Page through available posts by advancing to the last message actually returned. Match results and errors to assignments by `replyTo` and handle each message once. The board has already queued routed handoffs. When workers are still active, end the turn again after handling the available messages.

Use `pi_swarm_watch` only when explicitly checking wake readiness or requesting catch-up on an existing board. Leave `hostBinding` unset. Reports should include the relevant board post, task ID, or log when available.

## Verify and close

Independently check the requested acceptance evidence, report blocked workers and their errors, and summarize outcomes. Leave the board open for user follow-ups. When the user is done, close it with `pi_swarm_close`. Inspect and land isolated work when authorized. Use `pi_cleanup_worktree` with each member's `worktreeTaskId` after the changes have been retained or the user has explicitly discarded them.
