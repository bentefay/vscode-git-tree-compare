const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { ReviewStore, REVIEW_SYNC_KEY, REVIEW_RESETS_KEY, remoteIdentity, reviewKey, sha256 } = require('../../out/reviewState');
const { ReviewFingerprinter } = require('../../out/reviewFingerprint');
const { deemphasizedPaths } = require('../../out/reviewRules');
const { resolveReviewCommit, reviewFileExists } = require('../../out/reviewDiff');

class Memory {
    data = new Map();
    get(key) { return structuredClone(this.data.get(key)); }
    async update(key, value) { this.data.set(key, structuredClone(value)); }
    setKeysForSync(keys) { this.syncKeys = keys; }
}

test('review records sync independently, merge concurrent devices, and preserve uncheck tombstones', async () => {
    const one = new Memory(), two = new Memory();
    const a = new ReviewStore(one), b = new ReviewStore(two);
    const key = reviewKey('host/repo', 'feature', 'file', true);
    const other = reviewKey('host/repo', 'feature', 'other', true);
    await a.setMany([{ key, fingerprint: sha256('reviewed') }]);
    await two.update(REVIEW_SYNC_KEY, one.get(REVIEW_SYNC_KEY));
    await b.reconcile();
    assert.equal(b.get(key).fingerprint, sha256('reviewed'));
    const old = one.get(REVIEW_SYNC_KEY);
    await a.setMany([{ key: other, fingerprint: sha256('another file') }]);
    await b.setMany([{ key, fingerprint: null }]);
    await one.update(REVIEW_SYNC_KEY, two.get(REVIEW_SYNC_KEY));
    await a.reconcile();
    assert.equal(a.get(key).fingerprint, null);
    assert.equal(a.get(other).fingerprint, sha256('another file'));
    await one.update(REVIEW_SYNC_KEY, old); // delayed, older cloud snapshot
    await new ReviewStore(one).reconcile();
    assert.equal(new ReviewStore(one).get(key).fingerprint, null);
    const local = reviewKey('/local/repo', 'feature', 'file', false);
    await a.setMany([{ key: local, fingerprint: sha256('local') }]);
    assert.equal(one.get(REVIEW_SYNC_KEY)[local], undefined);
    assert.deepEqual(one.syncKeys, [REVIEW_SYNC_KEY, 'reviews.history.v1', REVIEW_RESETS_KEY]);
});

test('portable repository keys strip credentials and transport, distinguish forks/branches/paths', () => {
    assert.equal(remoteIdentity('git@github.com:Ben/Repo.git'), remoteIdentity('https://secret:token@github.com/ben/repo.git?token=x'));
    assert.equal(remoteIdentity('ssh://git@github.com:22/ben/repo.git'), 'github.com/ben/repo');
    assert.notEqual(remoteIdentity('https://github.com/upstream/repo'), remoteIdentity('https://github.com/ben/repo'));
    assert.equal(remoteIdentity('/home/me/repo'), undefined);
    assert.equal(remoteIdentity('file:///tmp/repo'), undefined);
    assert.equal(remoteIdentity('C:\\work\\repo'), undefined);
    assert.notEqual(reviewKey('repo', 'one', 'file', true), reviewKey('repo', 'two', 'file', true));
    assert.notEqual(reviewKey('repo', 'one', 'file', true), reviewKey('another', 'one', 'file', true));
});

