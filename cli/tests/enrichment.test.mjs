import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import core from '../../shared/enrichment.cjs';
import format from '../../shared/enrichment-format.cjs';
import { root as extensionRoot } from '../lib/process.mjs';

async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gtc-enrich-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'repo space'); await mkdir(root);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(root, 'file [x].txt'), 'one\ntwo\n');
    git('add', '.'); git('commit', '-qm', 'Base'); const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature'); await writeFile(path.join(root, 'file [x].txt'), 'one\nthree\n');
    const selection = { left: base, right: null };
    const snapshot = await core.context(root, selection);
    const data = { version: 1, snapshotId: snapshot.id, producer: 'Fixture agent', summary: 'Change the second line.',
        files: [{ path: 'file [x].txt', priority: 'important', kind: 'behaviour', reason: 'Changes the returned word.', annotations: [
            { side: 'after', startLine: 2, endLine: 2, title: 'New word', body: 'This replaces two with three.', scope: 'file' },
        ] }], guide: [{ path: 'file [x].txt', title: 'Review the word', description: 'Read the changed line.', annotation: 0 }] };
    const output = path.join(directory, 'result.json');
    const save = () => writeFile(output, JSON.stringify(data)); await save();
    return { root, directory, git, base, selection, snapshot, data, output, save };
}
test('enrichment publishes atomic data, detects edits and restores the original approved analysis', async t => {
    const f = await fixture(t);
    await core.publish(f.root, f.output);
    let state = await core.load(f.root, f.selection);
    assert.equal(state.current, true); assert.deepEqual(state.fresh, ['file [x].txt']);
    await writeFile(path.join(f.root, 'file [x].txt'), 'different\n');
    state = await core.load(f.root, f.selection); assert.equal(state.current, false); assert.deepEqual(state.fresh, []);
    await assert.rejects(core.publish(f.root, f.output), /changed|outside the text/i);
    await writeFile(path.join(f.root, 'file [x].txt'), 'one\nthree\n');
    assert.equal((await core.load(f.root, f.selection)).current, true);
    f.git('checkout', '-qb', 'other'); assert.equal((await core.load(f.root, f.selection)).data, null);
    f.git('checkout', '-q', 'feature'); assert.equal((await core.load(f.root, f.selection)).current, true);
    await writeFile(path.join(f.root, 'new.txt'), 'new file');
    await assert.rejects(core.publish(f.root, f.output), /Comparison changed/);
});
test('validation rejects unsafe paths, unknown properties, false whitespace and invalid anchors', async t => {
    const f = await fixture(t);
    for (const value of ['../escape', '/tmp/escape', '.git/config', 'nested/../escape', 'a\\b', 'a\nb']) assert.throws(() => core.relative(value));
    f.data.command = 'execute'; await f.save(); await assert.rejects(core.validateFile(f.root, f.output), /unknown field/); delete f.data.command;
    f.data.files[0].kind = 'whitespace'; await f.save(); await assert.rejects(core.validateFile(f.root, f.output), /Whitespace label/);
    await writeFile(path.join(f.root, 'file [x].txt'), 'one\n  two\n');
    const whitespace = await core.context(f.root, f.selection); f.data.snapshotId = whitespace.id; await f.save();
    await core.validateFile(f.root, f.output);
    f.data.files[0].kind = 'plumbing'; f.data.files[0].annotations[0].endLine = 500; await f.save();
    await assert.rejects(core.validateFile(f.root, f.output), /outside the text/);
    f.data.files[0].annotations = []; f.data.guide = [];
    await symlink('/etc/passwd', path.join(f.root, 'external'));
    const context = await core.context(f.root, f.selection);
    assert.ok(context.files.find(file => file.path === 'external').unsupported);
    f.data.snapshotId = context.id; f.data.files[0].path = 'external'; f.data.files[0].annotations = [{ side: 'after', startLine: 1, endLine: 1, title: 'bad', body: 'bad' }]; await f.save();
    await assert.rejects(core.validateFile(f.root, f.output), /regular text/);
});
test('worktree-local storage and CLI explicit targeting do not contaminate the source checkout', async t => {
    const f = await fixture(t);
    const linked = path.join(f.directory, 'linked'); f.git('worktree', 'add', '-q', '-b', 'linked', linked, f.base);
    const loc = await core.location(linked); assert.notEqual(loc.gitDir, path.join(f.root, '.git'));
    await core.saveSelection(linked, { left: f.base, right: null });
    const run = (...args) => execFileSync(process.execPath, [path.join(extensionRoot, 'cli/bin/run.mjs'), ...args], {
        cwd: f.directory, encoding: 'utf8', env: { ...process.env, GTC_DEVENV: '1', GTC_INVOCATION_CWD: f.directory },
    });
    const context = JSON.parse(run('enrich', 'context', '--repo', 'linked'));
    assert.equal(context.repo, linked); assert.equal(context.files.length, 0);
    assert.equal(JSON.parse(run('enrich', 'validate', '--repo', f.root, '--file', f.output)).valid, true);
    assert.equal(JSON.parse(run('enrich', 'publish', '--repo', f.root, '--file', f.output)).snapshotId, f.snapshot.id);
    assert.equal(JSON.parse(run('enrich', 'schema')).properties.version.const, 2);
    assert.match(run('skills', 'install', '--global', '--dry-run'), /skills@1.5.26/);
});
test('the pinned skills installer installs functional helpers in an isolated user home', async t => {
    const f = await fixture(t);
    const home = path.join(f.directory, 'home'); await mkdir(home);
    const env = { ...process.env, GTC_DEVENV: '1', HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), DISABLE_TELEMETRY: '1', CI: '1' };
    execFileSync(process.execPath, [path.join(extensionRoot, 'cli/bin/run.mjs'), 'skills', 'install', '--global'], { env, encoding: 'utf8', timeout: 30000 });
    for (const agent of ['.agents', '.claude']) {
        const skill = path.join(home, agent, 'skills/enrich-pr');
        assert.match(await readFile(path.join(skill, 'SKILL.md'), 'utf8'), /enrich context/);
        const output = execFileSync(process.execPath, [path.join(skill, 'scripts/run.cjs'), 'enrich', 'context', '--repo', f.root, '--base', f.base], { env, cwd: home, encoding: 'utf8' });
        assert.equal(JSON.parse(output).id, f.snapshot.id);
    }
});

