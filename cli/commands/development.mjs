import { Command, Option } from 'clipanion';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exec, npm, root } from '../lib/process.mjs';
import { buildPackage } from '../lib/package.mjs';
import { integration, ui } from '../lib/testing.mjs';

export async function doctor() {
    for (const [command, args] of [['node', ['--version']], ['npm', ['--version']], ['git', ['--version']], ['safe-chain', ['--version']], ['npm', ['safe-chain-verify']]]) await exec(command, args);
    if (process.platform === 'linux') await exec('sh', ['-c', 'command -v xvfb-run openbox dbus-run-session patchelf']);
    const lock = JSON.parse(await readFile(path.join(root, 'devenv.lock'), 'utf8'));
    console.log(`Nixpkgs ${lock.nodes.nixpkgs.locked.rev}`);
}

export async function verify() {
    await doctor();
    await exec('shellcheck', ['scripts/devenv', 'scripts/with-display', 'cli/bin/run']);
    await exec('shfmt', ['-i', '4', '-d', 'scripts/devenv', 'scripts/with-display', 'cli/bin/run']);
    await npm('run', 'check');
    await npm('run', 'compile');
    await integration();
    await buildPackage();
    await ui();
    await npm('audit', '--audit-level=moderate');
}

export class SetupCommand extends Command {
    static paths = [['setup']];
    static usage = Command.Usage({ description: 'Install locked dependencies with install scripts disabled, then check the environment.' });
    async execute() { await npm('ci', '--ignore-scripts'); await doctor(); }
}
export class DoctorCommand extends Command {
    static paths = [['doctor']];
    static usage = Command.Usage({ description: 'Check pinned tools and Safe Chain integration.' });
    async execute() { await doctor(); }
}
export class CheckCommand extends Command {
    static paths = [['check']];
    static usage = Command.Usage({ description: 'Typecheck and run fast regression tests.' });
    async execute() { await npm('run', 'check'); }
}
export class BuildCommand extends Command {
    static paths = [['build']];
    static usage = Command.Usage({ description: 'Build the extension bundle using locked tools.' });
    async execute() { await npm('run', 'compile'); }
}
export class VerifyCommand extends Command {
    static paths = [['verify']];
    static usage = Command.Usage({ description: 'Run the complete build, test, package, UI and audit loop.' });
    async execute() { await verify(); }
}
export class TestCommand extends Command {
    static paths = [['test']];
    static usage = Command.Usage({ description: 'Run unit, integration, or UI tests.' });
    layer = Option.String();
    async execute() {
        if (this.layer === 'unit') return npm('run', 'test:unit');
        if (this.layer === 'integration') { await npm('run', 'compile'); await exec('node', ['node_modules/typescript/bin/tsc']); return integration(); }
        if (this.layer === 'ui') { await buildPackage(); return ui(); }
        throw new Error('Expected unit, integration, or ui.');
    }
}
export class DependenciesCommand extends Command {
    static paths = [['dependencies', 'verify']];
    static usage = Command.Usage({ description: 'Verify malware blocking with an empty cache, then install locked dependencies into a disposable directory and audit them.' });
    async execute() {
        await mkdir(path.join(root, '.cache'), { recursive: true });
        const directory = await mkdtemp(path.join(root, '.cache/dependency-check-'));
        await writeFile(path.join(directory, 'package.json'), '{"private":true}');
        let blocked = false;
        try { await exec('npm', ['install', 'safe-chain-test', '--ignore-scripts', '--cache', path.join(directory, 'cache')], { cwd: directory, capture: true }); }
        catch (error) {
            if (!/malware|malicious|blocked/i.test(error.message)) throw error;
            blocked = true;
        }
        if (!blocked) throw new Error('Safe Chain did not block its test package.');
        console.log('Safe Chain blocked its harmless safe-chain-test fixture.');
        for (const file of ['package.json', 'package-lock.json', '.aikido', '.npmrc']) await writeFile(path.join(directory, file), await readFile(path.join(root, file)));
        await exec('npm', ['ci', '--ignore-scripts', '--cache', path.join(directory, 'fresh-cache')], { cwd: directory });
        await exec('npm', ['audit', '--audit-level=moderate'], { cwd: directory });
    }
}
