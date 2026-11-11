const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readFileStats, MAX_STATS_BYTES } = require('../../out/fileStats');
const { validateRevision } = require('../../out/gitSafety');

test('revision validation rejects options, control characters and empty input', () => {
    for (const ref of ['', '--output=/tmp/file', '-n1', 'HEAD\n--all', 'a\0b', 'a b']) {
        assert.throws(() => validateRevision(ref));
    }
    for (const ref of ['HEAD', 'HEAD~2', 'main^{commit}', 'origin/feature']) validateRevision(ref);
});

test('statistics handle text and binary data without reading symlinks or oversized files', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtc-stats-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'file');
    for (const [text, lines] of [['', 0], ['one\n', 1], ['one\ntwo', 2], ['\n\n', 2]]) {
        await fs.writeFile(file, text);
        assert.deepEqual(await readFileStats(file), { insertions: lines, deletions: 0, isBinary: false });
    }
    await fs.writeFile(file, Buffer.from([0, 1, 2]));
    assert.equal((await readFileStats(file)).isBinary, true);
    await fs.symlink(file, path.join(dir, 'link'));
    assert.equal(await readFileStats(path.join(dir, 'link')), undefined);
    await fs.writeFile(file, Buffer.alloc(MAX_STATS_BYTES + 1));
    assert.equal(await readFileStats(file), undefined);
    assert.equal(await readFileStats(dir), undefined);
    assert.equal(await readFileStats(path.join(dir, 'missing')), undefined);
});
