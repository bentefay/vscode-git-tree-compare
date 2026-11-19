import * as path from 'path';
import { Worker } from 'worker_threads';
import { watch, FSWatcher } from 'fs';
import { comments, commands, window, workspace, ExtensionContext, Disposable, EventEmitter, TreeDataProvider,
    TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, CommentController, CommentThread, CommentThreadCollapsibleState,
    CommentMode, MarkdownString, Range, OutputChannel, WebviewPanel, ViewColumn, Uri } from 'vscode';
import type { Annotation, LineRange, DiffLink, EnrichmentState, FileInfo, Selection, Snapshot } from '../shared/enrichment.cjs';
import { GitTreeCompareProvider } from './treeProvider';
import { briefHtml } from './enrichmentBrief';
import { fileLabel, guideTitle, diffLinks, EnrichmentLabel } from './enrichmentPresentation';

const prefix = 'gitTreeCompare.enrichment.';
type Comparison = ReturnType<GitTreeCompareProvider['getEnrichmentComparisons']>[number];
interface Entry { comparison: Comparison; signature: string; revision: number; state?: EnrichmentState; files: Map<string, FileInfo>; fresh: Set<string>; watcher?: FSWatcher }
interface Step { root: string; index: number; link?: number; title: string; description: string; stale: boolean; publication?: string }

class EnrichmentWorker implements Disposable {
    private worker?: Worker;
    private next = 0;
    private disposed = false;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    constructor(private readonly filename: string) {}
    call<T>(method: string, ...args: unknown[]): Promise<T> {
        if (this.disposed) { return Promise.reject(new Error('Enrichment is disposed')); }
        if (!this.worker) {
            const worker = this.worker = new Worker(this.filename);
            worker.on('message', message => {
                const request = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) { request?.reject(new Error(message.error)); } else { request?.resolve(message.result); }
            });
            const failed = (error: Error) => {
                if (this.worker !== worker) { return; }
                for (const request of this.pending.values()) { request.reject(error); }
                this.pending.clear();
                if (this.worker === worker) { this.worker = undefined; }
            };
            worker.on('error', failed);
            worker.on('exit', () => failed(new Error('Enrichment worker stopped')));
        }
        return new Promise<T>((resolve, reject) => {
            const id = ++this.next;
            this.pending.set(id, { resolve, reject });
            this.worker!.postMessage({ id, method, args });
        });
    }
    dispose(): void { this.disposed = true; void this.worker?.terminate(); }
}

/** Cached UI only: Git, file reads, JSON validation and hashing run in the worker. */
export class EnrichmentController implements TreeDataProvider<Step>, Disposable {
    private readonly worker: EnrichmentWorker;
    private readonly entries = new Map<string, Entry>();
    private readonly changed = new EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly subscriptions: Disposable[] = [];
    private readonly controller: CommentController;
    private threads: CommentThread[] = [];
    private readonly pending = new Set<string>();
    private timer?: NodeJS.Timeout;
    private running = false;
    private readonly completed: (() => void)[] = [];
    private disposed = false;
    private panel?: WebviewPanel;
    private panelRoot?: string;
    private activeRoot?: string;
    private readonly noteThreads = new Map<string, CommentThread>();
    private requestedNote?: { root: string; file: string; note: Annotation };
    private reconcileTimer?: NodeJS.Timeout;

