'use strict';

// Shared by the CLI and the extension's worker. No VS Code or model dependency.
const fs = require('node:fs/promises');
const format = require('./enrichment-format.cjs');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const execute = promisify(execFile);
const LIMIT = 2 * 1024 * 1024;
const MAX_FILES = 2000;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[a-f0-9]{64}$/;
const KINDS = ['behaviour', 'plumbing', 'tests', 'docs', 'formatting', 'whitespace', 'dependencies', 'generated', 'other'];
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function fail(message) { throw new Error(message); }
function relative(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[\\\x00-\x1f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) fail(`Invalid repository-relative path: ${JSON.stringify(value)}`);
    return value;
}
async function git(repo, args, maxBuffer = 32 * 1024 * 1024) {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG.*)$/.test(key)) delete env[key];
    const { stdout } = await execute('git', ['--literal-pathspecs', '-C', repo, ...args], {
        encoding: 'buffer', maxBuffer, timeout: 30000,
        env,
    });
    return stdout;
}
async function text(repo, args) { return (await git(repo, args)).toString('utf8').trim(); }
async function resolve(repo, ref) {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\x00-\x1f]/.test(ref)) fail('Invalid revision');
    const value = await text(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (!SHA.test(value)) fail('Revision did not resolve to a commit');
    return value;
}
async function location(repo) {
    const root = await fs.realpath(await text(path.resolve(repo), ['rev-parse', '--show-toplevel']));
    const gitDir = await fs.realpath(await text(root, ['rev-parse', '--absolute-git-dir']));
    return { root, gitDir, directory: path.join(gitDir, 'git-tree-compare', 'enrichment', 'v1') };
}
async function identity(root) {
    const head = await resolve(root, 'HEAD');
    let branch;
    try { branch = await text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
    catch (error) { if (error.code !== 1) throw error; branch = `detached:${head}`; }
    return { branch, head };
}
async function bounded(values, fn) {
    const results = new Array(values.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
        while (next < values.length) { const i = next++; results[i] = await fn(values[i], i); }
    }));
    return results;
}
async function secureDirectory(loc, sub = '') {
    let directory = loc.gitDir;
    for (const part of ['git-tree-compare', 'enrichment', 'v1', ...(sub ? [sub] : [])]) {
        directory = path.join(directory, part);
        await fs.mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Enrichment storage must not be a symbolic link');
    }
    return directory;
}
async function atomic(loc, name, value, sub = '') {
    const directory = await secureDirectory(loc, sub);
    const output = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(output) > LIMIT) fail('Enrichment document exceeds 2 MiB');
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, output, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, path.join(directory, name)); }
    finally { await fs.rm(temporary, { force: true }); }
}
async function readBounded(handle, size) {
    const buffer = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
    }
    if (total !== size) fail('File changed while reading');
    return buffer.subarray(0, total);
}
async function readJSON(filename) {
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > LIMIT) fail('Expected a regular JSON file of at most 2 MiB');
        const buffer = await readBounded(file, stat.size);
        return JSON.parse(buffer.toString('utf8'));
    } finally { await file.close(); }
}
async function readStored(loc, name, sub = '') {
    // Reject redirected parent folders too, even for reads.
    for (const directory of [path.dirname(path.dirname(loc.directory)), path.dirname(loc.directory), loc.directory, ...(sub ? [path.join(loc.directory, sub)] : [])]) {
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Invalid enrichment storage directory');
    }
    return readJSON(path.join(loc.directory, sub, name));
}
async function tree(root, ref) {
    const entries = new Map();
    for (const record of (await git(root, ['ls-tree', '-r', '-z', ref])).toString('utf8').split('\0')) {
        if (!record) continue;
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
        if (!match || !SHA.test(match[3])) fail('Invalid Git tree entry');
        entries.set(match[4], { mode: match[1], object: match[3] });
    }
    return entries;
}
async function paths(root, left, right) {
    const parts = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', left, ...(right ? [right] : []), '--'])).toString('utf8').split('\0');
    const result = new Map();
    for (let i = 0; i < parts.length - 1;) {
        const status = parts[i++], source = relative(parts[i++]);
        const destination = /^[RC]/.test(status) ? relative(parts[i++]) : source;
        result.set(destination, { path: destination, source, status: status[0] });
    }
    if (!right) for (const file of (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0').filter(Boolean)) {
        result.set(relative(file), { path: file, source: file, status: 'U' });
    }
    return [...result.values()];
}
async function workingSide(root, file) {
    const full = path.join(root, relative(file));
    let parent;
    try { parent = await fs.realpath(path.dirname(full)); }
    catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
    if (parent !== root && !parent.startsWith(root + path.sep)) fail(`Path leaves the checkout: ${file}`);
    let stat;
    try { stat = await fs.lstat(full); }
    catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink()) return { mode: stat.isSymbolicLink() ? '120000' : '160000', unsupported: 'symlink or submodule' };
    const mode = stat.mode & 0o111 ? '100755' : '100644';
    if (stat.size > LIMIT) return { mode, unsupported: 'file exceeds 2 MiB' };
    const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        const start = await handle.stat();
        if (!start.isFile() || start.size > LIMIT) fail('File changed while capturing context');
        const bytes = await readBounded(handle, start.size);
        const end = await handle.stat();
        if (start.ino !== end.ino || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs) fail('File changed while capturing context');
        const binary = bytes.includes(0);
        return { mode, hash: hash(bytes), lines: binary ? 0 : bytes.toString('utf8').split('\n').length, ...(binary ? { unsupported: 'binary file' } : {}) };
    } finally { await handle.close(); }
}
function checkSelection(selection) {
    if (!selection || typeof selection !== 'object' || typeof selection.left !== 'string' || !(selection.right === null || typeof selection.right === 'string')) fail('Invalid comparison selection');
    if (selection.files !== undefined) {
        if (!Array.isArray(selection.files) || selection.files.length > MAX_FILES) fail('Comparison exceeds 2000 files');
        const unique = new Set();
        for (const f of selection.files) { relative(f.path); relative(f.source); if (unique.has(f.path)) fail('Duplicate comparison path'); unique.add(f.path); }
    }
}
async function saveSelection(repo, selection, expectedHead) {
    checkSelection(selection);
    const loc = await location(repo);
    const state = await identity(loc.root);
    if (expectedHead && state.head !== expectedHead) fail('HEAD changed before the editor selection could be exported');
    await secureDirectory(loc, 'current');
    await atomic(loc, 'selection.json', { ...selection, ...state });
}
async function capture(repo, selection) {
    const loc = await location(repo), start = await identity(loc.root);
    if (!selection) {
        selection = await readStored(loc, 'selection.json').catch(e => { if (e.code === 'ENOENT') fail('No editor comparison exported. Use --base REF (and optionally --right REF).'); throw e; });
        if (selection.branch !== start.branch || selection.head !== start.head) fail('The exported comparison is from another revision. Refresh Git Tree Compare or pass --base.');
    }
    checkSelection(selection);
    const left = await resolve(loc.root, selection.left), right = selection.right === null ? null : await resolve(loc.root, selection.right);
    const chosen = selection.files ?? await paths(loc.root, left, right);
    if (chosen.length > MAX_FILES) fail('Comparison exceeds 2000 files');
    const [before, after] = await Promise.all([tree(loc.root, left), right ? tree(loc.root, right) : undefined]);
    const files = await bounded(chosen, async f => {
        const source = relative(f.source), destination = relative(f.path);
        const a = before.get(source) ?? null;
        const b = right ? after.get(destination) ?? null : await workingSide(loc.root, destination);
        const unsupported = a && !['100644', '100755'].includes(a.mode) || b && (!['100644', '100755'].includes(b.mode) || b.unsupported);
        return { path: destination, source, status: f.status ?? 'M', before: a, after: b,
            fingerprint: hash([source, destination, a, b]), ...(unsupported ? { unsupported: 'Binary, oversized or non-regular files support file summaries only.' } : {}) };
    });
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const end = await identity(loc.root);
    if (JSON.stringify(start) !== JSON.stringify(end)) fail('HEAD changed while capturing context');
    const inventory = hash((await paths(loc.root, left, right)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const body = { version: 1, repo: loc.root, ...start, left, right, inventory, files };
    return { ...body, id: hash(body) };
}
async function context(repo, selection) {
    const snapshot = await capture(repo, selection);
    await atomic(await location(repo), `${snapshot.id}.json`, snapshot, 'snapshots');
    return snapshot;
}
function object(value, allowed, where) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where}: expected an object`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}: unknown field ${key}`);
}
function string(value, max, where) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${where}: expected nonempty text, at most ${max} characters`); }
function array(value, max, where) { if (!Array.isArray(value) || value.length > max) fail(`${where}: expected an array of at most ${max} entries`); }
function validate(data, snapshot) {
    if (data?.version === 2) return format.validate(data, snapshot);
    object(data, ['version', 'snapshotId', 'producer', 'summary', 'files', 'guide'], 'result');
    if (data.version !== 1 || !ID.test(data.snapshotId) || data.snapshotId !== snapshot.id) fail('Expected version 1 and the exported snapshotId');
    string(data.producer, 100, 'producer'); string(data.summary, 6000, 'summary');
    array(data.files, MAX_FILES, 'files'); array(data.guide, 100, 'guide');
    const known = new Map(snapshot.files.map(f => [f.path, f])), seen = new Set(); let notes = 0;
    for (const [i, file] of data.files.entries()) {
        const field = `files[${i}]`;
        object(file, ['path', 'priority', 'kind', 'reason', 'annotations'], field);
        relative(file.path);
        if (!known.has(file.path) || seen.has(file.path)) fail(`${field}.path: must be a unique path in the exported comparison`);
        seen.add(file.path);
        if (!['normal', 'important'].includes(file.priority) || !KINDS.includes(file.kind)) fail(`${field}: invalid priority or kind`);
        string(file.reason, 2000, `${field}.reason`); array(file.annotations, 20, `${field}.annotations`);
        notes += file.annotations.length;
        if (notes > 200) fail('At most 200 annotations per result');
        for (const note of file.annotations) {
            object(note, ['side', 'startLine', 'endLine', 'title', 'body', 'scope'], `${field}.annotation`);
            if (!['before', 'after'].includes(note.side) || !Number.isSafeInteger(note.startLine) || !Number.isSafeInteger(note.endLine) || note.startLine < 1 || note.endLine < note.startLine || note.endLine > 1000000) fail(`${field}: invalid 1-based annotation range`);
            if (note.scope !== undefined && !['file', 'comparison'].includes(note.scope)) fail(`${field}: scope must be file or comparison`);
            if (!known.get(file.path)[note.side] || known.get(file.path).unsupported) fail(`${field}: annotations require an existing regular text side`);
            string(note.title, 200, `${field}.title`); string(note.body, 6000, `${field}.body`);
        }
    }
    for (const [i, step] of data.guide.entries()) {
        object(step, ['path', 'title', 'description', 'annotation'], `guide[${i}]`);
        if (!seen.has(step.path)) fail(`guide[${i}]: path must have a file entry`);
        string(step.title, 200, `guide[${i}].title`); string(step.description, 2000, `guide[${i}].description`);
        if (step.annotation !== undefined && (!Number.isSafeInteger(step.annotation) || step.annotation < 0 || step.annotation >= data.files.find(f => f.path === step.path).annotations.length)) fail(`guide[${i}]: invalid zero-based annotation index`);
    }
    return data;
}
async function sideBytes(snapshot, file, side) {
    const value = file[side];
    if (!value || value.unsupported || !['100644', '100755'].includes(value.mode)) fail(`Unsupported ${side} side of ${file.path}`);
    if (value.object && !SHA.test(value.object)) fail('Invalid blob ID');
    if (value.object) return git(snapshot.repo, ['cat-file', 'blob', value.object], LIMIT);
    const full = path.join(snapshot.repo, relative(file.path));
    // workingSide verifies parent paths, no-follow reads, and stability.
    const current = await workingSide(snapshot.repo, file.path);
    if (JSON.stringify(current) !== JSON.stringify(value)) fail(`File changed: ${file.path}`);
    const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > LIMIT) fail('Invalid file');
        const result = await readBounded(handle, stat.size);
        if (hash(result) !== value.hash) fail(`File changed: ${file.path}`);
        return result;
    } finally { await handle.close(); }
}
async function validateContent(data, snapshot) {
    data = format.normalize(data);
    const byPath = new Map(snapshot.files.map(f => [f.path, f]));
    const ranges = new Map();
    for (const link of format.links(data)) if (link.range) {
        if (!ranges.has(link.path)) ranges.set(link.path, []);
        ranges.get(link.path).push(link.range);
    }
    await bounded(data.files, async file => {
        const source = byPath.get(file.path), cache = new Map();
        const bytes = async side => { if (!cache.has(side)) cache.set(side, await sideBytes(snapshot, source, side)); return cache.get(side); };
        for (const note of [...file.annotations, ...(ranges.get(file.path) || [])]) {
            const content = await bytes(note.side);
            if (content.includes(0) || note.endLine > content.toString('utf8').split('\n').length) fail(`Annotation is outside the text in ${file.path}`);
        }
        if (file.labels.includes('whitespace')) {
            const a = source.before ? await bytes('before') : Buffer.alloc(0), b = source.after ? await bytes('after') : Buffer.alloc(0);
            if (a.includes(0) || b.includes(0) || !source.before || !source.after || source.before.mode !== source.after.mode || a.equals(b) || a.toString('utf8').replace(/\s/g, '') !== b.toString('utf8').replace(/\s/g, '')) fail(`Whitespace label is not supported by the actual diff: ${file.path}`);
        }
    });
}
async function getSnapshot(loc, id) {
    if (!ID.test(id)) fail('Invalid snapshot ID');
    const snapshot = await readStored(loc, `${id}.json`, 'snapshots');
    const { id: storedId, ...body } = snapshot;
    if (storedId !== id || hash(body) !== id || snapshot.repo !== loc.root) fail('Snapshot identity does not match this checkout');
    checkSelection({ left: snapshot.left, right: snapshot.right, files: snapshot.files });
    return snapshot;
}
const scopeKey = snapshot => hash([snapshot.branch, snapshot.left, snapshot.right]);
async function validateFile(repo, filename) {
    const loc = await location(repo), data = await readJSON(filename);
    const snapshot = await getSnapshot(loc, data.snapshotId);
    validate(data, snapshot); await validateContent(data, snapshot);
    const current = await capture(repo, { left: snapshot.left, right: snapshot.right, files: snapshot.files });
    if (current.id !== snapshot.id) fail('Comparison changed since capture. Export a new context and enrich it again.');
    return { data, snapshot };
}
async function publish(repo, filename) {
    const { data, snapshot } = await validateFile(repo, filename), loc = await location(repo);
    const run = { data, snapshotId: snapshot.id, publishedAt: Date.now() };
    // Immutable completed runs survive branch switches and subsequent publications.
    const id = hash(run);
    await atomic(loc, `${id}.json`, run, 'runs');
    await atomic(loc, `${scopeKey(snapshot)}.json`, { run: id }, 'current');
    return { snapshotId: snapshot.id, file: path.join(loc.directory, 'current', `${scopeKey(snapshot)}.json`) };
}
async function load(repo, selection) {
    const loc = await location(repo), state = await identity(loc.root);
    const left = await resolve(loc.root, selection.left), right = selection.right === null ? null : await resolve(loc.root, selection.right);
    const key = scopeKey({ ...state, left, right });
    let pointer;
    try { pointer = await readStored(loc, `${key}.json`, 'current'); }
    catch (e) { if (e.code === 'ENOENT') return { directory: loc.directory, current: true, fresh: [], data: null, snapshot: null }; throw e; }
    if (!ID.test(pointer.run)) fail('Invalid enrichment publication');
    const run = await readStored(loc, `${pointer.run}.json`, 'runs');
    const snapshot = await getSnapshot(loc, run.snapshotId);
    if (hash(run) !== pointer.run || scopeKey(snapshot) !== key) fail('Publication identity mismatch');
    validate(run.data, snapshot);
    // Revalidate external files, including hand-written or edited publications.
    // Range bounds against immutable blob IDs are checked by publication; rendering
    // additionally checks the actual open document before creating a thread.
    const now = await capture(repo, { ...selection, left, right });
    const oldFiles = new Map(snapshot.files.map(f => [f.path, f]));
    const fresh = now.files.filter(f => oldFiles.get(f.path)?.fingerprint === f.fingerprint && !oldFiles.get(f.path)?.unsupported).map(f => f.path);
    return { directory: loc.directory, publicationId: pointer.run, current: snapshot.id === now.id, fresh, data: format.normalize(run.data), snapshot };
}

async function clear(repo) {
    const loc = await location(repo);
    await secureDirectory(loc); // Reject redirects before deleting only our own storage.
    await fs.rm(loc.directory, { recursive: true, force: true });
}

module.exports = { clear, KINDS, LIMIT, hash, relative, location, saveSelection, capture, context, validate, validateFile, publish, load, readJSON };
