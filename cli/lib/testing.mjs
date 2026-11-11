import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { exec, root } from './process.mjs';
import { fixture, preserve } from './fixtures.mjs';
import { vscode, versions, runtimeLock, download, patchExecutable } from './runtime.mjs';
import { vsixPath } from './package.mjs';

async function launch(args, env, command = 'node') {
    // Test runners have their own per-test deadlines; cap startup/download hangs too.
    await exec(path.join(root, 'scripts/with-display'), [command, ...args], { env, timeout: 240000 });
}

export async function integration() {
    for (const version of versions) {
        const binary = await vscode(version);
        for (const untrusted of [false, true]) {
            const f = await fixture(`integration-${version}-${untrusted ? 'untrusted' : 'trusted'}`);
            console.log(`Integration ${version} (${untrusted ? 'untrusted' : 'trusted'}): ${f.evidence}`);
            const env = {
                ...f.env, GTC_VSCODE_VERSION: version, GTC_VSCODE_PATH: binary,
                GTC_TEST_REPOSITORY: f.repo, GTC_TEST_RESULTS: f.directory,
                GTC_USER_DATA: f.userData, GTC_EXTENSIONS: f.extensions,
                GTC_UNTRUSTED: untrusted ? '1' : '0',
            };
            try {
                if (untrusted) {
                    // test-electron unconditionally appends --disable-workspace-trust.
                    // Launch the same pinned host directly for the trust regression.
                    await launch([f.repo, '--no-sandbox', '--disable-gpu', '--disable-updates',
                        ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
                        '--skip-welcome', '--skip-release-notes',
                        ...(version === '1.145.3' ? ['--shared-data-dir', env.GTC_SHARED_DATA] : []),
                        '--user-data-dir', f.userData, '--extensions-dir', f.extensions,
                        `--extensionDevelopmentPath=${root}`,
                        `--extensionTestsPath=${path.join(root, 'test/untrusted-runner.cjs')}`], env, binary);
                } else {
                    await launch(['node_modules/@vscode/test-cli/out/bin.mjs'], env);
                }
            } finally { await preserve(f); }
        }
    }
}

export async function ui() {
    const version = versions.at(-1);
    const binary = await vscode(version);
    const platform = process.platform === 'darwin' ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : 'linux64';
    if (process.platform === 'linux' && process.arch !== 'x64') throw new Error('ChromeDriver UI tests require Linux x64 or macOS; use integration tests on Linux ARM.');
    const artifact = runtimeLock.chromedriver?.[platform];
    if (!artifact) throw new Error(`No pinned ChromeDriver for ${platform}`);
    const archive = path.join(root, '.cache/runtimes', `chromedriver-${platform}.zip`);
    await download(artifact, archive);
    const f = await fixture('ui');
    try {
        await exec('unzip', ['-q', archive, '-d', f.directory]);
        await patchExecutable(path.join(f.directory, `chromedriver-${platform}/chromedriver`));
        const cli = process.platform === 'darwin'
            ? path.join(path.dirname(binary), '../Resources/app/bin/code')
            : path.join(path.dirname(binary), 'bin/code');
        await exec(cli, ['--user-data-dir', f.userData, '--extensions-dir', f.extensions,
            '--shared-data-dir', f.env.GTC_SHARED_DATA,
            '--install-extension', vsixPath, '--force'], { env: f.env });
        // ExTester currently has no extra launch-args hook. Keep new VS Code shared
        // application storage out of ~/.vscode-shared with a narrow exec wrapper.
        const launcher = path.join(f.directory, 'code');
        await writeFile(launcher, `#!/usr/bin/env bash\nset -euo pipefail\n# ExTester resets its settings directory; retain our disposable profile across restarts.\nif [[ -d "\${TEST_RESOURCES:?}/restart-profile" ]]; then cp -R -- "\${TEST_RESOURCES:?}/restart-profile/." "\${TEST_RESOURCES:?}/settings/"; fi\nexec "\${GTC_VSCODE_PATH:?}" "--shared-data-dir=\${GTC_SHARED_DATA:?}" ${process.platform === 'linux' ? '--ozone-platform=x11 --force-device-scale-factor=1 ' : ''}"$@"\n`, { mode: 0o755 });
        const env = { ...f.env, GTC_VSCODE_VERSION: version, GTC_VSCODE_PATH: binary,
            GTC_UI_LAUNCHER: launcher,
            GTC_TEST_REPOSITORY: f.repo, GTC_TEST_RESULTS: f.directory,
            TEST_RESOURCES: f.directory, EXTENSIONS_FOLDER: f.extensions };
        delete env.EXTENSION_DEV_PATH;
        console.log(`Packaged UI test: ${f.evidence}`);
        await launch(['node_modules/mocha/bin/mocha.js', '--timeout', '60000',
            '--reporter', './test/reporter.cjs', 'test/ui/*.test.cjs'], env);
    } finally { await preserve(f); }
}
