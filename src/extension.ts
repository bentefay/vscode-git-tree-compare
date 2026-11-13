import { ExtensionContext, window, Disposable, commands, extensions, workspace } from 'vscode';

import { NAMESPACE } from './constants'
import { GitTreeCompareProvider } from './treeProvider';
import { CommitsTreeProvider } from './commitsProvider';
import { createGit } from './gitHelper';
import { toDisposable } from './git/util';
import { GitExtension } from './typings/git';
import { OrcaComments } from './orcaComments';

export async function activate(context: ExtensionContext) {
    const disposables: Disposable[] = [];
    context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

    const outputChannel = window.createOutputChannel('Git Tree Compare');
    disposables.push(outputChannel);

    const gitExtension = extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension || !workspace.isTrusted) {
        throw new Error('Git Tree Compare requires a trusted workspace and the built-in Git extension.');
    }
    const gitExt = await gitExtension.activate();
    const gitApi = gitExt.getAPI(1);

    let provider: GitTreeCompareProvider | null = null;
    let commitsProvider: CommitsTreeProvider | null = null;

    const git = await createGit(gitApi, outputChannel);
    const onOutput = (str: string) => outputChannel.append(str);
    git.onOutput.addListener('log', onOutput);
    disposables.push(toDisposable(() => git.onOutput.removeListener('log', onOutput)));

    // Set initial context for menu enablement
    commands.executeCommand('setContext', NAMESPACE + '.hideCheckedFiles', false);
    commands.executeCommand('setContext', NAMESPACE + '.isFiltered', false);
    commands.executeCommand('setContext', NAMESPACE + '.viewingWorktree', false);
    commands.executeCommand('setContext', NAMESPACE + '.hasWorktrees', false);
    commands.executeCommand('setContext', NAMESPACE + '.showRepositoryNodes', false);

    provider = new GitTreeCompareProvider(git, gitApi, outputChannel, context.globalState, context.asAbsolutePath);
    commands.executeCommand('setContext', NAMESPACE + '.viewAsList', provider.viewAsList);

    const treeView = window.createTreeView(
        NAMESPACE,
        {
            treeDataProvider: provider,
            canSelectMany: true,
            manageCheckboxStateManually: true,
        }
    );

    disposables.push(provider, treeView);
    await provider.init(treeView);
    const orcaComments = new OrcaComments(context, git, gitApi);
    disposables.push(orcaComments);

    // The "Commits" panel is optional and disabled by default; create/dispose it
    // according to the gitTreeCompare.showCommitsPanel setting.
    let commitsDisposables: Disposable[] = [];
    const updateCommitsPanel = () => {
        const enabled = workspace.getConfiguration(NAMESPACE).get<boolean>('showCommitsPanel', false);
        if (enabled && !commitsProvider) {
            commitsProvider = new CommitsTreeProvider(provider!, outputChannel);
            const commitsTreeView = window.createTreeView(
                NAMESPACE + 'Commits',
                {
                    treeDataProvider: commitsProvider,
                }
            );
            commitsDisposables.push(commitsTreeView, commitsProvider);
            commitsProvider.init(commitsTreeView);
        } else if (!enabled && commitsProvider) {
            Disposable.from(...commitsDisposables).dispose();
            commitsDisposables = [];
            commitsProvider = null;
            // Without the panel there is no way to undo a commit selection,
            // so restore the full comparison everywhere.
            void provider!.clearCommitFilters();
        }
    };
    disposables.push(new Disposable(() => Disposable.from(...commitsDisposables).dispose()));
    disposables.push(workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(NAMESPACE + '.showCommitsPanel')) {
            updateCommitsPanel();
        }
    }));
    updateCommitsPanel();
    const register = (name: string, callback: (...args: any[]) => any) => {
        disposables.push(commands.registerCommand(name, callback));
    };
    register(NAMESPACE + '.openChanges', node => {
        return provider!.openChanges(node);
    });

    register(NAMESPACE + '.openContainingFolder', node => provider!.openContainingFolder(node));
    register(NAMESPACE + '.openChangesSinceReview', node => provider!.openChangesSinceReview(node));
    register(NAMESPACE + '.revealInTree', uri => provider!.revealInTree(uri));

    register(NAMESPACE + '.openFile', (node, nodes) => {
        return provider!.openFile(nodes || [node]);
    });

    register(NAMESPACE + '.discardChanges', (node, nodes) => {
        return provider!.discardChanges(nodes || [node]);
    });

    register(NAMESPACE + '.discardAllChanges', node => {
        return provider!.discardAllChanges(node);
    });

    register(NAMESPACE + '.changeRepository', () => {
        return provider!.promptChangeRepository();
    });
    register(NAMESPACE + '.changeWorktree', node => {
        return provider!.promptChangeWorktree(node);
    });
    register(NAMESPACE + '.switchToWorkingTree', node => {
        return provider!.switchToWorkingTree(node);
    });
    register(NAMESPACE + '.changeBase', node => {
        return provider!.promptChangeBase(node);
    });
    register(NAMESPACE + '.compareGitHubPullRequest', node => {
        return provider!.compareGitHubPullRequest(node);
    });
    register(NAMESPACE + '.refresh', node => {
        return provider!.manualRefresh(node);
    });
    register(NAMESPACE + '.refreshAll', () => {
        return provider!.manualRefreshAll();
    });
    register(NAMESPACE + '.openAllChanges', node => {
        return provider!.openAllChanges(node);
    });
    register(NAMESPACE + '.openChangedFiles', node => {
        return provider!.openChangedFiles(node);
    });
    register(NAMESPACE + '.switchToFullDiff', () => {
        return provider!.switchToFullDiff();
    });
    register(NAMESPACE + '.switchToMergeDiff', () => {
        return provider!.switchToMergeDiff();
    });
    register(NAMESPACE + '.showCheckboxes', () => {
        return provider!.hideCheckboxes(false);
    });
    register(NAMESPACE + '.hideCheckboxes', () => {
        return provider!.hideCheckboxes(true);
    });
    register(NAMESPACE + '.viewAsList', () => {
        return provider!.viewAsTree(false);
    });
    register(NAMESPACE + '.viewAsTree', () => {
        return provider!.viewAsTree(true);
    });
    register(NAMESPACE + '.hideCheckedInTree', () => {
        return provider!.setHideCheckedFiles(true);
    });
    register(NAMESPACE + '.showCheckedInTree', () => {
        return provider!.setHideCheckedFiles(false);
    });
    register(NAMESPACE + '.searchChanges', node => {
        return provider!.searchChanges(node);
    });
    register(NAMESPACE + '.collapseAll', () => {
        return provider!.collapseAll();
    });
    register(NAMESPACE + '.filterFiles', node => {
        return provider!.filterFiles(node);
    });
    register(NAMESPACE + '.clearFilter', node => {
        return provider!.clearFilter(node);
    });
    register(NAMESPACE + '.copyPath', node => {
        return provider!.copyPath(node);
    });
    register(NAMESPACE + '.copyRelativePath', node => {
        return provider!.copyRelativePath(node);
    });
    register(NAMESPACE + '.sortByName', () => {
        return provider!.sortByName();
    });
    register(NAMESPACE + '.sortByPath', () => {
        return provider!.sortByPath();
    });
    register(NAMESPACE + '.sortByStatus', () => {
        return provider!.sortByStatus();
    });
    register(NAMESPACE + '.sortByRecentlyModified', () => {
        return provider!.sortByRecentlyModified();
    });

    register(NAMESPACE + '.openChangesWithDifftool', node => {
        return provider!.openChangesWithDifftool(node);
    });

    register(NAMESPACE + '.commits.selectAll', () => {
        return commitsProvider?.selectAll();
    });
    register(NAMESPACE + '.commits.deselectAll', () => {
        return commitsProvider?.deselectAll();
    });
    register(NAMESPACE + '.commits.refresh', () => {
        // Refresh the whole comparison; the commits list updates via onDidChangeComparison.
        return provider!.manualRefresh();
    });

    return { provider, orcaComments };
}
