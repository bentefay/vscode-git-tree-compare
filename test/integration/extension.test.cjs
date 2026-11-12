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

    it('keeps validated checks visible during focus and view revalidation', async () => {
        const node = await find(reviewPath);
        await mark(node);
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let release, entered = false;
        const gate = new Promise(resolve => { release = resolve; });
        comparison.fingerprinter.fingerprint = async (...args) => {
            if (args[0].dstAbsPath === reviewPath) { entered = true; await gate; }
            return original(...args);
        };
        try {
            provider.handleWorkspaceChange(vscode.Uri.file(root));
            assert.equal(checked(node), true, 'Repository status alone must not clear checks');
            provider.revalidateOnResume();
            assert.equal(provider.pendingRefreshTimer, undefined, 'Resume must bypass the write debounce');
            await eventually(() => entered);
            assert.equal(checked(node), true, 'Keep the check while its replacement fingerprint is computed');
            release();
            await eventually(() => !provider.refreshInProgress);
            assert.equal(checked(node), true);
        } finally {
            release();
            comparison.fingerprinter.fingerprint = original;
        }
    });

    it('keeps a reviewed file checked across clean document close events', async () => {
        const document = await vscode.workspace.openTextDocument(reviewPath);
        await vscode.window.showTextDocument(document, { preview: false });
        const node = await find(reviewPath);
        await mark(node);
        await eventually(() => !provider.refreshInProgress);
        const approved = provider.reviewStore.get(comparison.keyForReview(node)).fingerprint;
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let release, entered = false, closed = false;
        const gate = new Promise(resolve => { release = resolve; });
        comparison.fingerprinter.fingerprint = async (...args) => {
            if (args[0].dstAbsPath === reviewPath) { entered = true; await gate; }
            return original(...args);
        };
        const renders = [];
        const renderListener = provider.onDidChangeTreeData(() => renders.push(checked(node)));
        const closeListener = vscode.workspace.onDidCloseTextDocument(doc => {
            if (doc === document) { closed = true; }
        });
        try {
            // Tab closure may retain VS Code's document model in its cache.
            // Changing language guarantees a real onDidCloseTextDocument event
            // without changing bytes, so this regression does not depend on GC.
            await vscode.languages.setTextDocumentLanguage(document, 'markdown');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await eventually(() => closed);
            assert.equal(checked(node), true, 'Closing the document must not invalidate its review');
            assert.equal(provider.pendingRefreshTimer, undefined, 'Closing must bypass the write debounce');
            await eventually(() => entered);
            assert.equal(checked(node), true, 'Keep the check while close validation is pending');
            release();
            await eventually(() => !provider.refreshInProgress);
            assert.equal(checked(node), true);
            assert.ok(renders.every(Boolean), 'No intermediate render may clear the tick');
            assert.equal(provider.reviewStore.get(comparison.keyForReview(node)).fingerprint, approved);
        } finally {
            release();
            comparison.fingerprinter.fingerprint = original;
            renderListener.dispose();
            closeListener.dispose();
        }
    });

    it('restores the approved check when unsaved edits are discarded on close', async () => {
        const document = await vscode.workspace.openTextDocument(reviewPath);
        await vscode.window.showTextDocument(document, { preview: false });
        const node = await find(reviewPath);
        await mark(node);
        const approved = provider.reviewStore.get(comparison.keyForReview(node)).fingerprint;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), 'discard this edit ');
        await vscode.workspace.applyEdit(edit);
        await eventually(() => !checked(node));
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await eventually(() => checked(node));
        assert.equal(provider.reviewStore.get(comparison.keyForReview(node)).fingerprint, approved);
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

    it('approves one file while unrelated edits and a blocked background validation continue', async () => {
        const file = path.join(root, 'concurrent-approval.txt');
        const other = path.join(root, 'concurrent-noise.txt');
        await fs.writeFile(file, 'review this file\n');
        await fs.writeFile(other, 'agent work\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const node = await find(file), noise = await find(other);
        await mark(noise);
        await eventually(() => !provider.refreshInProgress);
        const originalHash = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        const originalSave = provider.reviewStore.setMany.bind(provider.reviewStore);
        let release, backgroundEntered = false, approvalDone = false, targetHashes = 0;
        const gate = new Promise(resolve => { release = resolve; });
        async function editOther(contents) {
            const token = comparison.reviewToken(other);
            await fs.writeFile(other, contents);
            await eventually(() => comparison.reviewToken(other) !== token);
            provider.handleWorkspaceChange(vscode.Uri.file(root)); // Git's aggregate status event
        }
        comparison.fingerprinter.fingerprint = async (...args) => {
            if (args[0].dstAbsPath === other) { backgroundEntered = true; await gate; }
            const result = await originalHash(...args);
            if (args[0].dstAbsPath === file) {
                targetHashes++;
                await editOther('agent edit during hashing\n');
            }
            return result;
        };
        provider.reviewStore.setMany = async updates => {
            await originalSave(updates);
            await editOther('agent edit while approval is being saved\n');
        };
        const background = comparison.refreshReviews();
        let approval;
        try {
            await eventually(() => backgroundEntered);
            approval = provider.handleChangeCheckboxState({ items: [[node, vscode.TreeItemCheckboxState.Checked]] })
                .then(() => { approvalDone = true; });
            await eventually(() => approvalDone);
            assert.equal(checked(node), true, 'Approval must finish while unrelated validation is still blocked');
            assert.equal(targetHashes, 1, 'The clicked file must not be hashed again to display its check');
            assert.ok(provider.reviewStore.get(comparison.keyForReview(node)).fingerprint);
            release();
            await background;
            assert.equal(checked(node), true, 'Older background results must not erase the new approval');
        } finally {
            release();
            comparison.fingerprinter.fingerprint = originalHash;
            provider.reviewStore.setMany = originalSave;
            await Promise.all([background, approval]);
        }
    });

    it('publishes stable background review results despite changes to another candidate', async () => {
        const file = path.join(root, 'concurrent-approval.txt');
        const other = path.join(root, 'concurrent-noise.txt');
        const node = await find(file), noise = await find(other);
        await mark(node); await mark(noise);
        comparison.invalidateReviews(file);
        assert.equal(checked(node), false);
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let injected = false;
        comparison.fingerprinter.fingerprint = async (...args) => {
            const result = await original(...args);
            if (!injected && args[0].dstAbsPath === other) {
                injected = true;
                const token = comparison.reviewToken(other);
                await fs.writeFile(other, 'another agent edit during background validation\n');
                await eventually(() => comparison.reviewToken(other) !== token);
                provider.handleWorkspaceChange(vscode.Uri.file(root));
            }
            return result;
        };
        try {
            await comparison.refreshReviews();
            assert.equal(injected, true);
            assert.equal(checked(node), true, 'An unchanged candidate must publish independently');
            assert.equal(checked(noise), false, 'The changed candidate must not publish an obsolete check');
        } finally { comparison.fingerprinter.fingerprint = original; }
    });

    it('keeps a pending refresh deadline when further unrelated edits arrive', async () => {
        const file = vscode.Uri.file(path.join(root, 'concurrent-noise.txt'));
        provider.handleWorkspaceChange(file);
        const timer = provider.pendingRefreshTimer;
        assert.ok(timer);
        provider.handleWorkspaceChange(file);
        provider.handleWorkspaceChange(vscode.Uri.file(root));
        assert.equal(provider.pendingRefreshTimer, timer, 'Continuous edits must not restart the delay');
    });

    it('rejects an approval if the branch switches during hashing, even at the same commit', async () => {
        const file = path.join(root, 'concurrent-approval.txt');
        const node = await find(file);
        await mark(node);
        const key = comparison.keyForReview(node);
        const previous = provider.reviewStore.get(key);
        await fs.writeFile(file, 'new version not yet approved\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let switched = false;
        comparison.fingerprinter.fingerprint = async (...args) => {
            const result = await original(...args);
            if (!switched && args[0].dstAbsPath === file) {
                switched = true;
                git('switch', '-c', 'concurrent-review-branch');
            }
            return result;
        };
        try {
            await provider.handleChangeCheckboxState({ items: [[node, vscode.TreeItemCheckboxState.Checked]] });
            assert.equal(switched, true);
            assert.equal(checked(node), false);
            assert.deepEqual(provider.reviewStore.get(key), previous, 'A branch change must retain the previous approval');
        } finally {
            comparison.fingerprinter.fingerprint = original;
            git('switch', 'feature');
            await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        }
    });

    it('does not display a check if the selected file changes while storage is updating', async () => {
        const file = path.join(root, 'concurrent-approval.txt');
        const node = await find(file);
        await mark(node, vscode.TreeItemCheckboxState.Unchecked);
        const original = provider.reviewStore.setMany.bind(provider.reviewStore);
        let changed = false;
        provider.reviewStore.setMany = async updates => {
            await original(updates);
            const token = comparison.reviewToken(file);
            await fs.writeFile(file, 'changed during persistence\n');
            await eventually(() => comparison.reviewToken(file) !== token);
            changed = true;
        };
        try {
            await provider.handleChangeCheckboxState({ items: [[node, vscode.TreeItemCheckboxState.Checked]] });
            assert.equal(changed, true);
            assert.equal(checked(node), false, 'The persisted earlier hash must not check newer contents');
            const approved = provider.reviewStore.get(comparison.keyForReview(node)).fingerprint;
            const context = await comparison.fingerprintContext();
            assert.notEqual(approved, await comparison.fingerprinter.fingerprint(node, context.left, context.right, context.fileMode));
        } finally { provider.reviewStore.setMany = original; }
    });

    it('approves stable folder children independently of a child edited during hashing', async () => {
        // Use established files so this isolates edits from folder creation.
        const folderPath = path.join(root, 'generated');
        const stable = path.join(folderPath, 'two.ts'), changing = path.join(folderPath, 'one.ts');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const folder = await find(folderPath), stableNode = await find(stable), changingNode = await find(changing);
        const previous = provider.reviewStore.get(comparison.keyForReview(changingNode));
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let injected = false;
        comparison.fingerprinter.fingerprint = async (...args) => {
            const result = await original(...args);
            if (!injected && args[0].dstAbsPath === changing) {
                injected = true;
                const token = comparison.reviewToken(changing);
                await fs.writeFile(changing, 'changed during hashing\n');
                await eventually(() => comparison.reviewToken(changing) !== token);
            }
            return result;
        };
        try {
            await provider.handleChangeCheckboxState({ items: [[folder, vscode.TreeItemCheckboxState.Checked]] });
            assert.equal(injected, true);
            assert.equal(checked(stableNode), true);
            assert.equal(checked(changingNode), false);
            assert.equal(checked(folder), false);
            assert.deepEqual(provider.reviewStore.get(comparison.keyForReview(changingNode)), previous);
        } finally { comparison.fingerprinter.fingerprint = original; }
    });

    it('retains the approved hash when an agent edits during fingerprint calculation', async () => {
        const node = await find(reviewPath);
        await mark(node);
        const approved = provider.reviewStore.get(comparison.keyForReview(node)).fingerprint;
        const original = comparison.fingerprinter.fingerprint.bind(comparison.fingerprinter);
        let injected = false;
        comparison.fingerprinter.fingerprint = async (...args) => {
            const token = comparison.reviewToken(reviewPath);
            const result = await original(...args);
            if (!injected && args[0].dstAbsPath === reviewPath) {
                injected = true;
                await fs.writeFile(reviewPath, 'agent edit during review\n');
                await eventually(() => comparison.reviewToken(reviewPath) !== token);
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

    it('highlights re-review and opens the saved commit against current contents, then advances approval', async () => {
        const file = path.join(root, 'incremental-review.txt');
        await fs.writeFile(file, 'approved commit\n');
        git('add', '--', file); git('commit', '-m', 'Review baseline');
        const baseline = git('rev-parse', 'HEAD');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const node = await find(file);
        await mark(node);
        const key = comparison.keyForReview(node);
        assert.equal(provider.reviewStore.get(key).commit, baseline);
        await fs.writeFile(file, 'agent follow-up\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        await eventually(() => provider.getTreeItem(node).resourceUri?.fragment === 'review-changed');
        assert.equal(checked(node), false);
        assert.equal(provider.getTreeItem(node).resourceUri.fragment, 'review-changed');
        assert.equal(provider.getTreeItem(node).contextValue, 'file-local-review-changed');
        await vscode.commands.executeCommand('gitTreeCompare.openChangesSinceReview', node);
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        assert.ok(tab.input instanceof vscode.TabInputTextDiff);
        assert.match(tab.label, /Last reviewed commit/);
        assert.equal(JSON.parse(tab.input.original.query).ref, baseline);
        assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), 'approved commit\n');
        assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), 'agent follow-up\n');
        git('add', '--', file); git('commit', '-m', 'Agent follow-up');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        await mark(node);
        assert.equal(provider.reviewStore.get(key).commit, git('rev-parse', 'HEAD'));
        assert.equal(checked(node), true);
        assert.notEqual(provider.getTreeItem(node).resourceUri?.fragment, 'review-changed');
        assert.equal(provider.getTreeItem(node).contextValue, 'file-local');
        await mark(node, vscode.TreeItemCheckboxState.Unchecked);
        assert.equal(provider.reviewStore.get(key).commit, undefined);
        assert.notEqual(provider.getTreeItem(node).resourceUri?.fragment, 'review-changed');
    });

    it('handles added and deleted files, historical filters, and unavailable baselines without substituting HEAD', async () => {
        const file = path.join(root, 'incremental-review.txt');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const node = await find(file);
        await mark(node);
        const record = provider.reviewStore.get(comparison.keyForReview(node));
        await fs.unlink(file);
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        await provider.openChangesSinceReview(await find(file));
        let input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
        assert.ok(input instanceof vscode.TabInputTextDiff);
        assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'agent follow-up\n');
        assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), '');
        await fs.writeFile(file, 'agent follow-up\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');

        const untracked = path.join(root, 'review-restart.txt');
        const added = await find(untracked);
        await mark(added);
        await fs.writeFile(untracked, 'more edits to an uncommitted addition\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        await provider.openChangesSinceReview(await find(untracked));
        input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
        assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), '');
        assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'more edits to an uncommitted addition\n');

        const historical = git('rev-parse', 'HEAD~1');
        await provider.setCommitFilter({ kind: 'range', leftRef: git('rev-parse', 'origin/main'), rightRef: historical });
        const filtered = await find(file);
        await mark(filtered);
        assert.equal(provider.reviewStore.get(comparison.keyForReview(filtered)).commit, historical);
        await provider.openChangesSinceReview(filtered);
        input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
        assert.equal(JSON.parse(input.modified.query).ref, historical);
        await provider.setCommitFilter({ kind: 'all' });

        const originalWarning = vscode.window.showWarningMessage;
        const originalCommand = vscode.commands.executeCommand;
        let warning, opened = false;
        try {
            await provider.reviewStore.setMany([{ key: comparison.keyForReview(node), fingerprint: record.fingerprint, commit: 'f'.repeat(40) }]);
            vscode.window.showWarningMessage = async message => { warning = message; };
            vscode.commands.executeCommand = async (command, ...args) => {
                if (command === 'vscode.diff') { opened = true; return; }
                return originalCommand(command, ...args);
            };
            await provider.openChangesSinceReview(node);
            assert.match(warning, /unavailable/);
            assert.equal(opened, false);
        } finally {
            vscode.window.showWarningMessage = originalWarning;
            vscode.commands.executeCommand = originalCommand;
            await provider.reviewStore.setMany([{ key: comparison.keyForReview(node), fingerprint: record.fingerprint, commit: record.commit }]);
        }
    });

    it('keeps locally reviewed files visible when an edit completely reverts the PR change', async () => {
        const file = path.join(root, 'other.txt');
        await fs.writeFile(file, 'review this change\n');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        await mark(await find(file));
        assert.deepEqual(provider.reviewStore.paths()[comparison.keyForReview(await find(file))], { source: 'other.txt', destination: 'other.txt' });
        await fs.writeFile(file, 'keep me\n');
        assert.equal(git('diff', 'origin/main', '--', file), '');
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        const reverted = await find(file);
        assert.ok(reverted, 'A complete revert still needs review');
        await eventually(() => provider.getTreeItem(reverted).resourceUri?.fragment === 'review-changed');
        assert.equal(provider.getTreeItem(reverted).resourceUri.fragment, 'review-changed');
        await mark(reverted);
        await vscode.commands.executeCommand('gitTreeCompare.refreshAll');
        assert.equal(await find(file), undefined, 'An approved revert can leave the tree');
    });
});

