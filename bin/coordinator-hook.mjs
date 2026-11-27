import { readFileSync } from 'node:fs';
import { appDataFromHook, updateBinding } from './host-binding.mjs';

const SERVER = 'swarm-pi_pi';
const boundTools = new Set(['pi_create_swarm', 'pi_swarm_watch']);
const phase = process.argv[2];

function bindBoard(input, appData) {
  const call = input.toolCall;
  if (!call?.name || !call.args) return null;
  if (/^mcp_+swarm[-_]pi_pi_+pi_(?:create_swarm|swarm_watch)$/.test(call.name)) {
    return { hostBinding: updateBinding(appData, input.conversationId, false, true) };
  }
  if (call.name !== 'call_mcp_tool') return null;
  const { args } = call;
  const server = args.ServerName ?? args.serverName ?? args.server_name;
  const tool = args.ToolName ?? args.toolName ?? args.tool_name;
  if (server !== SERVER || !boundTools.has(tool)) return null;
  const key = ['Arguments', 'arguments', 'args'].find((name) => Object.hasOwn(args, name)) || 'Arguments';
  const raw = args[key];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const replacement = { ...parsed, hostBinding: updateBinding(appData, input.conversationId, false, true) };
  return { [key]: typeof raw === 'string' ? JSON.stringify(replacement) : replacement };
}

let output = phase === 'tool' ? { decision: 'allow' } : {};
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const appData = appDataFromHook(input);
  if (appData) {
    if (phase === 'tool') {
      const overwrite = bindBoard(input, appData);
      if (overwrite) output = { decision: 'allow', overwrite };
    } else {
      updateBinding(appData, input.conversationId, phase === 'idle');
    }
  }
} catch (err) {
  process.stderr.write(`Pi Swarm coordinator hook: ${err.message}\n`);
}
process.stdout.write(JSON.stringify(output));