test('publication rejects modified history and redirected storage; HTML renders model text inert', async t => {
    const f = await fixture(t);
    const pointer = await core.publish(f.root, f.output);
    const { run } = JSON.parse(await readFile(pointer.file, 'utf8'));
    const loc = await core.location(f.root);
    const runFile = path.join(loc.directory, 'runs', run + '.json');
    const document = JSON.parse(await readFile(runFile, 'utf8')); document.data.summary = 'tampered';
    await writeFile(runFile, JSON.stringify(document));
    await assert.rejects(core.load(f.root, f.selection), /identity mismatch/);
    await rm(loc.directory, { recursive: true });
    const outside = path.join(f.directory, 'outside'); await mkdir(outside);
    await symlink(outside, loc.directory);
    await assert.rejects(core.context(f.root, f.selection), /symbolic link/);
    const { createRequire } = await import('node:module');
    const { briefHtml } = createRequire(import.meta.url)('../../out/enrichmentBrief.js');
    const malicious = '<img src=x onerror="alert(1)">';
    const html = briefHtml({ current: true, fresh: ['file [x].txt'], snapshot: f.snapshot,
        data: format.normalize({ ...f.data, summary: malicious, producer: malicious }) });
    assert.ok(!html.includes(malicious));
    assert.match(html, /&lt;img/);
    assert.match(html, /default-src 'none'/);
});

