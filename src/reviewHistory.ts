import { isCommitId, sha256 } from './reviewState';

export const HISTORY_SYNC_KEY = 'reviews.history.v1';
const LOCAL_KEY = 'reviews.history.v1.local';
export interface HistoryStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}
export interface ReviewCheckpoint { commit: string; reviewedAt: number; fileCount: number; }
export interface HistoryApproval { key: string; commit: string; reviewedAt: number; }
// Only opaque repository/branch/file identities, commit IDs and timestamps sync.
type Ledger = Record<string, Record<string, Record<string, number>>>;
const identity = /^[sl]:[a-f0-9]{64}$/;
export const historyScope = (repository: string, branch: string, synced: boolean) =>
    `${synced ? 's' : 'l'}:${sha256(JSON.stringify([repository, branch]))}`;

/** Append-only history, separate from the latest approval for each file. */
export class ReviewHistory {
    private known: Ledger = {};
    private queue: Promise<void> = Promise.resolve();
    revision = 0;
    constructor(private readonly storage: HistoryStorage, private readonly changed: () => void = () => {}) {}

    private async reconcile(): Promise<boolean> {
        const revision = this.revision;
        let visited = 0;
        for (const source of [this.storage.get<Ledger>(LOCAL_KEY), this.storage.get<Ledger>(HISTORY_SYNC_KEY)]) {
            if (!source || typeof source !== 'object') { continue; }
            for (const [scope, commits] of Object.entries(source)) {
                if (!identity.test(scope) || !commits || typeof commits !== 'object') { continue; }
                for (const [commit, files] of Object.entries(commits)) {
                    if (!isCommitId(commit) || !files || typeof files !== 'object') { continue; }
                    for (const [key, time] of Object.entries(files)) {
                        // Yield during large sync imports; never walk an unbounded history in one turn.
                        if (++visited % 250 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); }
                        if (!identity.test(key) || !Number.isSafeInteger(time) || time < 0) { continue; }
                        const target = (this.known[scope] ??= {})[commit] ??= {};
                        if ((target[key] ?? -1) < time) { target[key] = time; this.revision++; }
                    }
                }
            }
        }
        return this.revision !== revision;
    }

    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const task = this.queue.then(action);
        this.queue = task.then(() => {}, () => {});
        return task;
    }

    record(scope: string, approvals: HistoryApproval[]): Promise<void> {
        return this.enqueue(async () => {
            if (!identity.test(scope) || !approvals.length) { return; }
            const imported = await this.reconcile();
            let changed = false, visited = 0;
            for (const { key, commit, reviewedAt } of approvals) {
                if (++visited % 250 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); }
                if (!identity.test(key) || !isCommitId(commit) || !Number.isSafeInteger(reviewedAt) || reviewedAt < 0) { continue; }
                const files = (this.known[scope] ??= {})[commit] ??= {};
                if ((files[key] ?? -1) < reviewedAt) { files[key] = reviewedAt; changed = true; }
            }
            if (!changed) {
                if (imported) { await this.storage.update(LOCAL_KEY, this.known); }
                return;
            }
            this.revision++;
            await this.storage.update(LOCAL_KEY, this.known);
            await this.storage.update(HISTORY_SYNC_KEY, Object.fromEntries(Object.entries(this.known).filter(([key]) => key.startsWith('s:'))));
            this.changed();
        });
    }

    list(scope: string): Promise<ReviewCheckpoint[]> {
        return this.enqueue(async () => {
            if (await this.reconcile()) { await this.storage.update(LOCAL_KEY, this.known); }
            const result: ReviewCheckpoint[] = [];
            let visited = 0;
            for (const [commit, files] of Object.entries(this.known[scope] ?? {})) {
                if (++visited % 100 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); }
                let reviewedAt = 0, fileCount = 0;
                for (const time of Object.values(files)) { reviewedAt = Math.max(reviewedAt, time); fileCount++; }
                result.push({ commit, reviewedAt, fileCount });
            }
            return result.sort((a, b) => b.reviewedAt - a.reviewedAt || a.commit.localeCompare(b.commit));
        });
    }

    flush(): Promise<void> { return this.queue; }
}