test('commit baselines sync with approvals while paths stay local and legacy records remain valid', async () => {
    const storage = new Memory(), store = new ReviewStore(storage);
    const key = reviewKey('host/repo', 'feature', 'file', true);
    const commit = 'a'.repeat(40);
    await store.setMany([{ key, fingerprint: sha256('approval'), commit, path: { source: 'file', destination: 'file' } }]);
    assert.equal(new ReviewStore(storage).get(key).commit, commit);
    assert.deepEqual(new ReviewStore(storage).paths()[key], { source: 'file', destination: 'file' });
    await storage.update('reviews.v1.paths', {}); // delayed Memento echo
    assert.deepEqual(store.paths()[key], { source: 'file', destination: 'file' });
    const remote = new Memory();
    await remote.update(REVIEW_SYNC_KEY, storage.get(REVIEW_SYNC_KEY));
    const synced = new ReviewStore(remote);
    assert.equal(synced.get(key).commit, commit);
    assert.deepEqual(synced.paths(), {});
    await store.setMany([{ key, fingerprint: sha256('legacy') }]);
    assert.equal(store.get(key).fingerprint, sha256('legacy'));
    assert.equal(store.get(key).commit, undefined);
    await store.setMany([{ key, fingerprint: sha256('invalid'), commit: '--output=oops' }]);
    assert.equal(store.get(key).commit, undefined);
    await store.setMany([{ key, fingerprint: null, commit }]);
    assert.equal(store.get(key).commit, undefined);
    assert.equal(store.paths()[key], undefined);
});

test('review diffs resolve immutable commits and distinguish absent literal paths from missing objects', async t => {
    const repo = await fixture(t);
    const commit = await resolveReviewCommit(repo, 'HEAD');
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(await reviewFileExists(repo, commit, path.join(repo.root, '*.txt')), true);
    assert.equal(await reviewFileExists(repo, commit, path.join(repo.root, '*')), false);
    assert.equal(await reviewFileExists(repo, commit, path.join(repo.root, 'new.txt')), false);
    await assert.rejects(resolveReviewCommit(repo, 'f'.repeat(40)));
    await assert.rejects(resolveReviewCommit(repo, '--output=oops'));
    await assert.rejects(reviewFileExists(repo, commit, path.join(repo.root, '../outside')));
    await repo.exec(['rm', '--', 'ordinary.txt']);
    await repo.exec(['commit', '-m', 'Delete']);
    assert.equal(await reviewFileExists(repo, commit, path.join(repo.root, 'ordinary.txt')), true);
    assert.equal(await reviewFileExists(repo, await resolveReviewCommit(repo, 'HEAD'), path.join(repo.root, 'ordinary.txt')), false);
});

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtc-review-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
        GIT_CONFIG_KEY_1: 'commit.gpgSign', GIT_CONFIG_VALUE_1: 'false',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS']) delete env[key];
    const repo = {
        root,
        exec(args, options = {}) {
            return new Promise((resolve, reject) => {
                const child = execFile('git', args, { cwd: root, env, encoding: 'utf8' }, (error, stdout, stderr) => {
                    if (error) reject(error); else resolve({ stdout, stderr });
                });
                child.stdin.end(options.input);
            });
        },
        stream(args) { return spawn('git', args, { cwd: root, env }); },
    };
    await repo.exec(['init', '-b', 'main']);
    await fs.writeFile(path.join(root, '*.txt'), Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(path.join(root, 'ordinary.txt'), 'base\n');
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Base']);
    return repo;
}

function entry(repo, name, src = name, submodule = false) {
    return { srcAbsPath: path.join(repo.root, src), dstAbsPath: path.join(repo.root, name), status: 'M', isSubmodule: submodule };
}

test('fingerprints use actual bytes on both sides, not timestamps or unrelated commits; filenames are literal', async t => {
    const repo = await fixture(t), fingerprinter = new ReviewFingerprinter(repo);
    const base = await fingerprinter.resolve('HEAD');
    const file = entry(repo, '*.txt');
    const original = await fingerprinter.fingerprint(file, base, null, true);
    assert.equal(await fingerprinter.fingerprint(file, base, base, true), original);
    await fs.utimes(file.dstAbsPath, new Date(), new Date(Date.now() + 5000));
    assert.equal(await fingerprinter.fingerprint(file, base, null, true), original);
    const stats = await fs.stat(file.dstAbsPath);
    await fs.writeFile(file.dstAbsPath, Buffer.from([0, 9, 2, 255]));
    await fs.utimes(file.dstAbsPath, stats.atime, stats.mtime);
    assert.notEqual(await fingerprinter.fingerprint(file, base, null, true), original);
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Change']);
    const changed = await fingerprinter.resolve('HEAD');
    const reviewed = await fingerprinter.fingerprint(file, base, null, true);
    assert.equal(await fingerprinter.fingerprint(file, base, changed, true), reviewed);
    assert.notEqual(await fingerprinter.fingerprint(file, changed, null, true), reviewed);
    await fs.writeFile(path.join(repo.root, 'ordinary.txt'), 'unrelated\n');
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Unrelated']);
    assert.equal(await fingerprinter.fingerprint(file, base, await fingerprinter.resolve('HEAD'), true), reviewed);
    await assert.rejects(fingerprinter.resolve('--output=bad'));
    await assert.rejects(fingerprinter.fingerprint(entry(repo, '../outside'), base, null, true));
});

