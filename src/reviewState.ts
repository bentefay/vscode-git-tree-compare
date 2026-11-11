import { createHash, randomUUID } from 'crypto';

export const REVIEW_SYNC_KEY = 'reviews.v1';
const LOCAL_KEY = 'reviews.v1.local';
interface Storage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
    setKeysForSync?(keys: readonly string[]): void;
}
export interface ReviewRecord {
    fingerprint: string | null;
    updatedAt: number;
    writer: string;
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
 * Only opaque repository/branch/path keys and fingerprints travel through Sync.
 * Memento has no public change event: reconcile on refresh/startup/focus.
 */
export class ReviewStore {
    private queue: Promise<void> = Promise.resolve();
    private readonly writer = randomUUID();
    private known: Records = {};
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
    setMany(updates: Array<{ key: string; fingerprint: string | null }>): Promise<void> {
        return this.enqueue(async () => {
            const records = this.read();
            for (const { key, fingerprint } of updates) {
                records[key] = { fingerprint, updatedAt: Math.max(Date.now(), (records[key]?.updatedAt ?? 0) + 1), writer: this.writer };
            }
            await this.save(mergeReviews(records));
        });
    }
}
