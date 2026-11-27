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
3. Call `open_pi_swarm_settings(tab="board", boardId=...)`. Use `pi_swarm_post` with a stable `assignmentKey` for each assignment, such as `initial-coder`. Keep the returned `postedMessageNumber`. Retry an ambiguous request with exactly the same key and arguments. Member handoffs and messages from the panel are already queued by the board.
4. Acknowledge dispatch and end this turn. When `coordinatorWakeReady` is true, the sidecar wakes this conversation for addressed messages, worker errors, or completion of queued work. When it is false, tell the user automatic follow-up is currently unavailable and leave the panel open. The panel can still show progress and send instructions. Do not launch a monitor subagent, wait in a tool call, or poll for progress.

## Follow up on an event or user request

Use the existing board ID. Call `pi_swarm_inbox` with `boardId`; the plugin starts after the saved processing cursor. Match reports and errors by `replyTo`. Use `pi_swarm_read` with `messageNumber` when you need a full post, including truncated previews, cited evidence, original assignments, and worker summaries linked by `resultNumber`. The board already queues peer handoffs.

Use a stable key derived from the source post and action for each follow-up, such as `post-42-request-fix`, and pass `replyTo: 42`. Reuse that key and the original arguments if the same decision is retried. If an inbox error includes `pendingHandoff`, read that post by number for the full proposed handoff and decide if the recipient should act. For interruption errors, inspect the cited assignment and any available worker log or worktree before creating a new assignment.

After processing the page and recording any resulting actions, call `pi_swarm_inbox` with `ackThrough` equal to its `pageThrough`. Continue if `hasMore` is true. When the inbox is empty and workers are still active, end the turn to await further events.

If the board was created without a host connection (`coordinatorBound: false`), use `pi_swarm_read` with `after` set to the last handled post during a follow-up.

Use `pi_swarm_watch` only when explicitly checking wake readiness or requesting catch-up on an existing board. Leave `hostBinding` unset on all tools. Reports should include the relevant board post, task ID, or log when available.

## Verify and close

Independently check the requested acceptance evidence, report blocked workers and their errors, and summarize outcomes. Leave the board open for user follow-ups. When the user is done, close it with `pi_swarm_close`. Inspect and land isolated work when authorized. Use `pi_cleanup_worktree` with each member's `worktreeTaskId` after the changes have been retained or the user has explicitly discarded them.
