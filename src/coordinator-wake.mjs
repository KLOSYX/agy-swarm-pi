import fs from 'node:fs';
import path from 'node:path';
import { processIsAlive, writeJsonAtomic } from '../bin/coordinator-files.mjs';

export class CoordinatorWake {
  constructor(dataDir) {
    this.bindings = path.join(dataDir, 'coordinator-bindings');
    this.directory = path.join(dataDir, 'direct-wake');
    this.pending = path.join(this.directory, 'pending');
  }

  binding(hostBinding) {
    if (!hostBinding) return null;
    try {
      const binding = JSON.parse(fs.readFileSync(
        path.join(this.bindings, `${hostBinding.conversationId}.json`), 'utf8',
      ));
      if (binding.proof === hostBinding.proof && binding.conversationId === hostBinding.conversationId) {
        return hostBinding;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    throw new Error('Pi Swarm coordinator binding is invalid');
  }

  ready() {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(this.directory, 'ready.json'), 'utf8'));
      return processIsAlive(pid);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Pi Swarm wake readiness:', err.message);
      return false;
    }
  }

  publish(board, number) {
    if (number <= board.wakeCursor) return;
    fs.mkdirSync(this.pending, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(this.pending, `${board.id}.json`), {
      boardId: board.id, coordinator: board.coordinator, ownerPid: process.pid, number,
    });
    board.wakeCursor = number;
  }

  acknowledge(board) {
    if (board.wakeCursor && board.handledThrough >= board.wakeCursor) this.close(board);
  }

  close(board) {
    try {
      fs.rmSync(path.join(this.pending, `${board.id}.json`), { force: true });
    } catch (error) {
      console.error('Pi Swarm could not remove its pending wake:', error.message);
    }
  }
}
