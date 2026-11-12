import * as path from 'path';
import type { Repository } from './git/git';
import { isCommitId } from './reviewState';

export const EMPTY_REVIEW_SCHEME = 'git-tree-compare-empty';

export async function resolveReviewCommit(repository: Repository, ref: string): Promise<string> {
    const { stdout } = await repository.exec(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { log: false });
    const commit = stdout.trim();
    if (!isCommitId(commit)) { throw new Error('Cannot resolve review commit'); }
    return commit;
}

/** Distinguish an absent file (an empty diff side) from an unavailable commit. */
export async function reviewFileExists(repository: Repository, commit: string, absolute: string): Promise<boolean> {
    if (!isCommitId(commit)) { throw new Error('Expected a resolved review commit'); }
    const relative = path.relative(repository.root, absolute).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) { throw new Error('Path outside repository'); }
    const { stdout } = await repository.exec(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', relative], { log: false });
    return stdout.length > 0;
}
