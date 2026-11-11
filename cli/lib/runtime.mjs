import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { exec, root } from './process.mjs';

export const runtimeLock = JSON.parse(await readFile(path.join(root, 'test/runtime-lock.json'), 'utf8'));
export const versions = Object.keys(runtimeLock.vscode);
export const runtimePlatform = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin') : `linux-${process.arch}`;

export async function hashFile(filename) {
    const hash = createHash('sha256');
    for await (const data of createReadStream(filename)) hash.update(data);
    return hash.digest('hex');
}

export async function download(artifact, filename) {
    await mkdir(path.dirname(filename), { recursive: true });
    let valid = false;
    try { valid = await hashFile(filename) === artifact.sha256; } catch {}
    if (!valid) {
        await exec('curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '300', '--proto', '=https', '--tlsv1.2', '--output', `${filename}.partial`, artifact.url]);
        if (await hashFile(`${filename}.partial`) !== artifact.sha256) throw new Error(`Checksum mismatch: ${artifact.url}`);
        const { rename } = await import('node:fs/promises');
        await rename(`${filename}.partial`, filename);
    }
}

export async function patchExecutable(filename) {
    if (process.platform !== 'linux') return;
    if (!process.env.GTC_LINUX_LOADER) throw new Error('Missing pinned Linux loader; enter devenv.');
    await chmod(filename, 0o755);
    await exec('patchelf', ['--force-rpath', '--set-interpreter', process.env.GTC_LINUX_LOADER,
        '--set-rpath', `$ORIGIN:${process.env.GTC_RUNTIME_LIBRARY_PATH}`, filename]);
}

export async function vscode(version) {
    const artifact = runtimeLock.vscode[version]?.[runtimePlatform];
    if (!artifact) throw new Error(`No pinned VS Code for ${version}/${runtimePlatform}`);
    const directory = path.join(root, '.cache', 'runtimes', `${version}-${runtimePlatform}`);
    const archive = `${directory}${process.platform === 'darwin' ? '.zip' : '.tar.gz'}`;
    await download(artifact, archive);
    const binary = process.platform === 'darwin'
        ? path.join(directory, `Visual Studio Code.app/Contents/MacOS/${Number(version.split('.')[1]) >= 131 ? 'Code' : 'Electron'}`)
        : path.join(directory, `VSCode-linux-${process.arch}/code`);
    const marker = path.join(directory, '.ready');
    try { await access(marker); await access(binary); }
    catch {
        await mkdir(directory, { recursive: true });
        await exec(process.platform === 'darwin' ? 'unzip' : 'tar', process.platform === 'darwin'
            ? ['-q', '-o', archive, '-d', directory] : ['-xzf', archive, '-C', directory]);
        await writeFile(marker, artifact.sha256);
    }
    if (process.platform === 'linux') {
        await patchExecutable(binary);
        await patchExecutable(path.join(path.dirname(binary), 'chrome_crashpad_handler'));
    }
    return binary;
}
