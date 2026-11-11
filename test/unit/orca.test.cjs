const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OrcaClient, OrcaDeliveryUncertain, selectOrcaAgent, resolveOrcaExecutable } = require('../../out/orcaClient');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtc-orca-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cli = path.join(root, 'orca test cli');
    await fs.copyFile(path.join(__dirname, '../fixtures/orca-cli.cjs'), cli);
    await fs.chmod(cli, 0o755);
    return { root, cli, client: new OrcaClient(cli),
        mode: mode => fs.writeFile(path.join(root, 'orca-control.json'), JSON.stringify({ mode })),
        calls: async () => (await fs.readFile(path.join(root, 'orca-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Orca resolves the exact worktree, selects the active agent and preserves literal prompt arguments', async t => {
    const f = await fixture(t);
    assert.equal(resolveOrcaExecutable(f.cli, { ORCA_CLI_COMMAND: '/wrong' }), f.cli);
    const target = await f.client.prepare(f.root);
    assert.equal(target.handle, 'selected-agent');
    const prompt = 'line 1\n"quoted" `literal` $(touch SHOULD_NOT_EXIST) ; --flag 😀';
    assert.deepEqual(await f.client.send(f.root, target, prompt), { started: true, focusWarning: false });
    const calls = await f.calls();
    assert.ok(calls.some(a => a.includes('path:' + f.root)));
    assert.ok(calls.some(a => a.includes('identity:exact-worktree')));
    assert.deepEqual(calls.find(a => a[1] === 'send'), ['terminal', 'send', '--terminal', 'selected-agent', '--text', prompt, '--enter', '--wait-submit', '10', '--json']);
    assert.equal(calls.at(-1)[1], 'switch');
    await assert.rejects(fs.access(path.join(f.root, 'SHOULD_NOT_EXIST')));
});

test('Orca falls back to the first agent, excluding shells and other worktrees', async t => {
    const f = await fixture(t); await f.mode('shell-selected');
    assert.equal((await f.client.prepare(f.root)).handle, 'first-agent');
    for (const mode of ['no-agent', 'remote', 'stopped']) {
        await f.mode(mode); await assert.rejects(f.client.prepare(f.root));
    }
    assert.equal((await f.calls()).some(a => a[1] === 'send'), false);
    assert.throws(() => selectOrcaAgent({ terminals: [{ handle: 'foreign', worktreeId: 'other', agentIdentity: 'codex', connected: true, writable: true, executionHostId: 'local' }] }, 'ours'), /No running/);
});

test('Orca uses selected leaves within splits, not every tab’s active flag', () => {
    const a = { handle: 'a', worktreeId: 'ours', agentIdentity: 'codex', connected: true, writable: true, executionHostId: 'local', leafId: 'a-leaf' };
    const b = { ...a, handle: 'b', leafId: 'b-leaf' };
    const list = { terminals: [b, a], visualLayouts: [{ worktreeId: 'ours', root: { type: 'group', activeTabId: 'chosen', tabs: [
        { tabId: 'chosen', activeLeafId: 'b-leaf', panes: { type: 'pane-split', first: a, second: b } },
    ] } }] };
    assert.equal(selectOrcaAgent(list, 'ours').handle, 'b');
    list.visualLayouts[0].root.activeTabId = 'non-agent';
    assert.equal(selectOrcaAgent(list, 'ours').handle, 'a', 'Fallback follows pane order, not terminal inventory order');
});

test('Orca refuses stale agents and treats lost receipts differently from definite refusal', async t => {
    const f = await fixture(t); const target = await f.client.prepare(f.root);
    await f.mode('stale'); await assert.rejects(f.client.send(f.root, target, 'review'), /no longer available/);
    assert.equal((await f.calls()).some(a => a[1] === 'send'), false);
    await f.mode('refuse'); await assert.rejects(f.client.send(f.root, target, 'review'), error => !(error instanceof OrcaDeliveryUncertain));
    await f.mode('uncertain'); await assert.rejects(f.client.send(f.root, target, 'review'), OrcaDeliveryUncertain);
    assert.equal((await f.calls()).filter(a => a[1] === 'send').length, 2, 'No automatic retries');
    assert.equal((await f.calls()).some(a => a[1] === 'switch'), false);
    await f.mode('focus-fail');
    assert.deepEqual(await f.client.send(f.root, target, 'review'), { started: true, focusWarning: true });
});
