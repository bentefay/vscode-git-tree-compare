const { defineConfig } = require('@vscode/test-cli');
const path = require('node:path');
module.exports = defineConfig({
    files: 'test/integration/extension.test.cjs',
    version: process.env.GTC_VSCODE_VERSION,
    useInstallation: { fromPath: process.env.GTC_VSCODE_PATH },
    workspaceFolder: process.env.GTC_TEST_REPOSITORY,
    skipExtensionDependencies: true,
    launchArgs: [
        '--user-data-dir', process.env.GTC_USER_DATA,
        '--extensions-dir', process.env.GTC_EXTENSIONS,
        '--skip-welcome', '--skip-release-notes', '--disable-updates',
        '--disable-telemetry', '--disable-gpu', '--no-sandbox',
        ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
        ...(process.env.GTC_VSCODE_VERSION === '1.145.3' ? ['--shared-data-dir', process.env.GTC_SHARED_DATA] : []),
        '--disable-workspace-trust',
    ],
    mocha: { ui: 'bdd', timeout: 30000, reporter: path.join(__dirname, 'test/reporter.cjs') },
});
