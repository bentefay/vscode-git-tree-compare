import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Repository } from './git/git';
import type { IDiffStatus } from './gitHelper';
import { sha256 } from './reviewState';

interface Side { path: string; mode: string; kind: string; contentHash: string; }
interface TreeEntry { mode: string; object: string; }
const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export async function boundedMap<T, R>(values: T[], action: (value: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(values.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
        while (next < values.length) { const index = next++; results[index] = await action(values[index]); }
    }));
    return results;
}

function sameStat(a: fs.Stats, b: fs.Stats): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
        a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Fingerprint actual bytes without invoking repository-configured textconv/clean filters. */
export class ReviewFingerprinter {
    private blobs = new Map<string, string>();
    constructor(private readonly repository: Repository) {}

    async resolve(ref: string): Promise<string> {
        const { stdout } = await this.repository.exec(['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`], { log: false });
        const tree = stdout.trim();
        if (!objectId.test(tree)) { throw new Error('Invalid comparison tree'); }
        return tree;
    }

    private async entry(tree: string, file: string): Promise<TreeEntry | undefined> {
        if (!objectId.test(tree)) { throw new Error('Expected a resolved tree'); }
        const { stdout } = await this.repository.exec(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', file], { log: false });
        if (!stdout) { return undefined; }
        const match = /^(\d+) \w+ ([a-f0-9]+)\t/.exec(stdout);
        if (!match || !objectId.test(match[2])) { throw new Error('Invalid tree entry'); }
        return { mode: match[1], object: match[2] };
    }

    private async blobHash(object: string): Promise<string> {
        const cached = this.blobs.get(object);
        if (cached) { return cached; }
        if (!objectId.test(object)) { throw new Error('Invalid blob'); }
        const child = this.repository.stream(['cat-file', 'blob', object]);
        const hash = createHash('sha256');
        child.stderr?.resume();
        const completion = new Promise<void>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error('Cannot read Git blob')));
            child.stdout!.on('error', reject);
            child.stdout!.on('data', chunk => hash.update(chunk));
        });
        await completion;
        const result = hash.digest('hex');
        if (this.blobs.size >= 2048) { this.blobs.delete(this.blobs.keys().next().value!); }
        this.blobs.set(object, result);
        return result;
    }

    private async treeSide(tree: string, file: string): Promise<Side | null> {
        const entry = await this.entry(tree, file);
        if (!entry) { return null; }
        const { mode, object } = entry;
        const kind = mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
        if (!['100644', '100755', '120000', '160000'].includes(mode)) { throw new Error('Unsupported file kind'); }
        return { path: file, mode, kind, contentHash: kind === 'submodule' ? sha256(object) : await this.blobHash(object) };
    }

    private async worktreeSide(file: string, submodule: boolean, fileMode: boolean): Promise<Side | null> {
        const absolute = path.join(this.repository.root, file);
        let before: fs.Stats;
        try { before = await fs.promises.lstat(absolute); }
        catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { return null; } throw e; }
        let mode: string, kind: string, contentHash: string;
        if (before.isSymbolicLink()) {
            mode = '120000'; kind = 'symlink';
            contentHash = sha256(await fs.promises.readlink(absolute, { encoding: 'buffer' }));
        } else if (submodule && before.isDirectory()) {
            mode = '160000'; kind = 'submodule';
            const top = await this.repository.exec(['-C', absolute, 'rev-parse', '--show-toplevel'], { log: false });
            if (await fs.promises.realpath(top.stdout.trim()) !== await fs.promises.realpath(absolute)) {
                throw new Error('Submodule is not initialized');
            }
            const status = await this.repository.exec(['-C', absolute, 'status', '--porcelain', '--untracked-files=normal'], { log: false });
            if (status.stdout) { throw new Error('Commit submodule changes before marking them reviewed'); }
            const { stdout } = await this.repository.exec(['-C', absolute, 'rev-parse', '--verify', 'HEAD'], { log: false });
            if (!objectId.test(stdout.trim())) { throw new Error('Cannot read submodule HEAD'); }
            contentHash = sha256(stdout.trim());
        } else if (before.isFile()) {
            mode = (before.mode & 0o111) !== 0 ? '100755' : '100644'; kind = 'file';
            if (!fileMode) {
                const { stdout } = await this.repository.exec(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', file], { log: false });
                mode = /^(100644|100755) /.exec(stdout)?.[1] ?? '100644';
            }
            const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
            try {
                if (!sameStat(before, await handle.stat())) { throw new Error('File changed while opening'); }
                const hash = createHash('sha256');
                const buffer = Buffer.allocUnsafe(64 * 1024);
                // Bound the read to the initial size so a growing log cannot
                // keep this task alive indefinitely. The final stat rejects it.
                let remaining = before.size;
                while (remaining > 0) {
                    const count = (await handle.read(buffer, 0, Math.min(buffer.length, remaining), null)).bytesRead;
                    if (!count) { throw new Error('File truncated while hashing'); }
                    hash.update(buffer.subarray(0, count));
                    remaining -= count;
                }
                if (!sameStat(before, await handle.stat())) { throw new Error('File changed while hashing'); }
                contentHash = hash.digest('hex');
            } finally { await handle.close(); }
        } else { throw new Error('Cannot review a special file'); }
        if (!sameStat(before, await fs.promises.lstat(absolute))) { throw new Error('File replaced while hashing'); }
        return { path: file, mode, kind, contentHash };
    }

    async fingerprint(file: IDiffStatus, leftTree: string, rightTree: string | null, fileMode: boolean): Promise<string> {
        const relative = (absolute: string) => {
            const rel = path.relative(this.repository.root, absolute).split(path.sep).join('/');
            if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) { throw new Error('Path outside repository'); }
            return rel;
        };
        const before = await this.treeSide(leftTree, relative(file.srcAbsPath));
        const after = rightTree === null
            ? await this.worktreeSide(relative(file.dstAbsPath), file.isSubmodule, fileMode)
            : await this.treeSide(rightTree, relative(file.dstAbsPath));
        return sha256(JSON.stringify({ version: 1, before, after }));
    }
}
