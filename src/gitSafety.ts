/** Reject Git options and control characters before resolving user-supplied revisions. */
export function validateRevision(ref: string): void {
    if (!ref || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) {
        throw new Error('Expected a commit or revision, not a Git option or whitespace.');
    }
}
