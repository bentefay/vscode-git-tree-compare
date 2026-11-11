#!/usr/bin/env node
// A process boundary substitute: no connections to the user's real Orca runtime.
const fs = require('node:fs');
const path = require('node:path');
const base = path.dirname(__filename);
const controlPath = path.join(base, 'orca-control.json');
const config = fs.existsSync(controlPath) ? JSON.parse(fs.readFileSync(controlPath, 'utf8')) : {};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(base, 'orca-calls.jsonl'), JSON.stringify(args) + '\n');
const root = config.root || process.cwd();
const worktreeId = 'test-repo::' + root;
const terminal = (handle, agentIdentity) => ({ handle, agentIdentity, worktreeId, worktreePath: root,
    tabId: handle + '-tab', leafId: handle + '-leaf', title: handle, executionHostId: 'local',
    connected: true, writable: true });
const terminals = [terminal('shell'), terminal('first-agent', 'claude'), terminal('selected-agent', 'codex')];
const result = value => process.stdout.write(JSON.stringify({ ok: true, result: value }));
const fail = code => { process.stdout.write(JSON.stringify({ ok: false, error: { code } })); process.exitCode = 1; };
const command = args.slice(0, 2).join(' ');
if (args[0] === 'agent-context') {
    process.stdout.write(JSON.stringify({ commands: [{ command: 'terminal send', flags: ['wait-submit'] }] }));
} else if (args[0] === 'status') {
    result({ runtime: { reachable: config.mode !== 'stopped', state: 'ready', capabilities: ['terminal.prompt-delivery.v1'] } });
} else if (command === 'worktree show') {
    result({ worktree: { id: worktreeId, path: root, hostId: config.mode === 'remote' ? 'ssh:other' : 'local', identity: { key: 'exact-worktree' } } });
} else if (command === 'terminal list') {
    const visible = config.mode === 'no-agent' ? terminals.slice(0, 1) : terminals;
    result({ terminals: visible, truncated: false, visualLayouts: [{ worktreeId, root: { type: 'group',
        activeTabId: (config.mode === 'shell-selected' ? 'shell' : 'selected-agent') + '-tab',
        tabs: visible.map(t => ({ tabId: t.tabId, activeLeafId: t.leafId, panes: { type: 'terminal', ...t, active: true } })) } }] });
} else if (command === 'terminal show') {
    const t = terminals.find(t => t.handle === args[args.indexOf('--terminal') + 1]);
    result({ terminal: config.mode === 'stale' ? { ...t, agentIdentity: undefined } : t });
} else if (command === 'terminal send') {
    if (config.mode === 'uncertain') { process.stdout.write('connection lost'); process.exitCode = 1; }
    else result({ send: { accepted: config.mode !== 'refuse', prompt: { requestId: 'receipt-1', stages: ['input_accepted', 'turn_started'] } } });
} else if (command === 'terminal switch') {
    if (config.mode === 'focus-fail') fail('focus_unavailable'); else result({ focus: { navigated: true } });
} else fail('unexpected_test_command');