test('linked guides enforce important-file coverage and validate all range links before replacing a publication', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, 'caller.txt'), 'forward\nargument\n');
    const snapshot = await core.context(f.root, f.selection);
    const data = format.normalize({ ...f.data, snapshotId: snapshot.id });
    data.files.push({ path: 'caller.txt', priority: 'low', labels: ['plumbing', 'refactor'], reason: 'Forwards the argument to the substantive change.', annotations: [] });
    data.guide[0].links.push({ path: 'caller.txt', label: 'Follow the parameter', range: { side: 'after', startLine: 2, endLine: 2 } });
    data.brief.visuals = [{ kind: 'flow', title: 'Call path', steps: [
        { label: 'Forward parameter', links: [data.guide[0].links[1]] },
        { label: 'Change the word', links: [data.guide[0].links[0]] },
    ] }];
    data.brief.evidence = [{ text: 'Execution has not been verified.', links: [] }];
    const save = () => writeFile(f.output, JSON.stringify(data)); await save();
    const published = await core.publish(f.root, f.output);
    const pointer = await readFile(published.file, 'utf8');
    assert.equal((await core.load(f.root, f.selection)).data.guide[0].links.length, 2);
    const original = data.guide[0].links.shift(); await save();
    await assert.rejects(core.publish(f.root, f.output), /Important file missing.*file \[x\]/);
    assert.equal(await readFile(published.file, 'utf8'), pointer, 'Invalid publication leaves the existing analysis intact');
    data.guide[0].links.unshift(original);
    data.guide[0].links[1].range.endLine = 500; await save();
    await assert.rejects(core.validateFile(f.root, f.output), /outside the text/);
    data.guide[0].links[1].range.endLine = 2;
    data.brief.focus = [{ text: 'Look here.', links: [{ path: '../outside', label: 'Escape' }] }]; await save();
    await assert.rejects(core.validateFile(f.root, f.output), /link.path/);
    data.brief.focus = [];
    data.files[1].labels.push('plumbing'); await save();
    await assert.rejects(core.validateFile(f.root, f.output), /unique supported labels/);
    data.files[1].labels.pop(); data.brief.visuals.push({ kind: 'html', title: 'Unsafe', body: '<script>execute()</script>', links: [] }); await save();
    await assert.rejects(core.validateFile(f.root, f.output), /visual.kind/);
});

test('legacy guides migrate without losing targets, and numbered titles are presented once', async t => {
    const f = await fixture(t);
    f.data.guide[0].title = '1. 1. Review the word'; await f.save();
    await core.publish(f.root, f.output);
    const state = await core.load(f.root, f.selection);
    assert.equal(state.data.version, 2);
    assert.deepEqual(state.data.files[0].labels, ['behaviour']);
    assert.deepEqual(state.data.guide[0].links[0], { path: 'file [x].txt', label: 'file [x].txt', annotation: 0 });
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { briefHtml } = require('../../out/enrichmentBrief.js');
    const { guideTitle } = require('../../out/enrichmentPresentation.js');
    assert.equal(guideTitle(state.data.guide[0].title), 'Review the word');
    assert.equal(guideTitle('2.0 compatibility'), '2.0 compatibility');
    assert.match(briefHtml(state), /class="guide-title"[^>]*>Review the word<\/button>/);
});

test('the bundled skill example validates against real captured source and range contents', async t => {
    const f = await fixture(t);
    const example = JSON.parse(await readFile(path.join(extensionRoot, 'skills/enrich-pr/references/example.json'), 'utf8'));
    for (const file of example.files) {
        await mkdir(path.dirname(path.join(f.root, file.path)), { recursive: true });
        await writeFile(path.join(f.root, file.path), Array.from({ length: 20 }, (_, n) => `example line ${n + 1}`).join('\n'));
    }
    example.snapshotId = (await core.context(f.root, f.selection)).id;
    await writeFile(f.output, JSON.stringify(example));
    await core.validateFile(f.root, f.output);
});


test('clearing enrichment removes all runs without touching source or following storage symlinks', async t => {
    const f = await fixture(t);
    await core.publish(f.root, f.output);
    const before = await readFile(path.join(f.root, 'file [x].txt'));
    const loc = await core.location(f.root);
    await core.clear(f.root);
    await assert.rejects(readFile(path.join(loc.directory, 'selection.json')), /ENOENT/);
    assert.equal((await core.load(f.root, f.selection)).data, null);
    assert.deepEqual(await readFile(path.join(f.root, 'file [x].txt')), before);
    const outside = path.join(f.directory, 'external-storage'); await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    await symlink(outside, loc.directory);
    await assert.rejects(core.clear(f.root), /symbolic link/);
    assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
});
