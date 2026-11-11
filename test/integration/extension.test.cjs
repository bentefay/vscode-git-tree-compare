const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { Git } = require('../../out/git/git');
const { rmFile } = require('../../out/gitHelper');
const { tryDeepenForMergeBase } = require('../../out/deepenHelper');
const { pathToFileURL } = require('node:url');

const root = process.env.GTC_TEST_REPOSITORY;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const repository = new Git({ gitPath: 'git', userAgent: '', version: '', env: process.env }).open(root, path.join(root, '.git'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn) {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(100); }
    throw new Error('Timed out waiting for extension state');
}

describe('Git Tree Compare in the extension host', () => {
    let provider;
    before(async () => {
        assert.equal(vscode.workspace.isTrusted, true);
        const builtin = await vscode.extensions.getExtension('vscode.git').activate();
        await eventually(() => builtin.getAPI(1).repositories.length);
        ({ provider } = await vscode.extensions.getExtension('bentefay.git-tree-compare').activate());
        await vscode.commands.executeCommand('workbench.view.extension.gitTreeCompare');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
    });

    it('activates, discovers Git, and lists changes relative to the default branch', async () => {
        const roots = await provider.getChildren();
        assert.equal(roots.length, 1);
        assert.match(roots[0].refName, /main/);
        const children = await provider.getChildren(roots[0]);
        const filenames = children.map(node => path.basename(node.dstAbsPath || ''));
        assert.ok(filenames.includes('committed.txt'), JSON.stringify(filenames));
    });

    it('refresh command resolves after newly committed changes are visible', async () => {
        await fs.writeFile(path.join(root, 'new-change.txt'), 'new\n');
        git('add', 'new-change.txt'); git('commit', '-m', 'New change');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const [base] = await provider.getChildren();
        const children = await provider.getChildren(base);
        assert.ok(children.some(node => node.dstAbsPath?.endsWith('/new-change.txt')));
        const node = children.find(node => node.dstAbsPath?.endsWith('/example.txt'));
        await vscode.commands.executeCommand('gitTreeCompare.openChanges', node);
        assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)));
    });

    it('restores and removes only the literal wildcard filename', async () => {
        const special = path.join(root, '*.txt');
        await fs.writeFile(special, 'literal base\n');
        git('--literal-pathspecs', 'add', '--', special); git('commit', '-m', 'Literal filename');
        await fs.writeFile(special, 'literal edited\n');
        await fs.writeFile(path.join(root, 'other.txt'), 'keep these edits\n');
        await repository.checkout('HEAD', [special]);
        assert.equal(await fs.readFile(special, 'utf8'), 'literal base\n');
        assert.equal(await fs.readFile(path.join(root, 'other.txt'), 'utf8'), 'keep these edits\n');
        await rmFile(repository, special);
        assert.equal(await fs.readFile(path.join(root, 'other.txt'), 'utf8'), 'keep these edits\n');
        await assert.rejects(fs.access(special));
    });

    it('rejects Git options as revisions without writing arbitrary output', async () => {
        const output = path.join(process.env.GTC_TEST_RESULTS, 'must-not-exist');
        await assert.rejects(repository.getCommit(`--output=${output}`));
        await assert.rejects(fs.access(output));
        const commit = await repository.getCommit('HEAD~1');
        assert.equal(commit.hash, git('rev-parse', 'HEAD~1'));
    });

    it('cancels PR comparison when cleanliness cannot be established', async () => {
        const comparison = provider.activeComparison;
        const originalExec = comparison.repository.exec;
        const originalError = vscode.window.showErrorMessage;
        const originalInput = vscode.window.showInputBox;
        let prompted = false, message;
        try {
            comparison.repository.exec = async () => { throw new Error('simulated unreadable Git index'); };
            vscode.window.showErrorMessage = async text => { message = text; };
            vscode.window.showInputBox = async () => { prompted = true; return undefined; };
            await vscode.commands.executeCommand('gitTreeCompare.compareGitHubPullRequest');
            assert.equal(prompted, false);
            assert.match(message, /Cannot verify.*clean/);
        } finally {
            comparison.repository.exec = originalExec;
            vscode.window.showErrorMessage = originalError;
            vscode.window.showInputBox = originalInput;
        }
    });

    it('unshallows without merging or changing HEAD, the index, or working files', async () => {
        const clone = path.join(process.env.GTC_TEST_RESULTS, 'shallow');
        execFileSync('git', ['clone', '--depth=1', '--no-single-branch', pathToFileURL(root).href, clone], { stdio: 'pipe' });
        const localGit = (...args) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
        const shallow = new Git({ gitPath: 'git', userAgent: '', version: '', env: process.env }).open(clone, path.join(clone, '.git'));
        const head = localGit('rev-parse', 'HEAD');
        const index = await fs.readFile(path.join(clone, '.git/index'));
        await fs.writeFile(path.join(clone, 'other.txt'), 'preserve dirty worktree\n');
        const originalError = vscode.window.showErrorMessage;
        let depthAttempts = 0;
        try {
            vscode.window.showErrorMessage = async (_message, action) => action;
            // Force the last-resort path while retaining real Git merge-base
            // queries and the real final fetch against our local-only origin.
            const api = { fetch: async () => { depthAttempts++; }, pull: async () => { throw new Error('Must never pull'); } };
            const base = await tryDeepenForMergeBase(shallow, api, 'HEAD', 'feature', 'origin/main', () => {});
            assert.ok(depthAttempts > 0);
            assert.equal(base, localGit('rev-parse', 'origin/main'));
            assert.equal(localGit('rev-parse', '--is-shallow-repository'), 'false');
            assert.equal(localGit('rev-parse', 'HEAD'), head);
            assert.deepEqual(await fs.readFile(path.join(clone, '.git/index')), index);
            assert.equal(await fs.readFile(path.join(clone, 'other.txt'), 'utf8'), 'preserve dirty worktree\n');
        } finally { vscode.window.showErrorMessage = originalError; }
    });
});

