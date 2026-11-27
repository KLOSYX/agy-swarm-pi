import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_ID, writeJsonAtomic } from './coordinator-files.mjs';

export function getBinding(appDataDir, conversationId) {
  if (!BOARD_ID.test(conversationId || '')) return null;
  const directory = path.join(appDataDir, 'plugin_data', 'swarm-pi', 'coordinator-bindings');
  return path.join(directory, `${conversationId}.json`);
}

export function updateBinding(appDataDir, conversationId, idle, create = false) {
  const filename = getBinding(appDataDir, conversationId);
  if (!filename) return null;
  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (!create) return null;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.initial`;
    try {
      writeJsonAtomic(temporary, { conversationId, proof: randomUUID() });
      try {
        fs.linkSync(temporary, filename);
      } catch (linkError) {
        if (linkError.code !== 'EEXIST') throw linkError;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    binding = JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  binding.idle = idle;
  binding.updatedAt = Date.now();
  writeJsonAtomic(filename, binding);
  return { conversationId, proof: binding.proof };
}

export function appDataFromHook(input) {
  if (!input.transcriptPath || !BOARD_ID.test(input.conversationId || '')) return null;
  const directory = path.dirname(path.resolve(input.transcriptPath));
  const convDir = path.resolve(directory, '../..');
  const brain = path.dirname(convDir);
  return path.basename(brain) === 'brain' && path.basename(convDir) === input.conversationId
    ? path.dirname(brain) : null;
}
