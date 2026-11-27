import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CoordinatorWake } from './coordinator-wake.mjs';
import { BOARD_ID, processIsAlive, writeJsonAtomic } from '../bin/coordinator-files.mjs';

const MAX_HANDOFFS = 64;
const MAX_IDENTICAL_HANDOFFS = 2;
const ROUTE = /^SWARM_POST @([a-z0-9_-]+) (.+)$/;
const HOST_MEMBERS = new Set(['coordinator', 'user', 'system']);
const INBOX_PAGE_BYTES = 3200;
const INBOX_PREVIEW_CHARS = 500;

function forCoordinator(entry) {
  return entry.to === 'coordinator' || entry.kind === 'error' || entry.needsCoordinator === true;
}

function handoffKey(from, to, text) {
  return createHash('sha256')
    .update(JSON.stringify([from, to, text.trim().replace(/\s+/g, ' ')]))
    .digest('hex');
}

function reserveHandoff(budget, key) {
  const count = budget.seen[key] ?? 0;
  if (count >= MAX_IDENTICAL_HANDOFFS) return 'repeated';
  if (budget.remaining === 0) return 'limit';
  budget.remaining -= 1;
  budget.seen[key] = count + 1;
  return null;
}

export class SwarmBoards {
  constructor(taskManager, settingsStore) {
    this.taskManager = taskManager;
    this.settingsStore = settingsStore;
    this.boards = new Map();
    this.coordinatorWake = new CoordinatorWake(taskManager.dataDir);
    this.directory = path.join(taskManager.dataDir, 'boards');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith('.json') && BOARD_ID.test(name.slice(0, -5))) this.restore(name.slice(0, -5));
    }
  }

  async create({ title, cwd, members, hostBinding }) {
    if (!path.isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) {
      throw new Error('Swarm cwd must be an existing absolute directory');
    }
    const roster = new Map();
    for (const { name, ...options } of members) {
      if (HOST_MEMBERS.has(name) || roster.has(name)) {
        throw new Error(`Reserved or duplicate member: @${name}`);
      }
      roster.set(name, {
        name, ...options, cwd, queue: [], status: 'waiting', turns: 0,
      });
    }
    const id = randomUUID();
    const { harness } = await this.settingsStore.load();
    const coordinator = this.coordinatorWake.binding(hostBinding);
    const board = {
      id, title, harness, roster, coordinator, messages: [], waiters: new Set(), closed: false,
      wakeCursor: 0, pendingWake: 0,
      handledThrough: 0, deliveredThrough: 0, assignments: new Map(),
    };
    this.persist(board);
    this.boards.set(id, board);
    return this.snapshot(board);
  }

  persist(board) {
    const {
      id, title, harness, coordinator, closed, messages, roster,
      handledThrough, deliveredThrough, assignments,
    } = board;
    writeJsonAtomic(path.join(this.directory, `${id}.json`), {
      id, title, harness, coordinator, closed, messages, handledThrough, deliveredThrough,
      ownerPid: process.pid, roster: [...roster.values()], assignments: [...assignments],
    });
  }

  restore(id) {
    const stored = JSON.parse(readFileSync(path.join(this.directory, `${id}.json`), 'utf8'));
    if (stored.ownerPid !== process.pid && processIsAlive(stored.ownerPid)) return;
    const board = {
      ...stored, roster: new Map(stored.roster.map((member) => [member.name, member])),
      assignments: new Map(stored.assignments), waiters: new Set(), wakeCursor: 0, pendingWake: 0,
    };
    for (const member of board.roster.values()) {
      if (!board.closed && member.worktreeTaskId) this.taskManager.worktreeLeases.add(member.worktreeTaskId);
      const interrupted = [member.activeMessage, ...member.queue.map(({ entry }) => entry.number)].filter(Boolean);
      for (const replyTo of interrupted) {
        this.addEntry(board, {
          from: member.name, kind: 'error', replyTo,
          text: 'MCP server restarted before confirming this assignment. Check the worker log and workspace before dispatching any follow-up.',
          ...(replyTo === member.activeMessage && { taskId: member.activeTaskId, logPath: member.activeLogPath }),
        });
      }
      member.queue = [];
      delete member.activeMessage;
      delete member.activeTaskId;
      delete member.activeLogPath;
      if (interrupted.length) member.status = 'blocked';
      else if (member.status === 'working') member.status = member.lastTurnFailed ? 'blocked' : 'waiting';
    }
    this.persist(board);
    this.boards.set(id, board);
    if (!board.closed && board.handledThrough < board.messages.length) {
      const latest = board.messages.findLast(forCoordinator);
      this.notifyCoordinator(board, this.settled(board) ? board.messages.length : latest?.number ?? 0);
    }
  }

  get(id) {
    const board = this.boards.get(id);
    if (!board) throw new Error(`Unknown Pi Swarm: ${id}`);
    if (board.storageError) throw new Error('Pi Swarm could not save the board. Restart the MCP server to recover it.');
    return board;
  }

  hasActiveWork() {
    return [...this.boards.values()].some((board) => [...board.roster.values()]
      .some((member) => member.status === 'working' || member.queue.length > 0));
  }

  list() {
    return Array.from(this.boards.values(), ({ id, title, harness, closed }) => ({ id, title, harness, closed })).reverse();
  }

  read(id, after = 0) {
    return this.snapshot(this.get(id), after);
  }

  watch(id, after = 0, hostBinding) {
    const board = this.get(id);
    if (board.closed) throw new Error('This Pi Swarm is closed');
    const coordinator = this.coordinatorWake.binding(hostBinding);
    if (board.coordinator && coordinator?.conversationId !== board.coordinator.conversationId) {
      throw new Error('Only the owning Antigravity conversation can watch this board');
    }
    const latest = board.messages.findLast(forCoordinator);
    const cursor = this.settled(board) ? board.messages.length : latest?.number ?? 0;
    if (cursor > Math.max(after, board.handledThrough)) this.notifyCoordinator(board, cursor);
    return {
      coordinatorBound: Boolean(board.coordinator),
      coordinatorWakeReady: Boolean(board.coordinator) && this.coordinatorWake.ready(),
      handledThrough: board.handledThrough,
    };
  }

  settled(board) {
    const members = [...board.roster.values()];
    return members.some((member) => member.turns > 0)
      && members.every((member) => member.status !== 'working' && member.queue.length === 0);
  }

  notifyCoordinator(board, number) {
    if (board.closed || !board.coordinator || number <= board.handledThrough) return;
    board.pendingWake = Math.max(board.pendingWake, number);
    clearTimeout(board.wakeRetry);
    try {
      this.coordinatorWake.publish(board, board.pendingWake);
    } catch (err) {
      console.error('Pi Swarm could not queue a coordinator wake; retrying:', err.message);
      board.wakeRetry = setTimeout(() => this.notifyCoordinator(board, board.pendingWake), 2000);
      board.wakeRetry.unref();
    }
  }

  async waitForMessages(id, after = 0, waitMs = 0, { member } = {}) {
    const board = this.get(id);
    const worker = board.roster.get(member);
    if (member !== undefined && !worker) throw new Error(`Unknown member: @${member}`);

    const involvesMember = ({ from, to }) => from === member || to === member;
    const workerFinished = () => worker.turns > 0 && worker.status !== 'working';
    const hasUpdate = worker
      ? workerFinished() || board.messages.slice(after).some(involvesMember)
      : board.messages.length > after;
    if (waitMs > 0 && !hasUpdate && !board.closed) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          board.waiters.delete(wake);
          resolve();
        };
        const wake = (entry) => {
          if (board.closed || board.storageError || (worker
            ? workerFinished() || (entry?.number > after && involvesMember(entry))
            : entry)) finish();
        };
        const timer = setTimeout(finish, waitMs);
        board.waiters.add(wake);
      });
    }
    return this.snapshot(this.get(id), after);
  }

  close(id) {
    const board = this.get(id);
    if ([...board.roster.values()].some((member) => member.status === 'working')) {
      throw new Error('Wait for active members before closing the swarm');
    }
    board.closed = true;
    try {
      this.persist(board);
    } catch (error) {
      board.closed = false;
      throw error;
    }
    this.coordinatorWake.close(board);
    clearTimeout(board.wakeRetry);
    for (const wake of board.waiters) wake();
    for (const member of board.roster.values()) {
      if (member.worktreeTaskId) this.taskManager.worktreeLeases.delete(member.worktreeTaskId);
    }
    return this.snapshot(board);
  }

  requireCoordinator(board, hostBinding) {
    const binding = this.coordinatorWake.binding(hostBinding);
    if (!board.coordinator || binding?.conversationId !== board.coordinator.conversationId) {
      throw new Error('Only the owning Antigravity conversation can access the coordinator inbox');
    }
  }

  inbox(id, { hostBinding, ackThrough, limit = 8 }) {
    const board = this.get(id);
    this.requireCoordinator(board, hostBinding);
    if (ackThrough !== undefined) {
      if (ackThrough > board.deliveredThrough) throw new Error('Cannot acknowledge an unread inbox page');
      if (ackThrough > board.handledThrough) {
        const previous = board.handledThrough;
        board.handledThrough = ackThrough;
        try {
          this.persist(board);
        } catch (error) {
          board.handledThrough = previous;
          throw error;
        }
        this.coordinatorWake.acknowledge(board);
      }
      return { handledThrough: board.handledThrough };
    }

    const pending = board.messages.slice(board.handledThrough).filter(forCoordinator);
    const messages = [];
    let pageBytes = 0;
    for (const entry of pending.slice(0, limit)) {
      const characters = Array.from(entry.text);
      const text = characters.slice(0, INBOX_PREVIEW_CHARS).join('');
      const { number, from, kind, replyTo, resultNumber, taskId, logPath, pendingHandoff } = entry;
      const preview = {
        number, from, kind, replyTo, resultNumber, taskId, logPath, text,
        ...(text !== entry.text && { truncated: true }),
        ...(pendingHandoff && { pendingHandoff: { to: pendingHandoff.to, reason: pendingHandoff.reason } }),
      };
      pageBytes += Buffer.byteLength(JSON.stringify(preview)) + 1;
      if (messages.length && pageBytes > INBOX_PAGE_BYTES) break;
      messages.push(preview);
    }
    const hasMore = messages.length < pending.length;
    const pageThrough = hasMore ? messages.at(-1).number : board.messages.length;
    if (pageThrough > board.deliveredThrough) {
      const previous = board.deliveredThrough;
      board.deliveredThrough = pageThrough;
      try {
        this.persist(board);
      } catch (error) {
        board.deliveredThrough = previous;
        throw error;
      }
    }
    return {
      handledThrough: board.handledThrough, pageThrough, hasMore, messages,
      settled: this.settled(board), closed: board.closed,
      members: [...board.roster.values()].map(({ name, status, queue }) => ({
        name, status, queued: queue.length,
      })),
    };
  }

  message(id, number) {
    const entry = this.get(id).messages[number - 1];
    if (!entry) throw new Error(`Unknown board message #${number}`);
    return entry;
  }

  async post(id, from, to, text, { assignmentKey, replyTo, hostBinding } = {}) {
    const { harness } = await this.settingsStore.load();
    const board = this.get(id);
    if (assignmentKey && board.coordinator) this.requireCoordinator(board, hostBinding);
    if (to !== 'coordinator' && !board.roster.has(to)) {
      throw new Error(`Unknown recipient: @${to}`);
    }
    if (replyTo !== undefined) this.message(id, replyTo);
    const previous = assignmentKey && board.assignments.get(assignmentKey);
    if (previous) {
      const original = this.message(id, previous);
      if (original.to !== to || original.text !== text || original.replyTo !== replyTo) {
        throw new Error(`Assignment key already posted as #${previous}; use the original arguments to retry`);
      }
      return { postedMessageNumber: previous };
    }
    if (board.harness !== harness) {
      throw new Error(`This swarm uses ${board.harness}. Select ${board.harness} in Settings to continue it, or create a new swarm for ${board.harness}.`);
    }
    if (board.closed) throw new Error('This Pi Swarm is closed');
    const recipient = board.roster.get(to);
    const start = recipient && recipient.status !== 'working';
    const release = start ? this.taskManager.claimWork?.() : undefined;
    const entry = this.enqueue(board, { from, to, text, replyTo, budget: { remaining: MAX_HANDOFFS, seen: {} } });
    if (assignmentKey) board.assignments.set(assignmentKey, entry.number);
    try {
      this.publishEntries(board, [entry]);
    } catch (error) {
      if (assignmentKey) board.assignments.delete(assignmentKey);
      recipient?.queue.pop();
      board.messages.pop();
      release?.();
      throw error;
    }
    if (start) void this.runMember(board, recipient, release);
    return { postedMessageNumber: entry.number };
  }

  addEntry(board, { from, to = null, text, kind, ...details }) {
    const entry = {
      number: board.messages.length + 1, time: new Date().toISOString(),
      from, to, text, kind, ...details,
    };
    board.messages.push(entry);
    return entry;
  }

  append(board, details) {
    const entry = this.addEntry(board, details);
    this.publishEntries(board, [entry]);
    return entry;
  }

  publishEntries(board, entries) {
    this.persist(board);
    for (const entry of entries) {
      for (const wake of board.waiters) wake(entry);
    }
    const latest = entries.findLast(({ to, kind }) => to === 'coordinator' || kind === 'error');
    if (latest) this.notifyCoordinator(board, latest.number);
  }

  enqueue(board, { budget, ...details }) {
    const entry = this.addEntry(board, { ...details, kind: 'message' });
    board.roster.get(entry.to)?.queue.push({ entry, budget });
    return entry;
  }

  async runMember(board, member, release) {
    member.status = 'working';
    try {
      while (!board.storageError && member.queue.length > 0) {
        const { entry, budget } = member.queue.shift();
        member.turns += 1;
        member.activeMessage = entry.number;
        this.persist(board);
        const entries = [];
        const recipients = new Set();
        let task;
        try {
          const sender = board.roster.get(entry.from);
          const roster = [...board.roster.keys()].filter((name) => name !== member.name);
          const prompt = [
            `Pi Swarm "${board.title}". You are @${member.name}. ${member.brief || ''}`,
            `Recipients: @coordinator${roster.map((name) => `, @${name}`).join('')}.`,
            'To hand work, questions, or review findings to another member, put a line in your final answer in the exact form SWARM_POST @recipient message.',
            'Use one plain line per message and only address a member who needs to act. The board sends your remaining final answer as a status update. Report verification passes to @coordinator.',
            `Board message #${entry.number} from @${entry.from}${sender ? ` (workspace: ${sender.cwd})` : ''}:`,
            entry.text,
          ].join('\n');
          task = await this.taskManager.submit({
            prompt, cwd: member.cwd, label: member.name, role: member.role,
            model: member.model, thinking: member.thinking, tools: member.tools,
            timeoutSec: member.timeoutSec, worktree: member.worktree && !member.worktreeTaskId,
            sessionKey: `board-${board.id}-${member.name}`, finishOnSettled: true,
            expectedHarness: board.harness,
          });
          if (board.storageError) return;
          member.taskId = task.task_id;
          member.activeTaskId = task.task_id;
          member.activeLogPath = task.log_path;
          if (task.worktree) {
            member.worktreeTaskId = task.task_id;
            this.taskManager.worktreeLeases.add(task.task_id);
          }
          member.cwd = task.cwd;
          this.persist(board);
          const result = await this.taskManager.waitForCompletion(task.task_id);
          member.actualModel = result.actual_model;
          if (result.status !== 'completed' || result.error_text || !result.result_text.trim()) {
            throw new Error(result.error_text || `${board.harness} ended with ${result.status} and no usable reply`);
          }
          const feedback = [];
          const handoffs = [];
          const routeKeys = new Set();
          const summary = [];
          for (const line of result.result_text.split(/\r?\n/)) {
            const route = line.trim().match(ROUTE);
            if (!route) {
              if (line.trim().startsWith('SWARM_POST')) feedback.push({ text: 'Invalid SWARM_POST syntax' });
              else summary.push(line);
              continue;
            }
            const [, to, text] = route;
            if (to === member.name || (to !== 'coordinator' && !board.roster.has(to))) {
              feedback.push({ text: `Invalid handoff to @${to}` });
              continue;
            }
            const key = handoffKey(member.name, to, text);
            if (routeKeys.has(key)) continue;
            routeKeys.add(key);
            const reason = to === 'coordinator' ? null : reserveHandoff(budget, key);
            if (reason) {
              const why = reason === 'repeated' ? 'repeated handoff' : 'chain safety limit';
              feedback.push({
                text: `Paused automatic handoff to @${to} (${why}). Read this post for the pending message.`,
                pendingHandoff: { to, text, reason },
              });
            } else {
              handoffs.push({ from: member.name, to, text, budget });
            }
          }
          const details = { taskId: task.task_id, replyTo: entry.number };
          const text = summary.join('\n').trim();
          const summaryEntry = this.addEntry(board, {
            from: member.name, kind: 'result', text, actualModel: result.actual_model, ...details,
            ...(text && !handoffs.length && { needsCoordinator: true }),
          });
          entries.push(summaryEntry);
          if (text) details.resultNumber = summaryEntry.number;
          for (const issue of feedback) {
            entries.push(this.addEntry(board, { from: member.name, kind: 'error', ...issue, ...details }));
          }
          for (const handoff of handoffs) {
            entries.push(this.enqueue(board, { ...handoff, ...details }));
            const recipient = board.roster.get(handoff.to);
            if (recipient && recipient.status !== 'working') recipients.add(recipient);
          }
          member.lastTurnFailed = feedback.length > 0;
        } catch (error) {
          member.lastTurnFailed = true;
          entries.push(this.addEntry(board, {
            from: member.name, kind: 'error', text: error.message,
            replyTo: entry.number, taskId: task?.task_id, logPath: task?.log_path,
          }));
        }
        if (board.storageError) return;
        delete member.activeMessage;
        delete member.activeTaskId;
        delete member.activeLogPath;
        this.publishEntries(board, entries);
        for (const recipient of recipients) {
          if (recipient.status !== 'working') {
            void this.runMember(board, recipient, this.taskManager.claimWork?.());
          }
        }
      }
      if (board.storageError) return;
      member.status = member.lastTurnFailed ? 'blocked' : 'waiting';
      this.persist(board);
      for (const wake of board.waiters) wake();
      if (this.settled(board)) this.notifyCoordinator(board, board.messages.length);
    } catch (error) {
      member.status = 'blocked';
      board.storageError = error;
      console.error('Pi Swarm board interrupted:', error.message);
      for (const wake of board.waiters) wake();
    } finally {
      release?.();
    }
  }

  snapshot(board, after = 0) {
    return {
      id: board.id, title: board.title, harness: board.harness, closed: board.closed,
      coordinatorBound: Boolean(board.coordinator),
      coordinatorWakeReady: Boolean(board.coordinator) && !board.closed && this.coordinatorWake.ready(),
      members: [...board.roster.values()].map((member) => {
        const task = member.taskId && this.taskManager.tasks.get(member.taskId);
        const snapshot = task && this.taskManager.formatTaskSnapshot(task);
        // Follow-up tasks reuse the original task's worktree without owning it.
        const worktree = snapshot?.worktree ?? (member.worktreeTaskId && this.taskManager.tasks.get(member.worktreeTaskId)?.worktree);
        return {
          name: member.name, role: member.role, status: member.status,
          queued: member.queue.length, turns: member.turns, actualModel: member.actualModel,
          cwd: member.cwd, taskId: member.taskId, worktreeTaskId: member.worktreeTaskId,
          brief: member.brief || '',
          ...(snapshot && {
            latestTask: {
              taskId: snapshot.task_id,
              status: snapshot.status,
              elapsedMs: snapshot.elapsed_ms,
              toolCalls: snapshot.tool_calls,
              configuredModel: snapshot.profile.model,
              actualModel: snapshot.actual_model,
              worktreeBranch: worktree?.branch ?? null,
              worktreePath: worktree?.path ?? null,
              worktreeCleaned: worktree?.cleaned ?? false,
              logPath: snapshot.log_path,
            },
          }),
        };
      }),
      lastMessage: board.messages.length,
      messages: board.messages.slice(after).slice(0, 50),
    };
  }
}
