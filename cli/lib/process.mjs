import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

export async function exec(command, args = [], options = {}) {
    const { capture = false, timeout, ...rest } = options;
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: root, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
            detached: Boolean(timeout) && process.platform !== 'win32', ...rest,
        });
        const timer = timeout && setTimeout(() => {
            if (!child.pid) return;
            try {
                // Include the display, driver and editor descendants on timeout.
                if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch {}
        }, timeout);
        let stdout = '', stderr = '';
        child.stdout?.on('data', d => { stdout += d; });
        child.stderr?.on('data', d => { stderr += d; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`${command} exited ${code ?? signal}\n${stderr || stdout}`));
        });
    });
}

export function npm(...args) { return exec('npm', args); }

export function requireEnvironment() {
    if (process.env.GTC_DEVENV !== '1') throw new Error('Use cli/bin/run or enter the pinned devenv shell.');
}