test('fingerprints distinguish additions, deletions, renames, executable modes and symlink targets', async t => {
    const repo = await fixture(t), f = new ReviewFingerprinter(repo), base = await f.resolve('HEAD');
    const file = entry(repo, 'ordinary.txt');
    const original = await f.fingerprint(file, base, null, true);
    await fs.chmod(file.dstAbsPath, 0o755);
    assert.notEqual(await f.fingerprint(file, base, null, true), original);
    assert.equal(await f.fingerprint(file, base, null, false), original);
    await fs.rename(file.dstAbsPath, path.join(repo.root, 'renamed.txt'));
    assert.notEqual(await f.fingerprint(entry(repo, 'renamed.txt', 'ordinary.txt'), base, null, true), original);
    assert.notEqual(await f.fingerprint(file, base, null, true), original);
    await fs.symlink('ordinary.txt', path.join(repo.root, 'link'));
    const link = entry(repo, 'link');
    const first = await f.fingerprint(link, base, null, true);
    await fs.unlink(link.dstAbsPath); await fs.symlink('renamed.txt', link.dstAbsPath);
    assert.notEqual(await f.fingerprint(link, base, null, true), first);
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Links']);
    assert.equal(await f.fingerprint(link, base, await f.resolve('HEAD'), true), await f.fingerprint(link, base, null, true));
});

test('Git attributes handle nested overrides, bare/true/false values, recursive paths and unusual filenames', async t => {
    const repo = await fixture(t);
    await fs.mkdir(path.join(repo.root, 'generated'));
    await fs.writeFile(path.join(repo.root, '.gitattributes'), 'generated/** linguist-generated=true\nvendor/** git-tree-compare-deemphasized\nnonrecursive/ linguist-generated\n');
    await fs.writeFile(path.join(repo.root, 'generated/.gitattributes'), 'manual.ts linguist-generated=false\nunset.ts -linguist-generated\n');
    const paths = ['generated/file.ts', 'generated/manual.ts', 'generated/unset.ts', 'vendor/code.ts', 'nonrecursive/file.ts', 'generated/with space\nand newline.ts', 'nested/file.lock'];
    assert.deepEqual([...await deemphasizedPaths(repo, paths, ['**/*.lock'], true)].sort(),
        ['nested/file.lock', 'generated/file.ts', 'generated/with space\nand newline.ts', 'vendor/code.ts'].sort());
    assert.deepEqual([...await deemphasizedPaths(repo, paths, [], false)], ['vendor/code.ts']);
});