describe('Repository review workflow', () => {
    let provider, comparison;
    const reviewPath = path.join(root, 'review-progress.txt');
    async function nodes(parent) {
        const result = [];
        for (const node of await provider.getChildren(parent)) {
            result.push(node);
            if (provider.getTreeItem(node).collapsibleState !== vscode.TreeItemCollapsibleState.None) result.push(...await nodes(node));
        }
        return result;
    }
    async function find(file) { return (await nodes()).find(node => node.dstAbsPath === file); }
    const checked = node => provider.getTreeItem(node).checkboxState === vscode.TreeItemCheckboxState.Checked;
    async function mark(node, state = vscode.TreeItemCheckboxState.Checked) {
        await eventually(async () => {
            await provider.handleChangeCheckboxState({ items: [[node, state]] });
            return checked(node) === (state === vscode.TreeItemCheckboxState.Checked);
        });
    }
    before(async () => {
        ({ provider } = await vscode.extensions.getExtension('bentefay.git-tree-compare').activate());
        await vscode.workspace.getConfiguration('gitTreeCompare').update('showCheckboxes', true, vscode.ConfigurationTarget.Workspace);
        await fs.writeFile(reviewPath, 'review this version\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        comparison = provider.activeComparison;
    });

    it('retains reviews across commit filters and branch switches', async () => {
        const node = await find(reviewPath);
        await mark(node);
        await provider.setCommitFilter({ kind: 'empty' });
        assert.equal(await find(reviewPath), undefined);
        await provider.setCommitFilter({ kind: 'all' });
        await eventually(() => checked(node));
        git('switch', '-c', 'review-other-branch');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        assert.equal(checked(node), false);
        git('switch', 'feature');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        await eventually(() => checked(node));
    });

    it('detects agent edits through VS Code watchers and returns hidden files to the tree', async () => {
        await vscode.workspace.getConfiguration('gitTreeCompare').update('autoRefresh', true, vscode.ConfigurationTarget.Workspace);
        await vscode.commands.executeCommand('workbench.view.extension.gitTreeCompare');
        const node = await find(reviewPath);
        await mark(node);
        provider.hideCheckedFiles = true;
        assert.equal(await find(reviewPath), undefined);
        await fs.writeFile(reviewPath, 'changed by an external process\n');
        await eventually(async () => !checked(node) && await find(reviewPath));
        assert.equal(checked(node), false);
        provider.hideCheckedFiles = false;
        await vscode.workspace.getConfiguration('gitTreeCompare').update('autoRefresh', false, vscode.ConfigurationTarget.Workspace);
    });

    it('invalidates unsaved editor edits and does not restore a check during refresh', async () => {
        const node = await find(reviewPath);
        await mark(node);
        const approved = provider.reviewStore.get(comparison.keyForReview(node)).fingerprint;
        const document = await vscode.workspace.openTextDocument(reviewPath);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved ');
        await vscode.workspace.applyEdit(edit);
        await eventually(() => !checked(node));
        await comparison.refreshReviews();
        assert.equal(checked(node), false);
        await provider.handleChangeCheckboxState({ items: [[node, vscode.TreeItemCheckboxState.Checked]] });
        assert.equal(provider.reviewStore.get(comparison.keyForReview(node)).fingerprint, approved,
            'Attempting to review unsaved edits must retain the last approved hash');
        await document.save();
    });

    it('dims generated paths, respects overrides and collapses only fully de-emphasized folders', async () => {
        await fs.mkdir(path.join(root, 'generated'), { recursive: true });
        await fs.mkdir(path.join(root, 'mixed'), { recursive: true });
        await fs.writeFile(path.join(root, '.gitattributes'), 'generated/** linguist-generated=true\nmixed/generated.ts linguist-generated\n');
        await fs.writeFile(path.join(root, 'generated/one.ts'), 'generated\n');
        await fs.writeFile(path.join(root, 'generated/two.ts'), 'generated too\n');
        await fs.writeFile(path.join(root, 'mixed/generated.ts'), 'generated\n');
        await fs.writeFile(path.join(root, 'mixed/manual.ts'), 'manual\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const folder = await find(path.join(root, 'generated'));
        const item = provider.getTreeItem(folder);
        assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.equal(item.resourceUri.fragment, 'deemphasized');
        const mixed = provider.getTreeItem(await find(path.join(root, 'mixed')));
        assert.equal(mixed.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.notEqual(mixed.resourceUri?.fragment, 'deemphasized');
        // The children need not have been expanded in the actual UI.
        await mark(folder);
        for (const child of await provider.getChildren(folder)) assert.equal(checked(child), true);
        await fs.writeFile(path.join(root, 'generated/one.ts'), 'changed generated output\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        assert.equal(checked(folder), false);
        await vscode.workspace.getConfiguration('gitTreeCompare', vscode.Uri.file(root)).update('deemphasizedPaths', ['mixed/**'], vscode.ConfigurationTarget.WorkspaceFolder);
        await eventually(async () => {
            const manual = await find(path.join(root, 'mixed/manual.ts'));
            return manual && provider.getTreeItem(manual).resourceUri?.fragment === 'deemphasized';
        });
    });

    it('retains the approved hash when an agent edits during fingerprint calculation', async () => {
        const node = await find(reviewPath);
        await mark(node);
        const approved = provider.reviewStore.get(comparison.keyForReview(node)).fingerprint;
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let injected = false;
        comparison.fingerprinter.fingerprint = async (...args) => {
            const epoch = comparison.reviewEpoch;
            const result = await original(...args);
            if (!injected && args[0].dstAbsPath === reviewPath) {
                injected = true;
                await fs.writeFile(reviewPath, 'agent edit during review\n');
                await eventually(() => comparison.reviewEpoch > epoch);
            }
            return result;
        };
        try {
            await provider.handleChangeCheckboxState({ items: [[node, vscode.TreeItemCheckboxState.Checked]] });
            assert.equal(injected, true);
            assert.equal(checked(node), false);
            assert.equal(provider.reviewStore.get(comparison.keyForReview(node)).fingerprint, approved);
        } finally { comparison.fingerprinter.fingerprint = original; }
    });

    it('reveals the selected local path and rechecks existence before delegating', async () => {
        const node = await find(reviewPath);
        assert.equal(provider.getTreeItem(node).contextValue, 'file-local');
        const original = vscode.commands.executeCommand;
        const calls = [];
        try {
            vscode.commands.executeCommand = async (name, ...args) => {
                if (name === 'revealFileInOS' || name === 'gitTreeCompare.focus') { calls.push([name, ...args]); return; }
                return original(name, ...args);
            };
            await provider.openContainingFolder(node);
            assert.equal(calls[0][0], 'gitTreeCompare.focus');
            assert.equal(calls[1][0], 'revealFileInOS');
            assert.equal(calls[1][1].fsPath, reviewPath);
            const saved = await fs.readFile(reviewPath);
            try {
                await fs.unlink(reviewPath);
                await provider.openContainingFolder(node);
                assert.equal(calls.length, 2, 'A removed file must not launch the file manager');
            } finally { await fs.writeFile(reviewPath, saved); }
        } finally { vscode.commands.executeCommand = original; }
    });

    it('records progress in VS Code extension storage', async () => {
        const file = path.join(root, 'review-restart.txt');
        await fs.writeFile(file, 'survives an actual editor restart\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const node = await find(file);
        await mark(node);
        assert.ok(provider.reviewStore.get(comparison.keyForReview(node)).fingerprint);
    });
});
