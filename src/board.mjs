import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_HANDOFFS = 8;
const ROUTE = /^SWARM_POST @([a-z0-9_-]+) (.+)$/;
const HOST_MEMBERS = new Set(['coordinator', 'user', 'system']);

export class SwarmBoards {
  constructor(taskManager, settingsStore) {
    this.taskManager = taskManager;
    this.settingsStore = settingsStore;
    this.boards = new Map();
  }

  async create({ title, cwd, members }) {
    if (!path.isAbsolute(cwd) || !(await fs.stat(cwd).catch(() => null))?.isDirectory()) {
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
    const board = { id, title, harness, roster, messages: [], waiters: new Set(), closed: false };
    this.boards.set(id, board);
    return this.snapshot(board);
  }

  get(id) {
    const board = this.boards.get(id);
    if (!board) throw new Error(`Unknown Pi Swarm: ${id}`);
    return board;
  }

  list() {
    return Array.from(this.boards.values(), ({ id, title, harness, closed }) => ({ id, title, harness, closed })).reverse();
  }

  read(id, after = 0) {
    return this.snapshot(this.get(id), after);
  }

  async waitForMessages(id, after = 0, waitMs = 0) {
    const board = this.get(id);
    if (waitMs > 0 && board.messages.length <= after && !board.closed) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          board.waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        board.waiters.add(finish);
      });
    }
    return this.snapshot(board, after);
  }

  close(id) {
    const board = this.get(id);
    if ([...board.roster.values()].some((member) => member.status === 'working')) {
      throw new Error('Wait for active members before closing the swarm');
    }
    board.closed = true;
    for (const wake of board.waiters) wake();
    for (const member of board.roster.values()) {
      if (member.worktreeTaskId) this.taskManager.worktreeLeases.delete(member.worktreeTaskId);
    }
    return this.snapshot(board);
  }

  async post(id, from, to, text) {
    const board = this.get(id);
    if (to !== 'coordinator' && !board.roster.has(to)) {
      throw new Error(`Unknown recipient: @${to}`);
    }
    const { harness } = await this.settingsStore.load();
    if (board.harness !== harness) {
      throw new Error(`This swarm uses ${board.harness}. Select ${board.harness} in Settings to continue it, or create a new swarm for ${harness}.`);
    }
    if (board.closed) throw new Error('This Pi Swarm is closed');
    this.deliver(board, { from, to, text, budget: { remaining: MAX_HANDOFFS } });
    return this.snapshot(board);
  }

  append(board, { from, to = null, text, kind, ...details }) {
    const entry = {
      number: board.messages.length + 1, time: new Date().toISOString(),
      from, to, text, kind, ...details,
    };
    board.messages.push(entry);
    for (const wake of board.waiters) wake();
    return entry;
  }

  deliver(board, { from, to, text, budget, ...details }) {
    const recipient = board.roster.get(to);
    const entry = this.append(board, { from, to, text, kind: 'message', ...details });
    if (!recipient) return;
    recipient.queue.push({ entry, budget });
    if (recipient.status !== 'working') void this.runMember(board, recipient);
  }

  async runMember(board, member) {
    member.status = 'working';
    while (member.queue.length > 0) {
      const { entry, budget } = member.queue.shift();
      member.turns += 1;
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
        member.taskId = task.task_id;
        if (task.worktree) {
          member.worktreeTaskId = task.task_id;
          this.taskManager.worktreeLeases.add(task.task_id);
        }
        member.cwd = task.cwd;
        const result = await this.taskManager.waitForCompletion(task.task_id);
        member.actualModel = result.actual_model;
        if (result.status !== 'completed' || result.error_text || !result.result_text.trim()) {
          throw new Error(result.error_text || `${board.harness} ended with ${result.status} and no usable reply`);
        }
        const feedback = [];
        const handoffs = [];
        const summary = [];
        for (const line of result.result_text.split(/\r?\n/)) {
          const route = line.trim().match(ROUTE);
          if (!route) {
            if (line.trim().startsWith('SWARM_POST')) feedback.push('Invalid SWARM_POST syntax');
            else summary.push(line);
            continue;
          }
          const [, to, text] = route;
          if (to === member.name || (to !== 'coordinator' && !board.roster.has(to))) {
            feedback.push(`Invalid handoff to @${to}`);
          } else if (text.length > 4000) {
            feedback.push(`Handoff to @${to} exceeds 4000 characters`);
          } else if (to !== 'coordinator' && budget.remaining === 0) {
            feedback.push(`Automatic handoff limit reached for @${to}`);
          } else {
            if (to !== 'coordinator') budget.remaining -= 1;
            handoffs.push({ from: member.name, to, text, budget });
          }
        }
        const details = { taskId: task.task_id, replyTo: entry.number };
        this.append(board, {
          from: member.name, kind: 'result', text: summary.join('\n').trim().slice(0, 4000),
          actualModel: result.actual_model, ...details,
        });
        for (const text of feedback) this.append(board, { from: member.name, kind: 'error', text, ...details });
        for (const handoff of handoffs) this.deliver(board, { ...handoff, ...details });
        member.lastTurnFailed = feedback.length > 0;
      } catch (error) {
        member.lastTurnFailed = true;
        this.append(board, {
          from: member.name, kind: 'error', text: error.message,
          replyTo: entry.number, taskId: task?.task_id, logPath: task?.log_path,
        });
      }
    }
    member.status = member.lastTurnFailed ? 'blocked' : 'waiting';
  }

  snapshot(board, after = 0) {
    return {
      id: board.id, title: board.title, harness: board.harness, closed: board.closed,
      members: [...board.roster.values()].map((member) => ({
        name: member.name, role: member.role, status: member.status,
        queued: member.queue.length, turns: member.turns, actualModel: member.actualModel,
        cwd: member.cwd, taskId: member.taskId, worktreeTaskId: member.worktreeTaskId,
      })),
      lastMessage: board.messages.length,
      messages: board.messages.slice(after).slice(0, 50),
    };
  }
}