test('rebasing and leaving a branch retain its last approved fingerprint', async t => {
    const repo = await fixture(t), f = new ReviewFingerprinter(repo);
    const store = new ReviewStore(new Memory());
    const key = reviewKey('host/repo', 'feature', 'ordinary.txt', true);
    await repo.exec(['switch', '-c', 'feature']);
    const base = await f.resolve('main');
    await fs.writeFile(path.join(repo.root, 'ordinary.txt'), 'reviewed feature\n');
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Feature']);
    const file = entry(repo, 'ordinary.txt');
    const approved = await f.fingerprint(file, base, null, true);
    await store.setMany([{ key, fingerprint: approved }]);
    await repo.exec(['switch', 'main']);
    await fs.writeFile(path.join(repo.root, 'unrelated.txt'), 'new upstream commit\n');
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Upstream']);
    await repo.exec(['switch', 'feature']);
    await repo.exec(['rebase', 'main']);
    assert.equal(await f.fingerprint(file, await f.resolve('main'), null, true), approved);
    await fs.writeFile(file.dstAbsPath, 'changed after approval\n');
    assert.notEqual(await f.fingerprint(file, await f.resolve('main'), null, true), approved);
    await store.reconcile();
    assert.equal(store.get(key).fingerprint, approved, 'Revalidation must never replace the last approval');
    await fs.writeFile(file.dstAbsPath, 'reviewed feature\n');
    assert.equal(await f.fingerprint(file, await f.resolve('main'), null, true), store.get(key).fingerprint);
});

test('submodule reviews fingerprint commits and fail closed for dirty or uninitialized checkouts', async t => {
    const repo = await fixture(t), f = new ReviewFingerprinter(repo), base = await f.resolve('HEAD');
    const dir = path.join(repo.root, 'module');
    await fs.mkdir(dir);
    await repo.exec(['-C', dir, 'init', '-b', 'main']);
    await fs.writeFile(path.join(dir, 'code.txt'), 'module base\n');
    await repo.exec(['-C', dir, 'add', '.']); await repo.exec(['-C', dir, 'commit', '-m', 'Module']);
    await repo.exec(['add', 'module']); await repo.exec(['commit', '-m', 'Add module']);
    const file = entry(repo, 'module', 'module', true);
    const approved = await f.fingerprint(file, base, null, true);
    assert.equal(await f.fingerprint(file, base, await f.resolve('HEAD'), true), approved);
    await fs.writeFile(path.join(dir, 'code.txt'), 'dirty\n');
    await assert.rejects(f.fingerprint(file, base, null, true), /Commit submodule/);
    await repo.exec(['-C', dir, 'add', '.']); await repo.exec(['-C', dir, 'commit', '-m', 'Module update']);
    assert.notEqual(await f.fingerprint(file, base, null, true), approved);
    await fs.rm(path.join(dir, '.git'), { recursive: true, force: true });
    await assert.rejects(f.fingerprint(file, base, null, true), /not initialized/);
});

test('delayed Memento notifications cannot roll back an approval already observed by the host', async () => {
    const storage = new Memory(), store = new ReviewStore(storage);
    const key = reviewKey('/local/repo', 'feature', 'file', false);
    await store.setMany([{ key, fingerprint: sha256('old approval') }]);
    const olderNotification = storage.get('reviews.v1.local');
    await store.setMany([{ key, fingerprint: sha256('new approval') }]);
    await storage.update('reviews.v1.local', olderNotification);
    assert.equal(store.get(key).fingerprint, sha256('new approval'));
    await store.reconcile();
    assert.equal(new ReviewStore(storage).get(key).fingerprint, sha256('new approval'));
});

const { ReviewHistory, HISTORY_SYNC_KEY, historyScope } = require('../../out/reviewHistory');
const { ReviewNavigation } = require('../../out/reviewNavigation');

