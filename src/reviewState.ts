import { createHash, randomUUID } from 'crypto';

export const REVIEW_SYNC_KEY = 'reviews.v1';
const LOCAL_KEY = 'reviews.v1.local';
const PATHS_KEY = 'reviews.v1.paths';
interface Storage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
    setKeysForSync?(keys: readonly string[]): void;
}
export interface ReviewRecord {
    fingerprint: string | null;
    commit?: string;
    updatedAt: number;
    writer: string;
}
export interface ReviewPath { source: string; destination: string; }
export interface ReviewUpdate { key: string; fingerprint: string | null; commit?: string; path?: ReviewPath; }
export const isCommitId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
function validPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !/[\\\0]/.test(value) &&
        !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.split('/').some(part => part === '..' || part === '.' || part === '');
}
type Records = Record<string, ReviewRecord>;
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** No credentials, transport differences or local checkout paths in synced identities. */
export function remoteIdentity(remote: string): string | undefined {
    let value = remote.trim();
    if (!value.includes('://')) {
        const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
        if (!scp || /^[a-z]:[\\/]/i.test(value)) { return undefined; }
        value = `ssh://${scp[1]}/${scp[2]}`;
    }
    try {
        const url = new URL(value);
        if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol)) { return undefined; }
        let pathname = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
        if (!pathname) { return undefined; }
        if (url.hostname === 'github.com') { pathname = pathname.toLowerCase(); }
        // Standard SSH and HTTPS endpoints describe the same repository.
        const port = url.port && !['22', '443', '80', '9418'].includes(url.port) ? `:${url.port}` : '';
        return `${url.hostname.toLowerCase()}${port}/${pathname}`;
    } catch { return undefined; }
}

export function reviewKey(identity: string, branch: string, relativePath: string, synced: boolean): string {
    return (synced ? 's:' : 'l:') + sha256(JSON.stringify([identity, branch, relativePath]));
}

function validRecords(value: unknown): Records {
    const result: Records = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return result; }
    for (const [key, record] of Object.entries(value)) {
        if (!/^[sl]:[a-f0-9]{64}$/.test(key) || !record || typeof record !== 'object') { continue; }
        const r = record as ReviewRecord;
        if ((r.fingerprint === null || /^[a-f0-9]{64}$/.test(r.fingerprint)) &&
            Number.isSafeInteger(r.updatedAt) && r.updatedAt >= 0 && typeof r.writer === 'string') {
            result[key] = { fingerprint: r.fingerprint, updatedAt: r.updatedAt, writer: r.writer };
            if (r.fingerprint && isCommitId(r.commit)) { result[key].commit = r.commit; }
        }
    }
    return result;
}

/** Per-record last-write-wins merge, including uncheck tombstones. */
export function mergeReviews(...sources: unknown[]): Records {
    const result: Records = {};
    for (const source of sources) {
        for (const [key, value] of Object.entries(validRecords(source))) {
            const old = result[key];
            if (!old || value.updatedAt > old.updatedAt ||
                (value.updatedAt === old.updatedAt && value.writer > old.writer)) {
                result[key] = value;
            }
        }
    }
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

/** The local mirror preserves records omitted by another device's sync snapshot.
 * Only opaque keys, fingerprints, commit IDs and merge metadata travel through Sync.
 * Memento has no public change event: reconcile on refresh/startup/focus.
 */
export class ReviewStore {
    private queue: Promise<void> = Promise.resolve();
    private readonly writer = randomUUID();
    private known: Records = {};
    private pathWrites = new Map<string, ReviewPath | undefined>();
    constructor(private readonly storage: Storage) {
        storage.setKeysForSync?.([REVIEW_SYNC_KEY]);
    }
    private read(): Records {
        // Memento change notifications (including our own writes echoed back by
        // the main process) may arrive after a newer update. Never roll back the
        // latest per-record revision already observed in this extension host.
        this.known = mergeReviews(this.known, this.storage.get(LOCAL_KEY), this.storage.get(REVIEW_SYNC_KEY));
        return this.known;
    }
    get(key: string): ReviewRecord | undefined { return this.read()[key]; }
    snapshot(): Readonly<Records> { return this.read(); }
    paths(): Record<string, ReviewPath> {
        const result: Record<string, ReviewPath> = {};
        const stored = this.storage.get<Record<string, ReviewPath>>(PATHS_KEY);
        for (const [key, value] of Object.entries(stored ?? {})) {
            if (/^[sl]:[a-f0-9]{64}$/.test(key) && value && validPath(value.source) && validPath(value.destination)) { result[key] = value; }
        }
        for (const [key, value] of this.pathWrites) {
            if (value) { result[key] = value; } else { delete result[key]; }
        }
        return result;
    }
    private async save(records: Records): Promise<void> {
        this.known = mergeReviews(this.known, records);
        records = this.known;
        const synced = Object.fromEntries(Object.entries(records).filter(([key]) => key.startsWith('s:')));
        // Write the mirror first; a crash or delayed sync cannot erase a local uncheck.
        if (JSON.stringify(this.storage.get(LOCAL_KEY)) !== JSON.stringify(records)) {
            await this.storage.update(LOCAL_KEY, records);
        }
        if (JSON.stringify(this.storage.get(REVIEW_SYNC_KEY)) !== JSON.stringify(synced)) {
            await this.storage.update(REVIEW_SYNC_KEY, synced);
        }
    }
    private enqueue(action: () => Promise<void>): Promise<void> {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }
    reconcile(): Promise<void> { return this.enqueue(() => this.save(this.read())); }
    setMany(updates: ReviewUpdate[]): Promise<void> {
        return this.enqueue(async () => {
            const records = this.read();
            const paths = this.paths();
            for (const { key, fingerprint, commit, path } of updates) {
                records[key] = { fingerprint, updatedAt: Math.max(Date.now(), (records[key]?.updatedAt ?? 0) + 1), writer: this.writer };
                if (fingerprint && isCommitId(commit)) { records[key].commit = commit; }
                if (fingerprint && path && validPath(path.source) && validPath(path.destination)) {
                    paths[key] = path; this.pathWrites.set(key, path);
                }
                if (!fingerprint) { delete paths[key]; this.pathWrites.set(key, undefined); }
            }
            // Local path index keeps reviewed files discoverable after a complete
            // revert removes them from the PR diff. Paths never enter Settings Sync.
            if (JSON.stringify(this.storage.get(PATHS_KEY)) !== JSON.stringify(paths)) { await this.storage.update(PATHS_KEY, paths); }
            await this.save(mergeReviews(records));
        });
    }
}
