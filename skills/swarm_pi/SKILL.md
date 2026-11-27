---
name: swarm_pi
description: Coordinate workers from the selected Pi or Codex harness on a shared message board. Trigger with /swarm_pi.
disable-model-invocation: true
---

# Pi Swarm

Dispatch through the harness selected by the user in Pi Swarm Settings. Report worker or MCP errors with the relevant board post, task ID, or log. The selected Pi or Codex harness performs the work in both modes.

If this turn was started by a Pi Swarm coordinator wake, skip setup and read the board named in the notification. Continue from the message cursor you last handled, paging until you reach the notified message and any newer available posts. Handle each actionable report once. End the turn again if workers are still active.

## Set up the board

The Pi Swarm side panel shows native-style Subagent cards and a per-worker inspector with the brief, task status, elapsed time, tools, model, worktree, and log path as available.

1. Call `pi_get_settings` and check `settings.harness` and the corresponding `piStatus` or `codexStatus`. If the selected harness is unavailable, report the error and open the settings panel.
2. Define named workers and a verifier for code changes. Use `pi_create_swarm` with the absolute project path, title, and each member's name, role, brief, and optional `worktree: true` for independent writers. For Codex, omit the Pi tool allowlist and use a role configured with `workspace-write` for writers. Specify ownership, acceptance checks, and the recipient for each handoff in the briefs. Instruct the verifier to use the sender workspace in its board prompt when reviewing an isolated coder and report findings directly to that coder.
3. Call `open_pi_swarm_settings(tab="board", boardId=...)` to open the side panel. The server queues worker handoffs automatically, and the user can post follow-ups from the board. A board can dispatch when its original harness is selected in Settings.

## Native Antigravity Subagent Mode (recommended)

1. Read `native-worker.md` beside this skill. Once per conversation, use the host's `define_subagent` tool with `Name: "swarm-pi-worker-mcp"`, `Description: "Monitor an existing Pi Swarm assignment"`, `SystemPrompt` set to the contents of that file, `EnableMCPTools: true`, `EnableWriteTools: false`, and `EnableSubagentTools: false`. Reuse the successfully defined type in the same conversation. If the host cannot define this type or enable MCP, switch to Direct MCP Board Mode on the same board before dispatch.
2. Dispatch each assignment from the main conversation once with `pi_swarm_post`. Record the returned `postedMessageNumber`. Then use `invoke_subagent` with `TypeName: "swarm-pi-worker-mcp"`, an assignment-specific `Role`, `Model: "flash_lite"` when available, and a `Prompt` containing the exact `boardId`, member name (`to`), and `assignmentNumber`. The wrapper observes the existing assignment. Use a member handoff’s existing post number in the same way.
3. End the main turn after launching the monitors. Antigravity displays them in its native **Subagents** list and wakes the coordinator with completion reports. Handle an assignment's result once using its board message number. Start a monitor for each reported or newly discovered routed handoff by its existing post number. If the report is partial, page through the original board to find those handoffs. Routed assignments are already queued.
4. If native startup or a monitor's MCP access fails, switch to Direct MCP Board Mode. Read and subscribe to the same board. Keep each recorded assignment and only post missing work. If a post had an ambiguous response, find it in the board history before retrying. Reconcile any late native reports using their assignment number.

The wrapper uses host-model tokens to read and report. Pi or Codex performs all implementation and verification. The host's existing MCP permissions still apply.

## Direct MCP Board Mode (fallback)

Use this mode when the user wants zero host-wrapper turns or native subagents are unavailable.

1. For a native-mode fallback, read the existing board with `pi_swarm_read(waitMs=0)` and identify the original assignment posts and any wrapper that may still dispatch an assignment. Preserve assignments already posted. Confirm the earlier attempt ended without a post before retrying an ambiguous dispatch.
2. Call `pi_swarm_watch` on the existing board with the last message number you have handled, or 0 for a new board. Leave `hostBinding` unset in both `pi_create_swarm` and `pi_swarm_watch`; Antigravity sets it automatically. Dispatch missing assignments directly with `pi_swarm_post`.
3. If `coordinatorWakeReady` is true, acknowledge dispatch and end the current turn. The sidecar wakes this conversation for coordinator-addressed posts, worker errors, or when the workers finish their queued work.
4. If `coordinatorWakeReady` is false, say that automatic follow-up is unavailable and leave the board open in the panel. Use a long read only if the user requested that this turn wait for results.

## Verify and close

Independently check the requested acceptance evidence, report blocked workers and their errors, and summarize outcomes. Leave the board open for user follow-ups. Once the user is done, close it with `pi_swarm_close`. Inspect and land isolated work when authorized. Use `pi_cleanup_worktree` with each member's `worktreeTaskId` after the changes have been retained or the user has explicitly discarded them.