test('review history retains every checkpoint, deduplicates files, and merges synced devices without paths', async () => {
    const storage = new Memory(), other = new Memory();
    const history = new ReviewHistory(storage), remote = new ReviewHistory(other);
    const scope = historyScope('host/repo', 'feature', true);
    const key = reviewKey('host/repo', 'feature', 'secret/path', true);
    const first = { key, commit: 'a'.repeat(40), reviewedAt: 10 };
    await history.record(scope, [first, first]);
    await history.record(scope, [{ ...first, commit: 'b'.repeat(40), reviewedAt: 20 }]);
    assert.equal((await history.list(scope)).length, 2);
    assert.equal((await history.list(scope))[1].fileCount, 1);
    await other.update(HISTORY_SYNC_KEY, storage.get(HISTORY_SYNC_KEY));
    await remote.record(scope, [{ ...first, commit: 'c'.repeat(40), reviewedAt: 30 }]);
    await storage.update(HISTORY_SYNC_KEY, other.get(HISTORY_SYNC_KEY));
    assert.equal((await new ReviewHistory(storage).list(scope)).length, 3);
    await storage.update(HISTORY_SYNC_KEY, {}); // another device omits our imported history
    assert.equal((await new ReviewHistory(storage).list(scope)).length, 3, 'The local mirror retains imported checkpoints across restart');
    assert.deepEqual(await history.list(historyScope('host/repo', 'another', true)), []);
    const localScope = historyScope('/local/repo', 'feature', false);
    await history.record(localScope, [{ ...first, key: reviewKey('local', 'feature', 'file', false) }]);
    assert.equal(storage.get(HISTORY_SYNC_KEY)[localScope], undefined);
    assert.ok(!JSON.stringify(storage.get(HISTORY_SYNC_KEY)).includes('secret/path'));
    await history.record(scope, [{ ...first, commit: '--output=bad' }]);
    assert.equal((await history.list(scope)).length, 3);
});

test('content approvals ignore the selected base but detect byte, mode and path changes', async t => {
    const repo = await fixture(t), fp = new ReviewFingerprinter(repo), file = entry(repo, 'ordinary.txt');
    const base = await fp.resolve('HEAD');
    await fs.writeFile(file.dstAbsPath, 'new version\n');
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'New version']);
    const head = await fp.resolve('HEAD');
    const approved = await fp.fingerprint(file, base, null, true, true);
    assert.equal(await fp.fingerprint(file, head, null, true, true), approved);
    assert.equal(await fp.fingerprint(file, base, head, true, true), approved);
    await fs.writeFile(file.dstAbsPath, 'changed again\n');
    assert.notEqual(await fp.fingerprint(file, base, null, true, true), approved);
});

test('navigation uses bounded metadata queries, distinguishes branch tips, and retains unavailable checkpoints', async t => {
    const repo = await fixture(t);
    const base = await resolveReviewCommit(repo, 'HEAD');
    await repo.exec(['update-ref', 'refs/remotes/origin/main', base]);
    await repo.exec(['checkout', '-b', 'feature']);
    await fs.writeFile(path.join(repo.root, 'new.txt'), 'one\n');
    await repo.exec(['add', '.']); await repo.exec(['commit', '-m', 'Follow-up']);
    const head = await resolveReviewCommit(repo, 'HEAD');
    const calls = [], original = repo.exec.bind(repo);
    repo.exec = (...args) => { calls.push(args[0]); return original(...args); };
    const navigation = new ReviewNavigation(repo);
    const context = { key: 'one', repoRoot: repo.root, scope: 'scope', head, branch: 'feature', target: 'origin/main' };
    const [one, two] = await Promise.all([navigation.bases(context, 'refs'), navigation.bases(context, 'refs')]);
    assert.equal(one, two, 'Concurrent callers share the same in-flight query');
    assert.equal(calls.filter(args => args[0] === 'merge-base').length, 1);
    assert.equal(one.mergeBase, base);
    assert.ok(one.candidates.some(c => c.label === 'origin/main' && c.commit === base));
    assert.ok(one.candidates.some(c => c.label === 'main' && c.commit === base));
    const before = calls.length;
    assert.equal((await navigation.commits(base, head, 0))[0].label, 'Follow-up');
    await navigation.commits(base, head, 0);
    assert.equal(calls.length, before + 1, 'Re-rendering a page does not repeat git log');
    const log = calls.find(args => args[0] === 'log');
    assert.ok(log.includes('--max-count=101'));
    assert.ok(!log.includes('--numstat'));
    const records = [{ commit: head, reviewedAt: 20, fileCount: 2 }, { commit: 'f'.repeat(40), reviewedAt: 10, fileCount: 1 }];
    const checkpoints = await navigation.checkpoints(records);
    assert.equal(checkpoints[0].available, true);
    assert.equal(checkpoints[1].available, false);
    assert.equal(calls.filter(args => args[0] === 'cat-file').length, 1, 'One batch checks all visible checkpoints');
});

