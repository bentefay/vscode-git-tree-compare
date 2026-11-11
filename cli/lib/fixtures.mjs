import { mkdir, mkdtemp, writeFile, cp, rm, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, root } from './process.mjs';

export async function fixture(label) {
    const parent = path.join(root, 'test-results');
    await mkdir(parent, { recursive: true });
    // Unix domain sockets have short path limits, including on long CI paths.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gtc-'));
    const evidence = path.join(parent, `${label}-${path.basename(directory)}`);
    const repo = path.join(directory, 'repository');
    const hooks = path.join(directory, 'empty-hooks');
    await mkdir(repo); await mkdir(hooks);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
        GIT_CONFIG_KEY_1: 'commit.gpgSign', GIT_CONFIG_VALUE_1: 'false', GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Test Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Test Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    for (const key of Object.keys(env)) {
        if (/^(VSCODE_|ELECTRON_|ORCA_|NODE_OPTIONS$)/.test(key) || /^(GITHUB_TOKEN|GH_TOKEN|VSCE_PAT|SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_CONFIG_PARAMETERS)$/.test(key)) delete env[key];
    }
    env.ORCA_CLI_COMMAND = path.join(directory, 'orca-cli');
    await cp(path.join(root, 'test/fixtures/orca-cli.cjs'), env.ORCA_CLI_COMMAND);
    await chmod(env.ORCA_CLI_COMMAND, 0o755);
    const git = (...args) => exec('git', args, { cwd: repo, env, capture: true });
    await git('init', '-b', 'main');
    await writeFile(path.join(repo, 'example.txt'), 'base\n');
    await writeFile(path.join(repo, 'other.txt'), 'keep me\n');
    await git('add', '.'); await git('commit', '-m', 'Base');
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await git('checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'committed.txt'), 'feature\n');
    await git('add', '.'); await git('commit', '-m', 'Feature');
    await writeFile(path.join(repo, 'example.txt'), 'working changes\n');
    await mkdir(path.join(repo, 'generated'));
    await mkdir(path.join(repo, 'mixed'));
    await writeFile(path.join(repo, '.gitattributes'), 'generated/** linguist-generated=true\nmixed/generated.ts linguist-generated\n');
    await writeFile(path.join(repo, 'generated/output.ts'), '// generated output\n');
    await writeFile(path.join(repo, 'mixed/generated.ts'), '// generated\n');
    await writeFile(path.join(repo, 'mixed/manual.ts'), '// review this\n');
    await mkdir(path.join(repo, '.vscode'));
    await writeFile(path.join(repo, '.vscode/settings.json'), JSON.stringify({
        'gitTreeCompare.showCommitsPanel': true,
        'gitTreeCompare.compactFolders': false,
        'gitTreeCompare.autoRefresh': false,
        'gitTreeCompare.showCheckboxes': true,
    }));
    const userData = path.join(directory, 'user-data');
    await mkdir(path.join(userData, 'User'), { recursive: true });
    await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
        'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
        'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
        'chat.disableAIFeatures': true, 'workbench.enableExperiments': false,
        'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
        'git.autofetch': false, 'git.confirmSync': false,
        'security.workspace.trust.startupPrompt': 'never',
    }));
    env.GTC_SHARED_DATA = path.join(directory, 'shared-data');
    return { directory, evidence, repo, env, userData, extensions: path.join(directory, 'extensions') };
}

export async function preserve(fixture) {
    await cp(fixture.directory, fixture.evidence, { recursive: true,
        filter: async source => {
            if (path.basename(source).startsWith('chromedriver-') || source === path.join(fixture.directory, 'runtime')) return false;
            const stat = await lstat(source);
            return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
        } });
    await rm(fixture.directory, { recursive: true, force: true });
    console.log(`Test evidence: ${fixture.evidence}`);
}
