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