test('large review history imports yield to the event loop', async () => {
    const storage = new Memory(), scope = historyScope('host/repo', 'feature', true);
    const files = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [reviewKey('host/repo', 'feature', `file-${i}`, true), i]));
    await storage.update(HISTORY_SYNC_KEY, { [scope]: { ['a'.repeat(40)]: files } });
    let responsive = false;
    setImmediate(() => { responsive = true; });
    const checkpoints = await new ReviewHistory(storage).list(scope);
    assert.equal(responsive, true, 'The extension host handles other callbacks during history imports');
    assert.equal(checkpoints[0].fileCount, 2000);
});

test('PR history pages return bounded contiguous metadata without dropping older commits', async t => {
    const repo = await fixture(t);
    const base = await resolveReviewCommit(repo, 'HEAD');
    const tree = (await repo.exec(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    let head = base;
    for (let i = 0; i < 110; i++) {
        head = (await repo.exec(['commit-tree', tree, '-p', head], { input: `Follow-up ${i}\n` })).stdout.trim();
    }
    const navigation = new ReviewNavigation(repo);
    const first = await navigation.commits(base, head, 0);
    const next = await navigation.commits(base, head, 100);
    assert.equal(first.length, 101, 'One lookahead row indicates another page');
    assert.equal(next.length, 10);
    assert.equal(first[0].label, 'Follow-up 109');
    assert.equal(next[0].label, 'Follow-up 9');
    assert.equal(new Set([...first.slice(0, 100), ...next].map(c => c.commit)).size, 110);
});


test('repository reset boundaries survive stale sync snapshots, cover every branch and allow new approvals', async () => {
    const storage = new Memory(), store = new ReviewStore(storage);
    const scope = 's:' + sha256('repo'), otherScope = 's:' + sha256('other');
    const a = reviewKey('repo', 'old-deleted-branch', 'a', true), b = reviewKey('repo', 'current', 'b', true);
    const other = reviewKey('other', 'current', 'b', true);
    await store.setMany([a, b, other].map(key => ({ key, fingerprint: sha256(key), commit: 'a'.repeat(40) })));
    const old = storage.get(REVIEW_SYNC_KEY);
    await store.clearScope(scope);
    assert.equal(store.get(a, scope), undefined);
    assert.equal(store.get(b, scope), undefined);
    assert.ok(store.get(other, otherScope)?.commit);
    await storage.update(REVIEW_SYNC_KEY, old);
    await storage.update(REVIEW_RESETS_KEY, {});
    const restarted = new ReviewStore(storage);
    await restarted.reconcile();
    assert.equal(restarted.get(a, scope), undefined);
    await assert.rejects(restarted.setMany([{ key: b, fingerprint: sha256('queued before reset') }], scope, 0), /reset/);
    await restarted.setMany([{ key: b, fingerprint: sha256('new review'), commit: 'b'.repeat(40) }], scope, restarted.resetBefore(scope));
    assert.equal(restarted.get(b, scope).commit, 'b'.repeat(40));
    const device = new Memory();
    await device.update(REVIEW_SYNC_KEY, storage.get(REVIEW_SYNC_KEY));
    await device.update(REVIEW_RESETS_KEY, storage.get(REVIEW_RESETS_KEY));
    const remote = new ReviewStore(device);
    assert.equal(remote.get(a, scope), undefined);
    assert.equal(remote.get(b, scope).commit, 'b'.repeat(40));
    const { ReviewHistory } = require('../../out/reviewHistory');
    const history = new ReviewHistory(storage);
    const cutoff = restarted.resetBefore(scope);
    await history.record(scope, [{key: a, commit: 'a'.repeat(40), reviewedAt: cutoff - 1}, {key: b, commit: 'b'.repeat(40), reviewedAt: cutoff + 1}]);
    assert.deepEqual((await history.list(scope, cutoff)).map(c => c.commit), ['b'.repeat(40)]);
});
