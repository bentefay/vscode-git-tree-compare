import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { githubRepository, installArgs } from '../commands/distribution.mjs';
import { root } from '../lib/process.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { manifest } from '../lib/package.mjs';

test('GitHub release destinations are parsed without shell interpretation', () => {
    assert.equal(githubRepository('git@github.com:bentefay/vscode-git-tree-compare.git'), 'bentefay/vscode-git-tree-compare');
    assert.equal(githubRepository('https://github.com/me/repo.git'), 'me/repo');
    for (const url of ['https://evil.invalid/me/repo', 'https://github.com/me/repo;echo bad', '-x']) assert.throws(() => githubRepository(url));
});
test('install arguments preserve paths and profile names as separate arguments', () => {
    assert.deepEqual(installArgs('/tmp/a b.vsix', 'My profile', true),
        ['--install-extension', '/tmp/a b.vsix', '--profile', 'My profile', '--force']);
});
test('release and install dry runs expose their intended actions without calling gh or code', () => {
    const run = (...args) => JSON.parse(execFileSync(process.execPath, ['cli/bin/run.mjs', ...args], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GTC_DEVENV: '1' },
    }));
    const release = run('release', '--tag', 'v-test', '--draft', '--dry-run');
    assert.equal(release.command, 'gh');
    assert.ok(release.args.includes('--draft'));
    assert.ok(release.args.some(arg => arg.endsWith('.vsix')));
    const install = run('install', '--profile', 'Test profile', '--dry-run');
    assert.equal(install.command, 'code');
    assert.equal(install.build, true);
    assert.ok(install.args.includes('Test profile'));
});

test('install invokes a substitute editor with an inspected VSIX and preserves the calling directory', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gtc-install-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'extension/dist'), { recursive: true });
    await writeFile(path.join(directory, 'extension/package.json'), JSON.stringify({ publisher: manifest.publisher, name: manifest.name }));
    await writeFile(path.join(directory, 'extension/dist/extension.js'), '// inert package fixture');
    execFileSync('zip', ['-qr', 'fixture.vsix', 'extension'], { cwd: directory });
    const editor = path.join(directory, 'fake-code');
    const result = path.join(directory, 'args.json');
    await writeFile(editor, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.GTC_INSTALL_ARGS, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const env = { ...process.env, GTC_DEVENV: '1', GTC_INSTALL_ARGS: result };
    delete env.GTC_INVOCATION_CWD;
    execFileSync(path.join(root, 'cli/bin/run'), ['install', '--vsix', 'fixture.vsix', '--code', editor, '--profile', 'Test profile'], { cwd: directory, env });
    assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), ['--install-extension', path.join(directory, 'fixture.vsix'), '--profile', 'Test profile']);
    await writeFile(path.join(directory, 'extension/package.json'), JSON.stringify({ publisher: 'letmaik', name: manifest.name }));
    execFileSync('zip', ['-qr', 'wrong.vsix', 'extension'], { cwd: directory });
    assert.throws(() => execFileSync(path.join(root, 'cli/bin/run'), ['install', '--vsix', 'wrong.vsix', '--code', editor], { cwd: directory, env, stdio: 'pipe' }), error => /identity does not match/.test(String(error.stdout)));
});

test('release refuses a dirty checkout before contacting GitHub', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gtc-release-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const script = `#!${process.execPath}\nconst a = process.argv.slice(2);\nif(a[0]==='remote') console.log('https://github.com/me/fork.git');\nelse if(a[0]==='rev-parse') console.log('1234567890123456789012345678901234567890');\nelse if(a[0]==='status') console.log(' M package.json');\nelse if(a[0]!=='check-ref-format') process.exit(2);\n`;
    await writeFile(path.join(directory, 'git'), script, { mode: 0o755 });
    await writeFile(path.join(directory, 'gh'), `#!${process.execPath}\nthrow new Error('GitHub must not be called');\n`, { mode: 0o755 });
    assert.throws(() => execFileSync(process.execPath, ['cli/bin/run.mjs', 'release', '--tag', 'v-test'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GTC_DEVENV: '1', PATH: `${directory}:${process.env.PATH}` }, stdio: 'pipe',
    }), error => /Commit your changes before releasing/.test(String(error.stdout)));
});
