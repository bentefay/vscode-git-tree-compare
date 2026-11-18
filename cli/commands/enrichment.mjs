import { Command, Option } from 'clipanion';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import core from '../../shared/enrichment.cjs';
import { exec, root } from '../lib/process.mjs';

const invocation = () => process.env.GTC_INVOCATION_CWD || process.cwd();
class RepositoryCommand extends Command {
    repo = Option.String('--repo');
    repository() { return path.resolve(invocation(), this.repo || '.'); }
}
export class EnrichContextCommand extends RepositoryCommand {
    static paths = [['enrich', 'context']];
    static usage = Command.Usage({ description: 'Capture the editor comparison, or explicit --base/--right, for enrichment.' });
    base = Option.String('--base');
    right = Option.String('--right');
    out = Option.String('--out');
    async execute() {
        if (this.right && !this.base) throw new Error('--right requires --base.');
        const snapshot = await core.context(this.repository(), this.base ? { left: this.base, right: this.right || null } : undefined);
        const output = JSON.stringify(snapshot, null, 2) + '\n';
        if (this.out) await writeFile(path.resolve(invocation(), this.out), output, { mode: 0o600 });
        else this.context.stdout.write(output);
    }
}
export class EnrichValidateCommand extends RepositoryCommand {
    static paths = [['enrich', 'validate']];
    static usage = Command.Usage({ description: 'Validate enrichment JSON against the captured and current comparison.' });
    file = Option.String('--file', { required: true });
    async execute() {
        const { snapshot } = await core.validateFile(this.repository(), path.resolve(invocation(), this.file));
        this.context.stdout.write(JSON.stringify({ valid: true, snapshotId: snapshot.id }) + '\n');
    }
}
export class EnrichPublishCommand extends RepositoryCommand {
    static paths = [['enrich', 'publish']];
    static usage = Command.Usage({ description: 'Validate and atomically publish enrichment to this worktree.' });
    file = Option.String('--file', { required: true });
    async execute() { this.context.stdout.write(JSON.stringify(await core.publish(this.repository(), path.resolve(invocation(), this.file))) + '\n'); }
}
export class EnrichSchemaCommand extends Command {
    static paths = [['enrich', 'schema']];
    static usage = Command.Usage({ description: 'Print the enrichment JSON Schema. Validation also checks Git content and freshness.' });
    async execute() { this.context.stdout.write(await readFile(path.join(root, 'shared/enrichment.schema.json'), 'utf8')); }
}
export class SkillsInstallCommand extends Command {
    static paths = [['skills', 'install']];
    static usage = Command.Usage({ description: 'Install enrich-pr globally for Codex and/or Claude using the pinned skills package.' });
    global = Option.Boolean('--global', false);
    agents = Option.Array('--agent', []);
    dryRun = Option.Boolean('--dry-run', false);
    async execute() {
        if (!this.global) throw new Error('Use --global to install the skill for your user account.');
        const agents = this.agents.length ? this.agents : ['codex', 'claude-code'];
        if (agents.some(a => !['codex', 'claude-code'].includes(a))) throw new Error('Supported agents: codex, claude-code');
        const launcher = path.join(root, 'cli/bin/run');
        if (this.dryRun) {
            this.context.stdout.write(`Install enrich-pr globally for ${agents.join(', ')} using skills@1.5.26.\nThe installed helper will invoke ${launcher}; keep this checkout available.\n`);
            return;
        }
        const staging = await mkdtemp(path.join(os.tmpdir(), 'gtc-skill-'));
        try {
            const skill = path.join(staging, 'enrich-pr');
            await cp(path.join(root, 'skills/enrich-pr'), skill, { recursive: true });
            await writeFile(path.join(skill, 'scripts/checkout.json'), JSON.stringify({ launcher }));
            await exec(process.execPath, [path.join(root, 'node_modules/skills/bin/cli.mjs'), 'add', staging,
                '--global', '--agent', ...agents, '--skill', 'enrich-pr', '--yes', '--copy'],
                { env: { ...process.env, DISABLE_TELEMETRY: '1' } });
        } finally { await rm(staging, { recursive: true, force: true }); }
    }
}
