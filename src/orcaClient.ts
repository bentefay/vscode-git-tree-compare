import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import which = require('which');

export type OrcaRunner = (executable: string, args: string[], cwd: string) => Promise<any>;

/** JSON only; never interpolate prompts or selectors into shell commands. */
export const runOrca: OrcaRunner = (executable, args, cwd) => new Promise((resolve, reject) => {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
        reject(new Error('Windows Orca .cmd/.bat launchers are not supported by this integration.')); return;
    }
    const env = { ...process.env };
    // VS Code may have been opened by an agent or a remote Orca session. This
    // integration deliberately addresses the local desktop and an explicit worktree.
    for (const key of ['ORCA_PAIRING_CODE', 'ORCA_ENVIRONMENT', 'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_ID']) delete env[key];
    execFile(executable, [...args, '--json'], { cwd, env, timeout: 25000, maxBuffer: 4 * 1024 * 1024,
        windowsHide: true, shell: false }, (error, stdout) => {
        let response: any;
        try { response = JSON.parse(stdout); } catch { /* Report a bounded, non-prompt diagnostic below. */ }
        if (response?.ok === true && response.result) { resolve(response.result); return; }
        // agent-context is a local command with a different envelope.
        if (!error && Array.isArray(response?.commands)) { resolve(response); return; }
        const code = response?.error?.code;
        reject(new Error(typeof code === 'string' ? `Orca: ${code}` :
            error?.code === 'ENOENT' ? 'Orca CLI was not found. Set Git Tree Compare › Orca: Cli Path.' :
                'Orca CLI did not return a successful response. Check that Orca is running and up to date.'));
    });
});

export function resolveOrcaExecutable(configured: string, env = process.env, platform = process.platform): string {
    const explicit = configured.trim() || env.ORCA_CLI_COMMAND;
    if (explicit) return explicit; // An invalid override must not silently select another Orca build.
    const name = env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : platform === 'linux' ? 'orca-ide' : 'orca';
    const found = which.sync(name, { nothrow: true });
    if (found) return found;
    // Desktop launchers sometimes have a smaller PATH than interactive shells.
    const fallback = path.join(os.homedir(), '.local', 'bin', name);
    const candidate = which.sync(fallback, { nothrow: true });
    if (candidate) return candidate;
    throw new Error(`Orca CLI (${name}) was not found. Install Orca's CLI or set Git Tree Compare › Orca: Cli Path.`);
}

export interface OrcaTerminal {
    handle: string;
    worktreeId: string;
    title: string | null;
    agentIdentity: string;
    tabId: string;
    leafId: string;
    connected: boolean;
    writable: boolean;
    orphaned?: boolean;
    executionHostId?: string;
    exitCause?: unknown;
}

/** Layout order is stable and user-visible; terminal list order need not be. */
export function selectOrcaAgent(result: any, worktreeId: string): OrcaTerminal {
    if (result.truncated) throw new Error('Orca returned an incomplete pane list. Close unused panes and try again.');
    const candidates: OrcaTerminal[] = (Array.isArray(result.terminals) ? result.terminals : []).filter((t: any) =>
        t.worktreeId === worktreeId && typeof t.handle === 'string' && typeof t.agentIdentity === 'string' &&
        t.agentIdentity.length > 0 && t.connected === true && t.writable === true && !t.orphaned &&
        t.executionHostId === 'local' && !t.exitCause);
    if (!candidates.length) throw new Error('No running terminal agent in this Orca worktree. Open an agent there first. Native chat tabs are not supported by this CLI integration yet.');
    const byHandle = new Map(candidates.map(t => [t.handle, t]));
    const ordered: OrcaTerminal[] = [];
    const active: OrcaTerminal[] = [];
    const walkPanes = (node: any, selected: boolean, leafId: string) => {
        if (!node || typeof node !== 'object') return;
        const terminal = byHandle.get(node.handle);
        if (terminal) {
            ordered.push(terminal);
            if (selected && terminal.leafId === leafId) active.push(terminal);
        }
        // Orca terminal splits use first/second; group splits use children.
        for (const child of [node.first, node.second, ...(Array.isArray(node.children) ? node.children : [])]) {
            if (child) walkPanes(child, selected, leafId);
        }
    };
    const walkGroups = (node: any) => {
        if (!node || typeof node !== 'object') return;
        for (const tab of Array.isArray(node.tabs) ? node.tabs : []) {
            walkPanes(tab.panes, node.activeTabId === tab.tabId, tab.activeLeafId);
        }
        for (const child of [node.first, node.second, ...(Array.isArray(node.children) ? node.children : [])]) {
            if (child) walkGroups(child);
        }
    };
    for (const layout of Array.isArray(result.visualLayouts) ? result.visualLayouts : []) {
        if (layout.worktreeId === worktreeId) walkGroups(layout.root);
    }
    // The current CLI doesn't publish which split editor group has keyboard focus.
    // With several selected agents, use the first in visual order, deterministically.
    return active[0] ?? ordered[0] ?? candidates[0];
}

