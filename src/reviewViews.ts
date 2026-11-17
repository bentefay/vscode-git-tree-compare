import { Disposable, Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, TreeView, ThemeIcon, OutputChannel, window } from 'vscode';
import type { BaseCandidate, NavigationContext } from './reviewNavigation';

export interface ReviewNode {
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    candidate?: BaseCandidate;
    context?: NavigationContext;
    children?: ReviewNode[];
    more?: 'older' | 'newer';
}
export interface ReviewPage { nodes: ReviewNode[]; message?: string; }
export interface ReviewNavigationHost {
    readonly onDidChangeComparison: Event<void>;
    readonly onDidChangeRepository: Event<void>;
    readonly onDidChangeReviewHistory: Event<void>;
    getReviewNavigationContext(): NavigationContext | undefined;
    invalidateReviewNavigationCache(): void;
    loadReviewPage(context: NavigationContext, kind: 'bases' | 'commits', offset: number): Promise<ReviewPage>;
    chooseReviewBase(context: NavigationContext, candidate: BaseCandidate): Promise<void>;
}

/** Collapsed panes do no Git work. Visible refreshes coalesce, and late results
 * from another branch/repository/selection can never replace the current view. */
export class ReviewTreeProvider implements TreeDataProvider<ReviewNode>, Disposable {
    private readonly emitter = new EventEmitter<ReviewNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private view: TreeView<ReviewNode> | undefined;
    private subscriptions: Disposable[] = [];
    private nodes: ReviewNode[] = [];
    private loadedKey = '';
    private running: Promise<void> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    private offset = 0;
    private scope = '';

    constructor(private readonly host: ReviewNavigationHost, readonly kind: 'bases' | 'commits', private readonly output: OutputChannel) {}

    init(view: TreeView<ReviewNode>): void {
        this.view = view;
        const changed = () => {
            const context = this.host.getReviewNavigationContext();
            view.description = this.kind === 'bases' ? context?.selected?.commit.slice(0, 8) ?? context?.target : context?.branch;
            if (this.view?.visible && window.state.focused) { this.schedule(); }
        };
        this.subscriptions.push(this.host.onDidChangeComparison(changed), this.host.onDidChangeRepository(changed),
            this.host.onDidChangeReviewHistory(changed), view.onDidChangeVisibility(e => {
                if (e.visible) { this.host.invalidateReviewNavigationCache(); this.loadedKey = ''; void this.refresh(); }
                else if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
            }), window.onDidChangeWindowState(e => { if (e.focused) { changed(); } }));
        changed();
    }

    private schedule(): void {
        if (this.timer || this.disposed) { return; }
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 150);
    }

    refresh(): Promise<void> {
        if (this.disposed || !this.view?.visible) { return Promise.resolve(); }
        if (this.running) { return this.running; }
        const requested = this.host.getReviewNavigationContext()?.key;
        this.running = this.load().catch(error => {
            this.output.appendLine(`Could not load ${this.kind}: ${error instanceof Error ? error.message : error}`);
            if (!this.disposed && this.view?.visible && this.host.getReviewNavigationContext()?.key === requested) {
                this.view.message = 'Could not load history. Use Refresh to retry.';
            } else { this.schedule(); }
        }).finally(() => { this.running = undefined; });
        return this.running;
    }

    private async load(): Promise<void> {
        const context = this.host.getReviewNavigationContext();
        if (!context) {
            this.nodes = []; this.loadedKey = '';
            if (this.view) { this.view.message = 'Select a repository in Git Tree Compare.'; }
            this.emitter.fire(undefined); return;
        }
        const scope = `${context.repoRoot}:${context.scope}:${context.head}:${context.target}`;
        if (scope !== this.scope) { this.scope = scope; this.offset = 0; this.nodes = []; this.loadedKey = ''; }
        const key = `${context.key}:${this.offset}`;
        if (key === this.loadedKey) { return; }
        const page = await this.host.loadReviewPage(context, this.kind, this.offset);
        if (this.disposed || !this.view?.visible) { return; }
        if (this.host.getReviewNavigationContext()?.key !== context.key || key !== `${context.key}:${this.offset}`) { this.schedule(); return; }
        this.nodes = page.nodes;
        this.loadedKey = key;
        this.view.message = page.message;
        this.emitter.fire(undefined);
    }

    async select(node: ReviewNode): Promise<void> {
        if (node.more) {
            if (node.context?.key !== this.host.getReviewNavigationContext()?.key) { return; }
            this.offset = Math.max(0, this.offset + (node.more === 'older' ? 1 : -1) * (this.kind === 'bases' ? 50 : 100));
            await this.refresh(); return;
        }
        if (node.candidate && node.context) { await this.host.chooseReviewBase(node.context, node.candidate); }
    }

    getTreeItem(node: ReviewNode): TreeItem {
        const item = new TreeItem(node.label, node.children ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.description;
        item.tooltip = node.tooltip;
        if (node.candidate) {
            const selected = node.context?.selected?.commit === node.candidate.commit && (this.kind === 'commits' || node.context.selected.label === node.candidate.label);
            item.iconPath = new ThemeIcon(!node.candidate.available ? 'warning' : selected ? 'circle-filled' :
                node.candidate.reviewedAt ? 'history' : this.kind === 'commits' ? 'git-commit' : 'circle-outline');
            if (node.candidate.available) {
                item.command = { command: `gitTreeCompare.${this.kind}.selectBase`, title: 'Use as Comparison Base', arguments: [node] };
                item.contextValue = 'review-base';
            }
        } else if (node.more) {
            item.iconPath = new ThemeIcon('ellipsis');
            item.command = { command: `gitTreeCompare.${this.kind}.selectBase`, title: 'Load More', arguments: [node] };
        }
        return item;
    }

    async getChildren(node?: ReviewNode): Promise<ReviewNode[]> {
        if (node) { return node.children ?? []; }
        await this.refresh();
        return this.view?.visible ? this.nodes : [];
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) { clearTimeout(this.timer); }
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.emitter.dispose();
    }
}
