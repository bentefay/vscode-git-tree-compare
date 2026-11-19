import type { DiffLink, Enrichment, FileInfo } from '../shared/enrichment.cjs';

/** Numbering belongs to the UI, including for previously published agent titles. */
export function guideTitle(title: string): string {
    return title.replace(/^(?:\s*\d+[.)]\s+)+/, '').trim() || title;
}
export function fileTags(file: FileInfo): string[] {
    return [...(file.priority === 'important' ? ['important'] : file.priority === 'low' ? ['low attention'] : []), ...file.labels];
}
export interface EnrichmentLabel { description: string; tooltip: string }
export function fileLabel(file: FileInfo, producer: string, fresh: boolean, current: boolean): EnrichmentLabel {
    const tags = fileTags(file);
    // Compact in the tree; the complete classification remains in the tooltip/brief.
    const shown = tags.slice(0, 2);
    // An en space adds a small gap within VS Code's native description layout.
    return { description: `\u2002${[...shown, ...(!fresh ? ['stale'] : [])].join(' · ')}`,
        tooltip: `${file.reason}\nLabels: ${tags.join(', ')}\n${producer} explanation${fresh ? '' : ' — out of date'}${current ? '' : ' · comparison changed'}. Not a review approval.` };
}
/** Stable index space for webview messages; URLs and arbitrary commands are never accepted. */
export function diffLinks(data: Enrichment): DiffLink[] {
    return [
        ...data.guide.flatMap(step => step.links),
        ...['focus', 'evidence', 'unknowns'].flatMap(section => data.brief[section as 'focus' | 'evidence' | 'unknowns'].flatMap(item => item.links)),
        ...data.brief.visuals.flatMap(visual => visual.kind === 'flow' ? visual.steps.flatMap(step => step.links) : visual.links),
    ];
}