describe('Orca inline review comments', () => {
    let comments;
    const control = path.join(process.env.GTC_TEST_RESULTS, 'orca-control.json');
    const calls = async () => (await fs.readFile(path.join(process.env.GTC_TEST_RESULTS, 'orca-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    before(async () => {
        ({ orcaComments: comments } = await vscode.extensions.getExtension('bentefay.git-tree-compare').activate());
    });
    afterEach(async () => { await fs.writeFile(control, '{}'); });

    it('allows multiline feedback on unchanged files and sends the range to the selected worktree agent', async () => {
        const file = path.join(root, 'orca-unchanged.txt');
        await fs.writeFile(file, 'one\ntwo\nthree\nfour\n');
        git('add', file); git('commit', '-m', 'Unchanged Orca review fixture');
        const document = await vscode.workspace.openTextDocument(file);
        const ranges = await comments.controller.commentingRangeProvider.provideCommentingRanges(document);
        assert.equal(ranges[0].start.line, 0);
        assert.equal(ranges[0].end.line, 4);
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(1, 0, 2, 5);
        const thread = await vscode.commands.executeCommand('gitTreeCompare.orca.addComment');
        assert.equal(thread.range.start.line, 1); assert.equal(thread.range.end.line, 2);
        await vscode.commands.executeCommand('gitTreeCompare.orca.send', { thread, text: 'Simplify these two lines' });
        assert.equal(thread.contextValue, 'sent');
        const send = (await calls()).filter(a => a[1] === 'send').at(-1);
        const prompt = send[send.indexOf('--text') + 1];
        const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
        assert.equal(payload.worktree, root); assert.deepEqual(payload.lines, [2, 3]);
        assert.equal(payload.code, 'two\nthree'); assert.equal(payload.feedback, 'Simplify these two lines');
        assert.equal(send[send.indexOf('--terminal') + 1], 'selected-agent');
        assert.equal((await calls()).at(-1)[1], 'switch');
        await vscode.commands.executeCommand('gitTreeCompare.orca.delete', thread);
    });

    it('captures deleted Git revision content and keeps failed notes editable', async () => {
        const api = vscode.extensions.getExtension('vscode.git').exports.getAPI(1);
        const uri = api.toGitUri(vscode.Uri.file(path.join(root, 'orca-unchanged.txt')), git('rev-parse', 'HEAD'));
        await fs.unlink(path.join(root, 'orca-unchanged.txt'));
        const document = await vscode.workspace.openTextDocument(uri);
        assert.ok(await comments.controller.commentingRangeProvider.provideCommentingRanges(document));
        const thread = comments.controller.createCommentThread(uri, new vscode.Range(0, 0, 1, 0), []);
        await fs.writeFile(control, JSON.stringify({ mode: 'no-agent' }));
        await vscode.commands.executeCommand('gitTreeCompare.orca.send', { thread, text: 'Keep my failed note' });
        assert.equal(thread.contextValue, 'draft');
        assert.equal(thread.comments[0].body, 'Keep my failed note');
        assert.equal(thread.comments[0].mode, vscode.CommentMode.Editing);
        await fs.writeFile(control, '{}');
        await vscode.commands.executeCommand('gitTreeCompare.orca.sendDraft', thread.comments[0]);
        assert.equal(thread.contextValue, 'sent');
        const send = (await calls()).filter(a => a[1] === 'send').at(-1);
        assert.match(send[send.indexOf('--text') + 1], /Git revision [a-f0-9]{40}/);
        await fs.writeFile(path.join(root, 'orca-unchanged.txt'), 'one\ntwo\nthree\nfour\n');
        await vscode.commands.executeCommand('gitTreeCompare.orca.delete', thread);
    });

    it('routes a file from a linked worktree to that checkout rather than the workspace main repository', async () => {
        const linked = path.join(process.env.GTC_TEST_RESULTS, 'linked-review');
        git('worktree', 'add', '--detach', linked, 'HEAD');
        const uri = vscode.Uri.file(path.join(linked, 'orca-unchanged.txt'));
        const thread = comments.controller.createCommentThread(uri, new vscode.Range(0, 0, 0, 0), []);
        await vscode.commands.executeCommand('gitTreeCompare.orca.send', { thread, text: 'Feedback for this linked worktree' });
        assert.equal(thread.contextValue, 'sent');
        const send = (await calls()).filter(a => a[1] === 'send').at(-1);
        const prompt = send[send.indexOf('--text') + 1];
        const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
        assert.equal(payload.worktree, linked);
        await vscode.commands.executeCommand('gitTreeCompare.orca.delete', thread);
    });

    it('keeps an uncertain note without allowing a duplicate submission', async () => {
        const uri = vscode.Uri.file(path.join(root, 'orca-unchanged.txt'));
        const thread = comments.controller.createCommentThread(uri, new vscode.Range(0, 0, 0, 0), []);
        await fs.writeFile(control, JSON.stringify({ mode: 'uncertain' }));
        await vscode.commands.executeCommand('gitTreeCompare.orca.send', { thread, text: 'Possibly delivered' });
        assert.equal(thread.contextValue, 'uncertain');
        const count = (await calls()).filter(a => a[1] === 'send').length;
        await vscode.commands.executeCommand('gitTreeCompare.orca.send', { thread, text: 'Possibly delivered' });
        assert.equal((await calls()).filter(a => a[1] === 'send').length, count);
        assert.equal(thread.comments[0].body, 'Possibly delivered');
        await vscode.commands.executeCommand('gitTreeCompare.orca.delete', thread);
    });
});