export class OrcaDeliveryUncertain extends Error {}

export class OrcaClient {
    constructor(private readonly executable: string, private readonly run: OrcaRunner = runOrca) {}

    async prepare(root: string): Promise<OrcaTerminal> {
        const schema = await this.run(this.executable, ['agent-context'], root);
        const send = schema.commands?.find((c: any) => c.command === 'terminal send');
        if (!send?.flags?.includes('wait-submit')) throw new Error('Update Orca: its CLI does not support delivery receipts.');
        const status = await this.run(this.executable, ['status'], root);
        if (!status.runtime?.reachable || status.runtime?.state !== 'ready') throw new Error('Orca is not running or its runtime is not ready.');
        if (!status.runtime.capabilities?.includes('terminal.prompt-delivery.v1')) throw new Error('Update Orca: its runtime does not support delivery receipts.');
        const { worktree } = await this.run(this.executable, ['worktree', 'show', '--worktree', `path:${root}`], root);
        if (!worktree?.id || worktree.hostId !== 'local' || !worktree.path ||
            await realpath(worktree.path) !== await realpath(root)) {
            throw new Error('Orca did not resolve this exact local Git worktree. Open it in Orca first.');
        }
        const selector = worktree.identity?.key ? `identity:${worktree.identity.key}` : `id:${worktree.id}`;
        const list = await this.run(this.executable, ['terminal', 'list', '--worktree', selector, '--include-visual-layouts'], root);
        return selectOrcaAgent(list, worktree.id);
    }

    async send(root: string, target: OrcaTerminal, prompt: string): Promise<{ started: boolean; focusWarning: boolean }> {
        // Recheck the exact handle immediately before sending; never redirect a stale
        // handle to a newly opened pane or send review text to an ordinary shell.
        const current = await this.run(this.executable, ['terminal', 'show', '--terminal', target.handle], root);
        const t = current.terminal;
        if (!t || t.handle !== target.handle || t.worktreeId !== target.worktreeId ||
            t.agentIdentity !== target.agentIdentity || t.executionHostId !== 'local' ||
            !t.connected || !t.writable || t.orphaned || t.exitCause) {
            throw new Error('The selected Orca agent is no longer available. Your note has been kept.');
        }
        let response: any;
        try {
            response = await this.run(this.executable, ['terminal', 'send', '--terminal', target.handle,
                '--text', prompt, '--enter', '--wait-submit', '10'], root);
        } catch {
            throw new OrcaDeliveryUncertain('Orca delivery could not be confirmed. Check the agent before sending again; your note has been kept.');
        }
        if (response.send?.accepted === false) throw new Error('Orca refused the message. Your note has been kept.');
        if (response.send?.accepted !== true || !response.send.prompt?.requestId) {
            throw new OrcaDeliveryUncertain('Orca returned no delivery receipt. Check the agent; this note will not be resent automatically.');
        }
        let focusWarning = false;
        try {
            const result = await this.run(this.executable, ['terminal', 'switch', '--terminal', target.handle], root);
            focusWarning = result.focus?.navigated === false;
        }
        catch { focusWarning = true; }
        return { started: response.send.prompt.stages?.includes('turn_started') === true, focusWarning };
    }
}
