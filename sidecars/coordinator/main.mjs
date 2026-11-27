import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BOARD_ID, processIsAlive, writeJsonAtomic } from '../../bin/coordinator-files.mjs';
import { getBinding } from '../../bin/host-binding.mjs';

const run = promisify(execFile);
const WAKE_RETRY_MS = 15000;
const runtimeDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
if (!runtimeDir) throw new Error('Pi Swarm wake sidecar requires ANTIGRAVITY_EXECUTABLE_DATA_DIR');
let appData = path.resolve(runtimeDir);
while (path.basename(appData) !== 'sidecar_data') {
  const parent = path.dirname(appData);
  if (parent === appData) throw new Error('Cannot locate the Antigravity application data directory');
  appData = parent;
}
appData = path.dirname(appData);
const pluginData = path.join(appData, 'plugin_data', 'swarm-pi');
const directory = path.join(pluginData, 'direct-wake');
const pendingDir = path.join(directory, 'pending');
const dispatchDir = path.join(directory, 'dispatch');
for (const dir of [pendingDir, dispatchDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
writeJsonAtomic(path.join(directory, 'ready.json'), { pid: process.pid });

function read(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

async function wake(filename, attempted) {
  const record = read(filename);
  if (!record) return;
  const { boardId, coordinator, ownerPid, number } = record;
  const cursorPath = path.join(dispatchDir, `${boardId}.json`);
  if (!processIsAlive(ownerPid)) return;
  const conversationId = coordinator.conversationId;
  if (attempted.has(conversationId)) return;
  const bindingPath = getBinding(appData, conversationId);
  const binding = bindingPath && read(bindingPath);
  if (!binding?.idle || binding.proof !== coordinator.proof) return;
  const storedCursor = read(cursorPath);
  const cursor = storedCursor?.ownerPid === ownerPid ? storedCursor : null;
  const now = Date.now();
  if (now - (cursor?.attemptedAt ?? 0) < WAKE_RETRY_MS) return;
  // The host accepted the previous wake. A later idle transition without an
  // acknowledgement makes the same page eligible for one more notification.
  const retry = (cursor?.sent ?? 0) >= number;
  if (retry && (
    cursor.retried || binding.updatedAt <= cursor.bindingUpdatedAt || now - cursor.sentAt < WAKE_RETRY_MS
  )) return;
  const saved = read(path.join(pluginData, 'boards', `${boardId}.json`));
  if (saved?.closed || (saved?.handledThrough ?? 0) >= number) return;
  const conversationPath = path.join(dispatchDir, `conversation-${conversationId}.json`);
  const previous = read(conversationPath);
  if (previous && binding.updatedAt <= previous.bindingUpdatedAt && now - previous.at < WAKE_RETRY_MS) return;
  attempted.add(conversationId);
  writeJsonAtomic(cursorPath, { ...cursor, ownerPid, sent: cursor?.sent ?? 0, attemptedAt: now });
  writeJsonAtomic(conversationPath, { at: now, bindingUpdatedAt: binding.updatedAt });
  const prompt = `Pi Swarm coordinator wake. Board ID: ${boardId}, new posts through #${number}. Use pi_swarm_inbox for this board. Process each page and acknowledge its pageThrough. Finish the turn after handling the available work.`;
  await run('agentapi', ['send-message', conversationId, prompt], { timeout: 12000 });
  writeJsonAtomic(cursorPath, {
    ownerPid, sent: number, attemptedAt: 0, sentAt: now, bindingUpdatedAt: binding.updatedAt, retried: retry,
  });
  console.log(`Pi Swarm coordinator wake delivered for board ${boardId} post #${number}`);
}

for (;;) {
  const attempted = new Set();
  for (const name of fs.readdirSync(pendingDir)) {
    if (!name.endsWith('.json') || !BOARD_ID.test(name.slice(0, -5))) continue;
    try {
      await wake(path.join(pendingDir, name), attempted);
    } catch (err) {
      console.error(`Pi Swarm coordinator wake failed for ${name}: ${err.message}`);
    }
  }
  await delay(1000);
}
