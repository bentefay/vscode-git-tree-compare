import { promises as fs, constants } from 'fs';

export const MAX_STATS_BYTES = 1024 * 1024;

/** Statistics are optional: skip links, special files and oversized text files. */
export async function readFileStats(filename: string): Promise<{
    insertions: number | undefined; deletions: number | undefined; isBinary: boolean;
} | undefined> {
    try {
        const before = await fs.lstat(filename);
        if (!before.isFile() || before.size > MAX_STATS_BYTES) return undefined;
        const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > MAX_STATS_BYTES) return undefined;
            // A bounded read also handles files that grow between stat and read.
            const buffer = Buffer.alloc(MAX_STATS_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
                if (!bytesRead) break;
                length += bytesRead;
            }
            if (length > MAX_STATS_BYTES) return undefined;
            const content = buffer.subarray(0, length);
            if (content.includes(0)) return { insertions: undefined, deletions: undefined, isBinary: true };
            let lines = 0;
            for (const byte of content) if (byte === 10) lines++;
            if (length > 0 && content[length - 1] !== 10) lines++;
            return { insertions: lines, deletions: 0, isBinary: false };
        } finally {
            await handle.close();
        }
    } catch {
        return undefined;
    }
}
