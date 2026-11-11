import * as vscode from 'vscode';
import * as path from 'path';
import { stat } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { Git } from './git/git';
import { API as GitAPI } from './typings/git';
import { OrcaClient, OrcaDeliveryUncertain, resolveOrcaExecutable } from './orcaClient';

const OWNER = 'git-tree-compare-orca';
const STORAGE = 'orca.notes.v1';
type NoteState = 'draft' | 'sending' | 'sent' | 'uncertain';
interface NoteRecord {
    id: string;
    uri: string;
    start: number;
    end: number;
    body: string;
    root: string;
    file: string;
    source: string;
    excerpt: string;
    fingerprint: string;
    state: NoteState;
    label: string;
}
interface NoteComment extends vscode.Comment { noteId: string }

/** One independent native comment provider; GitHub's threads are never modified. */
export class OrcaComments implements vscode.Disposable {
    readonly controller = vscode.comments.createCommentController(OWNER, 'Orca Review');
    readonly threads = new Map<string, vscode.CommentThread>();
    private readonly records = new Map<string, NoteRecord>();
    private readonly disposables: vscode.Disposable[] = [this.controller];
    private readonly busy = new Set<vscode.CommentThread>();
    private saveQueue: Promise<void> = Promise.resolve();

    constructor(private readonly context: vscode.ExtensionContext, private readonly git: Git, private readonly gitApi: GitAPI) {
        this.controller.options = { prompt: 'Send feedback about these lines to the agent in this Orca worktree.', placeHolder: 'Describe the change you want…' };
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: async document => {
                if (!this.enabled() || !this.fileUri(document.uri)) return undefined;
                try {
                    await this.repositoryRoot(document.uri);
                    return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
                } catch { return undefined; }
            },
        };
        const register = (name: string, action: (...args: any[]) => any) =>
            this.disposables.push(vscode.commands.registerCommand(`gitTreeCompare.orca.${name}`, action));
        register('addComment', () => this.addComment());
        register('send', (reply: vscode.CommentReply) => this.submit(reply, true));
        register('save', (reply: vscode.CommentReply) => this.submit(reply, false));
        register('sendDraft', (comment: NoteComment) => this.submitDraft(comment, true));
        register('saveDraft', (comment: NoteComment) => this.submitDraft(comment, false));
        register('edit', (comment: NoteComment) => {
            const thread = this.threads.get(comment.noteId);
            if (thread && this.records.get(comment.noteId)?.state === 'draft') {
                comment.mode = vscode.CommentMode.Editing;
                thread.comments = [...thread.comments];
            }
        });
        register('delete', (thread: vscode.CommentThread) => this.deleteThread(thread));
        register('copy', async (thread: vscode.CommentThread) => {
            const record = this.recordFor(thread);
            if (record) await vscode.env.clipboard.writeText(this.prompt(record));
        });
        if (!this.enabled()) return;
        // Sending at shutdown may already have reached the agent. Never restore it
        // as a retryable draft, and do not persist review text through Settings Sync.
        for (const record of context.workspaceState.get<NoteRecord[]>(STORAGE, []).slice(0, 1000)) {
            if (!record || typeof record.uri !== 'string' || typeof record.body !== 'string' ||
                !['draft', 'sending', 'sent', 'uncertain'].includes(record.state)) continue;
            try {
                const uri = vscode.Uri.parse(record.uri);
                if (!this.fileUri(uri)) continue;
                if (record.state === 'sending') {
                    record.state = 'uncertain'; record.label = 'Delivery interrupted — check Orca before resending';
                }
                const thread = this.controller.createCommentThread(uri, new vscode.Range(record.start, 0, record.end, 0), []);
                this.records.set(record.id, record); this.threads.set(record.id, thread);
                this.render(record, thread);
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
            } catch { /* Ignore damaged records rather than preventing extension activation. */ }
        }
    }

    private enabled(): boolean {
        return vscode.workspace.isTrusted && !vscode.env.remoteName &&
            vscode.workspace.getConfiguration('gitTreeCompare').get('orca.enabled', true);
    }

    private fileUri(uri: vscode.Uri): vscode.Uri | undefined {
        if (uri.scheme === 'file') return uri;
        if (uri.scheme !== 'git') return undefined;
        try {
            const query = JSON.parse(uri.query);
            return typeof query.path === 'string' && path.isAbsolute(query.path) ? vscode.Uri.file(query.path) : undefined;
        } catch { return undefined; }
    }

    private async repositoryRoot(uri: vscode.Uri): Promise<string> {
        const file = this.fileUri(uri);
        if (!file) throw new Error('Orca comments support local files and Git revisions.');
        const known = this.gitApi.getRepository(file);
        if (known) return known.rootUri.fsPath;
        // Deleted paths and other worktrees opened from the comparison still have
        // an existing ancestor from which Git can resolve the exact worktree root.
        let directory = path.dirname(file.fsPath);
        while (!(await stat(directory).catch(() => undefined))?.isDirectory()) {
            const parent = path.dirname(directory);
            if (parent === directory) throw new Error('Cannot find this file’s Git worktree.');
            directory = parent;
        }
        return this.git.getRepositoryRoot(directory);
    }

    async addComment(): Promise<vscode.CommentThread | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.enabled()) {
            void vscode.window.showErrorMessage('Open a local Git file in a trusted workspace to add an Orca comment.');
            return undefined;
        }
        try {
            await this.repositoryRoot(editor.document.uri);
            const selection = editor.selection;
            const thread = this.controller.createCommentThread(editor.document.uri,
                new vscode.Range(selection.start.line, 0, selection.end.line, 0), []);
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            return thread;
        } catch (error) { void vscode.window.showErrorMessage(error.message); return undefined; }
    }

    private recordFor(thread: vscode.CommentThread): NoteRecord | undefined {
        const comment = thread.comments[0] as NoteComment | undefined;
        return comment?.noteId ? this.records.get(comment.noteId) : undefined;
    }

    private async capture(thread: vscode.CommentThread, body: string): Promise<NoteRecord> {
        const root = await this.repositoryRoot(thread.uri);
        const file = this.fileUri(thread.uri)!;
        const document = await vscode.workspace.openTextDocument(thread.uri);
        const start = thread.range?.start.line ?? 0;
        const end = thread.range?.end.line ?? start;
        if (end >= document.lineCount) throw new Error('These lines no longer exist. Create a comment on the current file.');
        const excerpt = document.getText(new vscode.Range(start, 0, end, document.lineAt(end).text.length));
        const repo = this.git.open(root, await this.git.getRepositoryDotGit(root));
        const head = await repo.getCommit('HEAD').catch(() => undefined);
        let source = `Working tree${document.isDirty ? ' (unsaved editor content)' : ''}; HEAD ${head?.hash ?? 'unborn'}`;
        if (thread.uri.scheme === 'git') {
            const ref = JSON.parse(thread.uri.query).ref;
            const commit = typeof ref === 'string' && ref && ref !== '~' ? await repo.getCommit(ref).catch(() => undefined) : undefined;
            source = `Git revision ${commit?.hash ?? String(ref || 'index')}; HEAD ${head?.hash ?? 'unborn'}`;
        }
        const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
            tab.input instanceof vscode.TabInputTextDiff &&
            [tab.input.original.toString(), tab.input.modified.toString()].includes(thread.uri.toString()));
        if (tab?.input instanceof vscode.TabInputTextDiff) {
            source += tab.input.original.toString() === thread.uri.toString() ? '; original/left side of diff' : '; modified/right side of diff';
        }
        return { id: randomUUID(), uri: thread.uri.toString(), start, end, body, root,
            file: path.relative(root, file.fsPath), source, excerpt,
            fingerprint: createHash('sha256').update(document.getText()).digest('hex'), state: 'draft', label: 'Saved locally' };
    }

    private prompt(record: NoteRecord): string {
        // JSON preserves arbitrary filenames, quotes, fences and multiline text.
        return 'Please address this code review feedback in this worktree. The code excerpt is a snapshot; check the current file before editing.\n' +
            JSON.stringify({ worktree: record.root, file: record.file, lines: [record.start + 1, record.end + 1],
                source: record.source, documentSha256: record.fingerprint, code: record.excerpt, feedback: record.body }, null, 2);
    }

    async submit(reply: vscode.CommentReply, send: boolean): Promise<void> {
        const thread = reply?.thread;
        if (!thread || !reply.text?.trim() || this.busy.has(thread)) return;
        this.busy.add(thread);
        try {
            if (!this.enabled()) throw new Error('Sending to Orca requires a local trusted workspace and Orca comments enabled.');
            let record = this.recordFor(thread);
            if (record && record.state !== 'draft') throw new Error('This note was already submitted or its delivery is uncertain. Check Orca before composing another note.');
            record ??= await this.capture(thread, reply.text);
            record.body = reply.text;
            const prompt = this.prompt(record);
            if (Buffer.byteLength(prompt, 'utf8') > 60000) throw new Error('This note is too large. Select a smaller code range (message limit: 60 KB).');
            this.records.set(record.id, record); this.threads.set(record.id, thread);
            this.render(record, thread);
            await this.persist();
            if (!send) return;
            const config = vscode.workspace.getConfiguration('gitTreeCompare');
            const client = new OrcaClient(resolveOrcaExecutable(config.get<string>('orca.cliPath', '')));
            const target = await client.prepare(record.root);
            record.state = 'sending'; record.label = `Sending to ${target.title || target.agentIdentity}…`;
            this.render(record, thread);
            await this.persist();
            try {
                const result = await client.send(record.root, target, prompt);
                record.state = 'sent';
                record.label = `${result.started ? 'Sent' : 'Accepted; turn start unconfirmed'} — ${target.title || target.agentIdentity}`;
                if (result.focusWarning) void vscode.window.showWarningMessage('Orca accepted the note, but its pane could not be focused.');
            } catch (error) {
                record.state = error instanceof OrcaDeliveryUncertain ? 'uncertain' : 'draft';
                record.label = error.message;
                void vscode.window.showErrorMessage(error.message);
            }
            this.render(record, thread);
            await this.persist();
        } catch (error) {
            const record = this.recordFor(thread);
            if (record) {
                // Never downgrade an accepted/uncertain note to a retryable draft
                // when saving its receipt fails.
                if (record.state === 'sending') record.state = 'draft';
                record.label = error.message;
                this.render(record, thread);
            }
            void vscode.window.showErrorMessage(error.message);
            // The native reply editor clears after a fulfilled action. If even
            // capturing the note failed, reject so the user's typed text stays.
            if (!record) throw error;
        } finally { this.busy.delete(thread); }
    }

    private async submitDraft(comment: NoteComment, send: boolean): Promise<void> {
        const thread = this.threads.get(comment.noteId);
        if (thread) await this.submit({ thread, text: typeof comment.body === 'string' ? comment.body : comment.body.value }, send);
    }

    private render(record: NoteRecord, thread: vscode.CommentThread): void {
        thread.label = record.label;
        thread.contextValue = record.state;
        thread.canReply = false;
        thread.comments = [{ noteId: record.id, body: record.body, author: { name: 'You → Orca' },
            mode: record.state === 'draft' ? vscode.CommentMode.Editing : vscode.CommentMode.Preview,
            contextValue: record.state } as NoteComment];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    private persist(): Promise<void> {
        const snapshot = [...this.records.values()].map(record => ({ ...record }));
        const saved = this.saveQueue.then(() => this.context.workspaceState.update(STORAGE, snapshot));
        this.saveQueue = saved.catch(() => {});
        return saved;
    }

    private async deleteThread(thread: vscode.CommentThread): Promise<void> {
        if (this.busy.has(thread)) return;
        const record = this.recordFor(thread);
        if (record) { this.records.delete(record.id); this.threads.delete(record.id); }
        thread.dispose();
        await this.persist();
    }

    dispose(): void { vscode.Disposable.from(...this.disposables).dispose(); }
}
