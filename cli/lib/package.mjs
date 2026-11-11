import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { exec, root } from './process.mjs';

export const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
export const vsixPath = path.join(root, 'artifacts', `${manifest.name}-${manifest.version}.vsix`);

export async function inspectPackage(filename) {
    const entries = (await exec('unzip', ['-Z1', filename], { capture: true })).split('\n');
    const bundled = JSON.parse(await exec('unzip', ['-p', filename, 'extension/package.json'], { capture: true }));
    if (bundled.publisher !== manifest.publisher || bundled.name !== manifest.name) {
        throw new Error('VSIX identity does not match this fork.');
    }
    if (!entries.includes('extension/dist/extension.js')) throw new Error('Missing extension bundle.');
    const forbidden = entries.filter(p => /^extension\/(?:cli|test|src|out|node_modules|artifacts|\.cache|\.devenv|\.git)\//.test(p));
    if (forbidden.length) throw new Error(`Unexpected VSIX contents: ${forbidden.join(', ')}`);
    return bundled;
}

export async function buildPackage() {
    await mkdir(path.dirname(vsixPath), { recursive: true });
    await exec('node', ['node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies', '--out', vsixPath]);
    await inspectPackage(vsixPath);
    const sha256 = createHash('sha256').update(await readFile(vsixPath)).digest('hex');
    await writeFile(`${vsixPath}.sha256`, `${sha256}  ${path.basename(vsixPath)}\n`);
    console.log(`Packaged ${vsixPath}\nSHA-256 ${sha256}`);
    return vsixPath;
}
