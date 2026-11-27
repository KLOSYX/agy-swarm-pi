import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BOARD_ID, processIsAlive, writeJsonAtomic } from '../../bin/coordinator-files.mjs';
import { getBinding } from '../../bin/host-binding.mjs';

const run = promisify(execFile);
const runtimeDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
if (!runtimeDir) throw new Error('Pi Swarm wake sidecar requires ANTIGRAVITY_EXECUTABLE_DATA_DIR');
let appData = path.resolve(runtimeDir);
while (path.basename(appData) !== 'sidecar_data') {
  const parent = path.dirname(appData);
  if (parent === appData) throw new Error('Cannot locate the Antigravity application data directory');
  appData = parent;
}
appData = path.dirname(appData);
const directory = path.join(appData, 'plugin_data', 'swarm-pi', 'direct-wake');
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
  if (!processIsAlive(ownerPid)) {
    fs.rmSync(filename, { force: true });
    fs.rmSync(cursorPath, { force: true });
    return;
  }
  const conversationId = coordinator.conversationId;
  if (attempted.has(conversationId)) return;
  const bindingPath = getBinding(appData, conversationId);
  const binding = bindingPath && read(bindingPath);
  if (!binding?.idle || binding.proof !== coordinator.proof) return;
  const cursor = read(cursorPath);
  if ((cursor?.sent ?? 0) >= number || Date.now() - (cursor?.attemptedAt ?? 0) < 15000) return;
  const conversationPath = path.join(dispatchDir, `conversation-${conversationId}.json`);
  const previous = read(conversationPath);
  if (previous && binding.updatedAt <= previous.bindingUpdatedAt && Date.now() - previous.at < 15000) return;
  attempted.add(conversationId);
  const now = Date.now();
  writeJsonAtomic(cursorPath, { sent: cursor?.sent ?? 0, attemptedAt: now });
  writeJsonAtomic(conversationPath, { at: now, bindingUpdatedAt: binding.updatedAt });
  const prompt = `Pi Swarm coordinator wake. Board ID: ${boardId}, new posts through #${number}. Read the existing board with swarm-pi_pi pi_swarm_read (waitMs=0), starting after the last handled post. Read additional available pages if needed. Handle actionable reports once and finish the turn to await further events.`;
  await run('agentapi', ['send-message', conversationId, prompt], { timeout: 12000 });
  writeJsonAtomic(cursorPath, { sent: number, attemptedAt: 0 });
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
