import { createHash, randomUUID } from 'crypto';

export const REVIEW_SYNC_KEY = 'reviews.v1';
export const REVIEW_RESETS_KEY = 'reviews.resets.v1';
const RESETS_LOCAL_KEY = REVIEW_RESETS_KEY + '.local';
const LOCAL_KEY = 'reviews.v1.local';
const PATHS_KEY = 'reviews.v1.paths';
interface Storage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
    setKeysForSync?(keys: readonly string[]): void;
}
export interface ReviewRecord {
    fingerprint: string | null;
    contentOnly?: boolean;
    commit?: string;
    updatedAt: number;
    writer: string;
}
export interface ReviewPath { source: string; destination: string; }
export interface ReviewUpdate { key: string; fingerprint: string | null; contentOnly?: boolean; commit?: string; path?: ReviewPath; }
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
            if (r.fingerprint && r.contentOnly === true) { result[key].contentOnly = true; }
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
    private resets: Record<string, number> = {};
    private pathWrites = new Map<string, ReviewPath | undefined>();
    constructor(private readonly storage: Storage) {
        storage.setKeysForSync?.([REVIEW_SYNC_KEY, 'reviews.history.v1', REVIEW_RESETS_KEY]);
    }
    private read(): Records {
        // Memento change notifications (including our own writes echoed back by
        // the main process) may arrive after a newer update. Never roll back the
        // latest per-record revision already observed in this extension host.
        this.known = mergeReviews(this.known, this.storage.get(LOCAL_KEY), this.storage.get(REVIEW_SYNC_KEY));
        return this.known;
    }
    resetBefore(scope: string): number {
        for (const value of [this.storage.get(RESETS_LOCAL_KEY), this.storage.get(REVIEW_RESETS_KEY)]) {
            if (!value || typeof value !== 'object') { continue; }
            for (const [key, time] of Object.entries(value)) {
                if (/^[sl]:[a-f0-9]{64}$/.test(key) && Number.isSafeInteger(time) && time >= 0) {
                    this.resets[key] = Math.max(this.resets[key] ?? 0, time);
                }
            }
        }
        return this.resets[scope] ?? 0;
    }
    private async saveResets(): Promise<void> {
        const synced = Object.fromEntries(Object.entries(this.resets).filter(([key]) => key.startsWith('s:')));
        if (JSON.stringify(this.storage.get(RESETS_LOCAL_KEY) ?? {}) !== JSON.stringify(this.resets)) { await this.storage.update(RESETS_LOCAL_KEY, this.resets); }
        if (JSON.stringify(this.storage.get(REVIEW_RESETS_KEY) ?? {}) !== JSON.stringify(synced)) { await this.storage.update(REVIEW_RESETS_KEY, synced); }
    }
    clearScope(scope: string, historyTime = 0): Promise<void> {
        return this.enqueue(async () => {
            let cutoff = Math.max(Date.now(), historyTime, this.resetBefore(scope));
            for (const record of Object.values(this.read())) { cutoff = Math.max(cutoff, record.updatedAt); }
            this.resets[scope] = cutoff + 1;
            // A synced reset boundary also invalidates approvals for deleted branches
            // and records arriving later from an offline device. No path index needed.
            await this.saveResets();
        });
    }
    get(key: string, scope?: string): ReviewRecord | undefined {
        const record = this.read()[key];
        const cutoff = scope ? this.resetBefore(scope) : 0;
        return record && (!cutoff || record.updatedAt > cutoff) ? record : undefined;
    }
    snapshot(scope?: string): Readonly<Records> {
        const records = this.read();
        if (!scope) { return records; }
        const cutoff = this.resetBefore(scope);
        if (!cutoff) { return records; }
        return Object.fromEntries(Object.entries(records).filter(([, record]) => record.updatedAt > cutoff));
    }
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
    reconcile(): Promise<void> { return this.enqueue(async () => {
        this.resetBefore('');
        await this.saveResets();
        await this.save(this.read());
    }); }
    setMany(updates: ReviewUpdate[], scope?: string, expectedReset?: number): Promise<void> {
        return this.enqueue(async () => {
            const reset = scope ? this.resetBefore(scope) : 0;
            if (expectedReset !== undefined && reset !== expectedReset) { throw new Error('Review state was reset while recording approval'); }
            const records = this.read();
            const paths = this.paths();
            for (const { key, fingerprint, contentOnly, commit, path } of updates) {
                records[key] = { fingerprint, updatedAt: Math.max(Date.now(), reset + 1, (records[key]?.updatedAt ?? 0) + 1), writer: this.writer };
                if (fingerprint && contentOnly) { records[key].contentOnly = true; }
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
