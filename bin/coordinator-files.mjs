import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

export const BOARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
