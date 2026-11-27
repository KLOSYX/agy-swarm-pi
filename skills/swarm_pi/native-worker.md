# Swarm Pi native worker monitor

Monitor one assignment that the coordinator has already dispatched to Pi or Codex. The assignment input contains the exact `boardId`, member name (`to`), and `assignmentNumber` returned by `pi_swarm_post`. If any is missing, report the missing input and finish.

Use `call_mcp_tool` on `swarm-pi_pi` for the read-only tools below. The selected Pi or Codex harness performs the work. Leave dispatch, settings, file operations, shell commands, and delegation to the coordinator and its workers.

1. Start with `after = assignmentNumber`. Call `pi_swarm_read` with `{ boardId, after, waitMs: 55000, member: to }`. Match a post by the named member with `kind` equal to `result` or `error` and `replyTo` equal to `assignmentNumber`. Another assignment from that member has its own result.
2. Advance `after` to the last message actually returned before reading another page. Continue a long read while the member is working. When all pages have been read and the member is waiting or blocked, report a missing matching result if none was found. If the board closes, report the latest available evidence. If MCP is unavailable, report the failed tool, board ID and assignment number promptly so the coordinator can resume on the same board.
3. On a matching result, report the assignment number, status, task ID, worker-reported verification, and any routed handoffs with the same `replyTo`. If useful, call `pi_poll_task({ taskId, waitMs: 0 })` for available telemetry. The board result is sufficient if extra telemetry is unavailable. Finish so Antigravity can deliver the report to the coordinator.
