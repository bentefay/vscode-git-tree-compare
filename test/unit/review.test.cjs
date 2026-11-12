const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { ReviewStore, REVIEW_SYNC_KEY, remoteIdentity, reviewKey, sha256 } = require('../../out/reviewState');
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
    assert.deepEqual(one.syncKeys, [REVIEW_SYNC_KEY]);
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
