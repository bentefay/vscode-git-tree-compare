import type { Repository } from './git/git';
import { isCommitId } from './reviewState';
import { resolveReviewCommit } from './reviewDiff';
import type { ReviewCheckpoint } from './reviewHistory';

export interface ComparisonBase { commit: string; label: string; }
export interface NavigationContext {
    key: string;
    repoRoot: string;
    scope: string;
    head: string;
    branch: string;
    target: string;
    selected?: ComparisonBase;
}
export interface BaseCandidate extends ComparisonBase {
    id: string;
    detail: string;
    available: boolean;
    reviewedAt?: number;
    fileCount?: number;
}
export interface CommitCandidate extends ComparisonBase { date: string; author: string; }
export interface BranchBases { mergeBase?: string; candidates: BaseCandidate[]; }

/** Small, bounded promise caches also coalesce simultaneous pane requests. */
export class ReviewNavigation {
    private cache = new Map<string, Promise<unknown>>();
    constructor(private readonly repository: Repository) {}
    private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
        const existing = this.cache.get(key);
        if (existing) { return existing as Promise<T>; }
        const promise = load().catch(error => { this.cache.delete(key); throw error; });
        if (this.cache.size >= 24) { this.cache.delete(this.cache.keys().next().value!); }
        this.cache.set(key, promise);
        return promise;
    }
    clear(): void { this.cache.clear(); }

    bases(context: NavigationContext, refsKey: string): Promise<BranchBases> {
        return this.cached(`bases:${context.head}:${context.target}:${refsKey}`, async () => {
            const names = [...new Set([context.target, 'origin/main', 'main', 'origin/master', 'master'])];
            const resolved = await Promise.all(names.map(async name => {
                try { return { name, commit: await resolveReviewCommit(this.repository, name) }; }
                catch { return undefined; }
            }));
            const target = resolved.find(value => value?.name === context.target)?.commit;
            let mergeBase: string | undefined;
            if (target && isCommitId(context.head)) {
                try {
                    const result = await this.repository.exec(['merge-base', context.head, target], { log: false });
                    if (isCommitId(result.stdout.trim())) { mergeBase = result.stdout.trim(); }
                } catch { /* Shallow/unrelated histories: show available tips without fetching. */ }
            }
            const candidates: BaseCandidate[] = [];
            if (mergeBase) { candidates.push({ id: 'merge-base', commit: mergeBase, label: 'Branch merge-base',
                detail: `Common ancestor with ${context.target} · full PR`, available: true }); }
            for (const value of resolved) {
                if (!value || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.name)) { continue; }
                candidates.push({ id: `ref:${value.name}`, commit: value.commit, label: value.name,
                    detail: `${value.name.includes('/') ? 'Remote-tracking' : 'Local'} tip · exact comparison`, available: true });
            }
            return { mergeBase, candidates };
        });
    }

    /** No numstat, rename detection, file reads or per-commit processes. */
    commits(base: string | undefined, head: string, offset: number): Promise<CommitCandidate[]> {
        if (!base || !isCommitId(base) || !isCommitId(head)) { return Promise.resolve([]); }
        return this.cached(`commits:${base}:${head}:${offset}`, async () => {
            const { stdout } = await this.repository.exec(['log', '--topo-order', '--max-count=101', `--skip=${offset}`,
                '--format=%H%x00%s%x00%aI%x00%an', `${base}..${head}`, '--'], { log: false });
            return stdout.trimEnd().split('\n').flatMap(line => {
                const [commit, label, date, author] = line.split('\0');
                return isCommitId(commit) ? [{ commit, label, date, author }] : [];
            });
        });
    }

    async checkpoints(records: ReviewCheckpoint[]): Promise<BaseCandidate[]> {
        // A visible page is bounded at 50. A single batch resolves availability,
        // including old commits no longer on this branch following a rebase.
        const hashes = records.map(record => record.commit).filter(isCommitId);
        if (!hashes.length) { return []; }
        const key = `available:${hashes.join(',')}`;
        const available = await this.cached(key, async () => {
            const { stdout } = await this.repository.exec(['cat-file', '--batch-check=%(objectname) %(objecttype)'],
                { input: hashes.join('\n') + '\n', log: false });
            return new Set(stdout.split('\n').filter(line => line.endsWith(' commit')).map(line => line.split(' ')[0]));
        });
        return records.map((record, index) => ({ ...record, id: `review:${record.commit}`,
            label: index === 0 ? 'Latest review activity' : 'Earlier review activity',
            detail: `${new Date(record.reviewedAt).toLocaleString()} · ${record.fileCount} file${record.fileCount === 1 ? '' : 's'} checked here`,
            available: available.has(record.commit) }));
    }
}
