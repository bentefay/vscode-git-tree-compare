import { minimatch } from 'minimatch';
import type { Repository } from './git/git';

export async function deemphasizedPaths(repository: Repository, paths: string[], patterns: string[], generated: boolean): Promise<Set<string>> {
    const result = new Set(paths.filter(p => patterns.some(pattern => minimatch(p, pattern, { dot: true, nonegate: true, nocomment: true }))));
    for (let offset = 0; offset < paths.length; offset += 500) {
        const batch = paths.slice(offset, offset + 500);
        const { stdout } = await repository.exec(['check-attr', '-z', '--stdin', 'linguist-generated', 'git-tree-compare-deemphasized'],
            { input: batch.join('\0') + '\0', log: false });
        const fields = stdout.split('\0');
        for (let i = 0; i + 2 < fields.length; i += 3) {
            const [file, attribute, value] = fields.slice(i, i + 3);
            if ((attribute === 'git-tree-compare-deemphasized' || generated) && (value === 'set' || value === 'true')) {
                result.add(file);
            }
        }
    }
    return result;
}
