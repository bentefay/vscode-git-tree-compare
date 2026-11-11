import { Command, Option } from 'clipanion';
import path from 'node:path';
import { exec } from '../lib/process.mjs';
import { buildPackage, inspectPackage, vsixPath, manifest } from '../lib/package.mjs';
import { verify } from './development.mjs';

export function githubRepository(remote) {
    const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
    if (!match) throw new Error('origin must be a GitHub SSH or HTTPS repository URL.');
    return match[1];
}

export function installArgs(filename, profile, force) {
    return ['--install-extension', filename, ...(profile ? ['--profile', profile] : []), ...(force ? ['--force'] : [])];
}

export class PackageCommand extends Command {
    static paths = [['package']];
    static usage = Command.Usage({ description: 'Build and inspect a VSIX and its SHA-256 checksum.' });
    async execute() { await buildPackage(); }
}

export class ReleaseCommand extends Command {
    static paths = [['release']];
    static usage = Command.Usage({ description: 'Verify, build, and publish a new GitHub release with the VSIX. Requires clean, pushed HEAD and gh authentication.' });
    tag = Option.String('--tag', { required: true });
    draft = Option.Boolean('--draft', false);
    dryRun = Option.Boolean('--dry-run', false);
    async execute() {
        await exec('git', ['check-ref-format', `refs/tags/${this.tag}`], { capture: true });
        if (this.tag.startsWith('-')) throw new Error('Release tags must not start with a dash.');
        const repo = githubRepository(await exec('git', ['remote', 'get-url', 'origin'], { capture: true }));
        const commit = await exec('git', ['rev-parse', 'HEAD'], { capture: true });
        const args = ['release', 'create', this.tag, vsixPath, `${vsixPath}.sha256`, '--repo', repo,
            '--target', commit, '--title', `${manifest.displayName} ${this.tag}`, '--generate-notes',
            ...(this.draft ? ['--draft'] : [])];
        if (this.dryRun) {
            console.log(JSON.stringify({ steps: ['require clean pushed HEAD', 'verify', 'create new release'], command: 'gh', args }, null, 2));
            return;
        }
        if (await exec('git', ['status', '--porcelain'], { capture: true })) throw new Error('Commit your changes before releasing.');
        await exec('gh', ['auth', 'status']);
        // Check the commit is already in the intended repository; never push implicitly.
        await exec('gh', ['api', `repos/${repo}/commits/${commit}`, '--jq', '.sha'], { capture: true });
        // Refuse an existing tag even if it has no release yet (it might point elsewhere).
        const existing = await exec('git', ['ls-remote', '--tags', 'origin', `refs/tags/${this.tag}`], { capture: true });
        if (existing) throw new Error(`Tag ${this.tag} already exists; choose a new release tag.`);
        await verify();
        if (await exec('git', ['status', '--porcelain'], { capture: true }) ||
            await exec('git', ['rev-parse', 'HEAD'], { capture: true }) !== commit) {
            throw new Error('The checkout changed during verification; release cancelled.');
        }
        await exec('gh', args);
    }
}

export class InstallCommand extends Command {
    static paths = [['install']];
    static usage = Command.Usage({ description: 'Build and install this fork into local VS Code, or install --vsix PATH.' });
    vsix = Option.String('--vsix');
    code = Option.String('--code', 'code');
    profile = Option.String('--profile');
    force = Option.Boolean('--force', false);
    dryRun = Option.Boolean('--dry-run', false);
    async execute() {
        const filename = this.vsix ? path.resolve(process.env.GTC_INVOCATION_CWD || process.cwd(), this.vsix) : vsixPath;
        const args = installArgs(filename, this.profile, this.force);
        if (this.dryRun) {
            console.log(JSON.stringify({ build: !this.vsix, command: this.code, args }, null, 2));
            return;
        }
        if (!this.vsix) await buildPackage();
        await inspectPackage(filename);
        await exec(this.code, args);
    }
}