    constructor(context: ExtensionContext, private readonly host: GitTreeCompareProvider, private readonly output: OutputChannel) {
        this.worker = new EnrichmentWorker(context.asAbsolutePath('shared/enrichment-worker.cjs'));
        this.controller = comments.createCommentController('git-tree-compare-enrichment', 'Review explanations');
        // No commentingRangeProvider: these are read-only notes, not another compose gutter.
        host.enrichmentLabel = (root, file) => this.label(root, file);
        this.subscriptions.push(this.controller, this.changed, this.worker,
            window.createTreeView('gitTreeCompareGuide', { treeDataProvider: this }),
            host.onDidChangeTreeData(() => this.queueReconcile()), host.onDidChangeComparison(() => this.queueReconcile()),
            host.onDidChangeRepository(() => this.queueReconcile()),
            host.onDidChangeEnrichmentFile(event => {
                const entry = this.entries.get(event.root);
                if (!entry || entry.comparison.selection.right !== null || !event.changed) { return; }
                const relative = path.relative(event.root, event.path).split(path.sep).join('/');
                if (entry.comparison.selection.files?.some(file => file.path === relative)) {
                    entry.fresh.delete(relative);
                    if (entry.state) { entry.state = { ...entry.state, current: false, fresh: [...entry.fresh] }; }
                    this.updateUI();
                }
                // Root status events may include checkout/commit changes; the descriptor
                // reconciler detects those. Coalesce actual content events into one read.
                this.schedule(event.root);
            }),
            window.onDidChangeVisibleTextEditors(() => this.renderNotes()),
            workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length || e.document.isDirty) { this.renderNotes(); } }),
            workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gitTreeCompare.enrichment.showExplanations')) { this.renderNotes(); } }),
        );
        const register = (name: string, callback: (...args: any[]) => unknown) => this.subscriptions.push(commands.registerCommand(prefix + name, async (...args) => {
            try { return await callback(...args); }
            catch (error) { this.report(error); void window.showErrorMessage(`Git Tree Compare: ${String(error instanceof Error ? error.message : error)}`); return undefined; }
        }));
        register('openBrief', () => this.openBrief());
        register('refresh', () => this.refresh());
        register('openStep', (step: Step) => this.openStep(step.root, step.index, step.link, step.publication));
        register('exportContext', () => this.exportContext());
        register('import', async () => {
            const root = this.requireRoot();
            const files = await window.showOpenDialog({ canSelectMany: false, filters: { 'Enrichment JSON': ['json'] } });
            if (files?.[0]?.scheme === 'file') { await this.importFile(root, files[0].fsPath); }
        });
        register('toggleExplanations', async () => {
            const config = workspace.getConfiguration('gitTreeCompare');
            await config.update('enrichment.showExplanations', !config.get('enrichment.showExplanations', true), true);
        });
        this.reconcile();
    }

    private report(error: unknown): void { this.output.appendLine(`[enrichment] ${error instanceof Error ? error.message : String(error)}`); }
    private requireRoot(): string {
        const root = this.host.enrichmentRepository;
        if (!root || !this.entries.has(root)) { throw new Error('Select a repository and comparison in Git Tree Compare first.'); }
        return root;
    }
    private queueReconcile(): void {
        if (this.disposed || this.reconcileTimer) { return; }
        this.reconcileTimer = setTimeout(() => { this.reconcileTimer = undefined; this.reconcile(); }, 100);
    }
    private reconcile(): void {
        if (this.disposed) { return; }
        let changed = this.activeRoot !== this.host.enrichmentRepository;
        this.activeRoot = this.host.enrichmentRepository;
        const seen = new Set<string>();
        for (const comparison of this.host.getEnrichmentComparisons()) {
            seen.add(comparison.root);
            const signature = JSON.stringify([comparison.head, comparison.branch, comparison.selection]);
            const existing = this.entries.get(comparison.root);
            if (existing?.signature === signature) { continue; }
            changed = true;
            existing?.watcher?.close();
            const entry: Entry = { comparison, signature, revision: (existing?.revision ?? 0) + 1, files: new Map(), fresh: new Set() };
            this.entries.set(comparison.root, entry);
            this.schedule(comparison.root);
        }
        for (const [root, entry] of this.entries) { if (!seen.has(root)) { entry.watcher?.close(); this.entries.delete(root); changed = true; } }
        if (changed) { this.updateUI(); }
    }
    private schedule(root: string): void {
        if (this.disposed) { return; }
        const entry = this.entries.get(root);
        if (entry) { entry.revision++; }
        this.pending.add(root);
        if (!this.timer && !this.running) { this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 300); }
    }
    private async drain(): Promise<void> {
        if (this.running || this.disposed) { return; }
        this.running = true;
        try {
            let changed = false;
            const roots = [...this.pending]; this.pending.clear();
            for (const root of roots) {
                const entry = this.entries.get(root); if (!entry) { continue; }
                const revision = entry.revision;
                try {
                    if (!entry.watcher) {
                        await this.worker.call('saveSelection', root, entry.comparison.selection, entry.comparison.head);
                        if (this.disposed || this.entries.get(root) !== entry) { continue; }
                        // Watch only atomic publication pointers, never the source tree.
                        const directory = path.join(entry.comparison.gitDir, 'git-tree-compare/enrichment/v1/current');
                        entry.watcher = watch(directory, () => this.schedule(root));
                        entry.watcher.on('error', error => { this.report(error); entry.watcher?.close(); entry.watcher = undefined; });
                    }
                    const state = await this.worker.call<EnrichmentState>('load', root, entry.comparison.selection);
                    if (this.disposed || this.entries.get(root) !== entry || entry.revision !== revision) { continue; }
                    const dirty = new Set(workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file').map(d => path.relative(root, d.uri.fsPath).split(path.sep).join('/')));
                    if (state.fresh.some(file => dirty.has(file))) {
                        state.fresh = state.fresh.filter(file => !dirty.has(file));
                        state.current = false;
                    }
                    const token = (value?: EnrichmentState) => JSON.stringify([value?.publicationId, value?.current, value?.fresh]);
                    if (token(entry.state) === token(state)) { continue; }
                    changed = true;
                    entry.state = state;
                    entry.files = new Map(state.data?.files.map(file => [file.path, file]));
                    entry.fresh = new Set(state.fresh);
                } catch (error) {
                    if (this.entries.get(root) === entry) { changed ||= Boolean(entry.state); entry.state = undefined; entry.files.clear(); entry.fresh.clear(); }
                    this.report(error);
                }
            }
            if (!this.disposed && changed) { this.updateUI(); }
        } finally {
            this.running = false;
            for (const resolve of this.completed.splice(0)) { resolve(); }
            if (this.pending.size && !this.disposed && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 300); }
        }
    }
    /** Awaitable refresh used by commands and host integration tests. */
    async refresh(): Promise<void> {
        this.reconcile();
        for (const root of this.entries.keys()) { this.schedule(root); }
        // A command waits for at most the current batch and one fresh pass.
        // Continued agent writes must not make an explicit refresh wait forever.
        if (this.running) { await new Promise<void>(resolve => this.completed.push(resolve)); }
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        if (!this.disposed) { await this.drain(); }
    }
    async importFile(root: string, file: string): Promise<void> {
        await this.worker.call('publish', root, file);
        await this.refresh();
    }
    async exportContext(): Promise<Snapshot | undefined> {
        this.reconcile();
        const root = this.requireRoot(), selection: Selection = this.entries.get(root)!.comparison.selection;
        const snapshot = await this.worker.call<Snapshot>('context', root, selection);
        const destination = await window.showSaveDialog({ defaultUri: Uri.file(path.join(root, 'review-context.json')), filters: { JSON: ['json'] } });
        if (destination) { await workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(snapshot, null, 2) + '\n')); }
        return snapshot;
    }
    getState(root: string): EnrichmentState | undefined { return this.entries.get(root)?.state; }
    label(root: string, file: string): EnrichmentLabel | undefined {
        const entry = this.entries.get(root), info = entry?.files.get(file);
        return entry && info ? fileLabel(info, entry.state?.data?.producer ?? 'Agent', entry.fresh.has(file), Boolean(entry.state?.current)) : undefined;
    }
    getChildren(parent?: Step): Step[] {
        const root = parent?.root ?? this.host.enrichmentRepository;
        const entry = root ? this.entries.get(root) : undefined;
        if (!root || !entry?.state?.data) { return []; }
        if (parent) {
            if (parent.link !== undefined || parent.publication !== entry.state.publicationId) { return []; }
            return (entry.state.data.guide[parent.index]?.links ?? []).map((link, index) => ({ root, index: parent.index, link: index,
                title: link.label, description: link.path, stale: !entry.state!.current || !entry.fresh.has(link.path), publication: entry.state!.publicationId }));
        }
        return entry.state.data.guide.map((step, index) => ({ root, index, title: guideTitle(step.title),
            description: step.description, stale: !entry.state!.current, publication: entry.state!.publicationId }));
    }
    getTreeItem(step: Step): TreeItem {
        const isLink = step.link !== undefined;
        const item = new TreeItem(isLink ? step.title : `${step.index + 1}. ${guideTitle(step.title)}`,
            isLink ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Collapsed);
        item.id = `${step.root}:guide:${step.index}${isLink ? `:link:${step.link}` : ''}`;
        item.description = [isLink ? step.description : '', step.stale ? 'out of date' : ''].filter(Boolean).join(' · ');
        item.tooltip = step.description;
        const entry = this.entries.get(step.root);
        const link = isLink ? entry?.state?.data?.guide[step.index]?.links[step.link!] : undefined;
        const important = link && entry?.files.get(link.path)?.priority === 'important';
        item.iconPath = new ThemeIcon(step.stale ? 'history' : important ? 'star-full' : isLink ? 'go-to-file' : 'book',
            step.stale ? new ThemeColor('descriptionForeground') : important ? new ThemeColor('gitTreeCompare.importantForeground') : undefined);
        item.command = { command: prefix + 'openStep', title: 'Open review diff', arguments: [step] };
        return item;
    }
    private noteFresh(entry: Entry, file: string, note: LineRange): boolean {
        return entry.fresh.has(file) && (note.scope === 'file' || Boolean(entry.state?.current));
    }
    async openStep(root: string, index: number, linkIndex = 0, publication?: string): Promise<void> {
        const state = this.entries.get(root)?.state;
        if (publication !== undefined && publication !== state?.publicationId) { return; }
        const link = state?.data?.guide[index]?.links[linkIndex];
        if (link) { await this.openLink(root, link); }
    }
    async openLink(root: string, link: DiffLink): Promise<void> {
        await this.openFile(root, link.path, link.annotation, link.range);
    }
    async openFile(root: string, file: string, annotation?: number, anchor?: LineRange): Promise<void> {
        const entry = this.entries.get(root), info = entry?.files.get(file);
        if (!entry || !info) { return; }
        const uris = this.host.enrichmentUris(root, file, entry.comparison.selection);
        if (!uris) { throw new Error('The comparison changed. Refresh enrichment before opening this step.'); }
        const note = annotation === undefined ? undefined : info.annotations[annotation];
        const target = note ?? anchor;
        const dirty = workspace.textDocuments.some(doc => doc.uri.toString() === uris.after.toString() && doc.isDirty);
        const fresh = target && !dirty && this.noteFresh(entry, file, target);
        this.requestedNote = fresh && note ? { root, file, note } : undefined;
        await this.host.openEnrichmentFile(root, file, fresh ? target.side : undefined,
            fresh ? new Range(target.startLine - 1, 0, target.endLine - 1, 0) : undefined);
        this.renderNotes();
        if (fresh && note) {
            const uri = uris[note.side];
            const thread = this.threads.find(t => t.uri.toString() === uri.toString() && t.range?.start.line === note.startLine - 1);
            if (thread) { thread.collapsibleState = CommentThreadCollapsibleState.Expanded; this.requestedNote = undefined; }
        } else if (target && !fresh) { void window.showInformationMessage('This explanation is out of date. Opened the current diff without its old line anchor.'); }
    }
    private renderNotes(): void {
        const desired = new Set<string>();
        const enabled = !this.disposed && workspace.getConfiguration('gitTreeCompare').get('enrichment.showExplanations', true);
        // Comment inputs are themselves editors. Never use their visibility or dirty
        // state to recreate comments: that produces a create/dispose feedback loop.
        const visible = new Map(window.visibleTextEditors.filter(e => ['file', 'git'].includes(e.document.uri.scheme))
            .map(editor => [editor.document.uri.toString(), editor.document]));
        const dirty = new Set(workspace.textDocuments.filter(d => d.uri.scheme === 'file' && d.isDirty).map(d => d.uri.toString()));
        if (enabled) for (const [root, entry] of this.entries) {
            for (const file of entry.files.values()) {
                if (!file.annotations.length) { continue; }
                const uris = this.host.enrichmentUris(root, file.path, entry.comparison.selection);
                if (!uris || dirty.has(uris.after.toString())) { continue; }
                for (const note of file.annotations) {
                    if (!this.noteFresh(entry, file.path, note)) { continue; }
                    const uri = uris[note.side], doc = visible.get(uri.toString());
                    if (!doc || doc.isDirty || note.endLine > doc.lineCount) { continue; }
                    const producer = entry.state?.data?.producer ?? 'Agent';
                    const key = JSON.stringify([uri.toString(), note, producer]);
                    desired.add(key);
                    let thread = this.noteThreads.get(key);
                    if (!thread) {
                        thread = this.controller.createCommentThread(uri, new Range(note.startLine - 1, 0, note.endLine - 1, 0), [{
                            body: new MarkdownString().appendText(note.body), mode: CommentMode.Preview, author: { name: producer },
                        }]);
                        thread.label = note.title;
                        thread.canReply = false;
                        thread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
                        this.noteThreads.set(key, thread);
                    }
                    const requested = this.requestedNote;
                    if (requested?.root === root && requested.file === file.path && requested.note === note) {
                        thread.collapsibleState = CommentThreadCollapsibleState.Expanded;
                        this.requestedNote = undefined;
                    }
                }
            }
        }
        for (const [key, thread] of this.noteThreads) {
            if (!desired.has(key)) { thread.dispose(); this.noteThreads.delete(key); }
        }
        this.threads = [...this.noteThreads.values()];
    }
    openBrief(): void {
        this.panelRoot = this.requireRoot();
        if (!this.panel) {
            this.panel = window.createWebviewPanel('gitTreeCompareBrief', 'Review Brief', ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
            this.panel.onDidDispose(() => { this.panel = undefined; this.panelRoot = undefined; }, null, this.subscriptions);
            this.panel.webview.onDidReceiveMessage(async message => {
                const root = this.panelRoot, state = root && this.entries.get(root)?.state;
                if (!root || !state || !message || message.publication !== state.publicationId || !Number.isSafeInteger(message.index) || message.index < 0) { return; }
                try {
                    if (message.action === 'step') { await this.openStep(root, message.index, 0, message.publication); }
                    if (message.action === 'link' && state.data) {
                        const link = diffLinks(state.data)[message.index];
                        if (link) { await this.openLink(root, link); }
                    }
                    if (message.action === 'file') {
                        const file = state.data?.files[message.index];
                        if (file && (message.annotation === undefined || Number.isSafeInteger(message.annotation) && message.annotation >= 0 && message.annotation < file.annotations.length)) {
                            await this.openFile(root, file.path, message.annotation);
                        }
                    }
                } catch (error) { this.report(error); }
            }, null, this.subscriptions);
        }
        this.panel.webview.html = briefHtml(this.entries.get(this.panelRoot)?.state);
        this.panel.reveal();
    }
    private updateUI(): void {
        this.changed.fire();
        this.host.refreshEnrichmentRows();
        this.renderNotes();
        if (this.panel && this.panelRoot) { this.panel.webview.html = briefHtml(this.entries.get(this.panelRoot)?.state); }
    }
    dispose(): void {
        this.disposed = true;
        clearTimeout(this.timer); clearTimeout(this.reconcileTimer);
        for (const entry of this.entries.values()) { entry.watcher?.close(); }
        for (const thread of this.threads) { thread.dispose(); }
        this.panel?.dispose();
        this.host.enrichmentLabel = undefined;
        Disposable.from(...this.subscriptions).dispose();
    }
}
