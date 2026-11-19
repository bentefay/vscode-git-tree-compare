import { randomBytes } from 'crypto';
import type { EnrichmentState, DiffLink, LinkedText } from '../shared/enrichment.cjs';
import { diffLinks, fileTags, guideTitle } from './enrichmentPresentation';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function briefHtml(state: EnrichmentState | undefined): string {
    const nonce = randomBytes(16).toString('hex'), data = state?.data, fresh = new Set(state?.fresh);
    const indices = new Map(data ? diffLinks(data).map((link, index) => [link, index]) : []);
    const links = (values: DiffLink[]) => values.length ? `<div class="links" aria-label="Open diffs">${values.map(link => {
        const range = link.range;
        const title = `${link.path}${range ? ` · ${range.side}, lines ${range.startLine}–${range.endLine}` : ''}`;
        return `<button class="diff-link" data-link="${indices.get(link)}" title="${escape(title)}">↗ ${escape(link.label)}</button>`;
    }).join('')}</div>` : '';
    const sections = (title: string, items: LinkedText[]) => items.length ? `<section><h2>${title}</h2>${items.map(item => `<div class="point"><p>${escape(item.text)}</p>${links(item.links)}</div>`).join('')}</section>` : '';
    const cards = data?.files.map((file, index) => `<article data-labels="${escape(file.labels.join(' '))}" data-priority="${file.priority}">
        <header><button class="file" data-file="${index}">${escape(file.path)}</button>
        ${fileTags(file).map((tag, i) => `<span class="tag ${!fresh.has(file.path) ? 'muted' : i === 0 && file.priority !== 'normal' ? file.priority : ''}">${escape(tag)}</span>`).join('')}
        ${fresh.has(file.path) ? '' : '<span class="muted">◷ Out of date</span>'}</header><p>${escape(file.reason)}</p>
        ${file.annotations.map((note, annotation) => `<button class="note" data-file="${index}" data-annotation="${annotation}">${escape(note.title)} · ${note.side}, lines ${note.startLine}–${note.endLine}</button>`).join('')}</article>`).join('') ?? '';
    const visuals = data?.brief.visuals.map(visual => `<figure><figcaption>${escape(visual.title)}</figcaption>${visual.kind === 'flow'
        ? `<ol class="flow">${visual.steps.map(step => `<li><strong>${escape(step.label)}</strong>${links(step.links)}</li>`).join('')}</ol>`
        : `<pre class="sketch">${visual.kind === 'diff' ? visual.body.split('\n').map(line => `<span class="${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}">${escape(line)}</span>`).join('\n') : escape(visual.body)}</pre>${links(visual.links)}`}</figure>`).join('') ?? '';
    return `<!doctype html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1000px;margin:auto}
    h1{font-size:25px}h2{font-size:18px;margin-top:26px}p{white-space:pre-wrap;line-height:1.6}.muted,.low{color:var(--vscode-descriptionForeground)}
    article,.point,figure{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:16px;margin:12px 0}header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    button,select{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:1px solid transparent;padding:6px 10px;cursor:pointer;border-radius:3px}
    button:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}.file{font-weight:600}.tag{font-size:12px;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:3px 8px}
    .important{color:var(--vscode-gitTreeCompare-importantForeground,var(--vscode-editorWarning-foreground));border-color:currentColor}
    .note,.diff-link{color:var(--vscode-textLink-foreground);background:none;text-align:left;padding:4px 0}.note{display:block;margin-top:8px}.links{display:flex;gap:8px 20px;flex-wrap:wrap}
    nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}[hidden]{display:none!important}.summary{border-left:3px solid var(--vscode-focusBorder);padding-left:16px}
    .guide{padding-left:24px}.guide>li{padding:8px 0 18px}.guide-title{font-size:16px;font-weight:600}.guide p{margin:8px 0}
    figure{margin:18px 0}figcaption{font-weight:600;margin-bottom:12px}.sketch{font-family:var(--vscode-editor-font-family);overflow-x:auto;line-height:1.6;margin:0 0 8px}
    .added{background:var(--vscode-diffEditor-insertedTextBackground)}.removed{background:var(--vscode-diffEditor-removedTextBackground)}
    .flow{display:flex;flex-wrap:wrap;list-style:none;padding:0;gap:24px}.flow>li{position:relative;border:1px solid var(--vscode-panel-border);padding:12px;flex:1;min-width:140px}.flow>li+li:before{content:'→';position:absolute;left:-21px;top:12px}.flow .links{margin-top:8px}
    </style></head><body><h1>Review Brief</h1>
    ${data ? `<div class="muted">${escape(data.producer)} · ${escape(state!.snapshot!.branch)} · ${state!.snapshot!.left.slice(0, 8)} → ${state!.snapshot!.right?.slice(0, 8) ?? 'Working tree'}</div>
    ${state!.current ? '' : '<p class="muted">◷ This comparison has changed. This is the previous analysis; re-enrich to update it. Old line anchors are disabled where the analysis is stale.</p>'}
    <p class="summary">${escape(data.summary)}</p>${visuals}
    ${sections('Review focus', data.brief.focus)}
    <h2>Review guide</h2><ol class="guide">${data.guide.map((step, index) => `<li><button class="guide-title" data-step="${index}">${escape(guideTitle(step.title))}</button><p>${escape(step.description)}</p>${links(step.links)}</li>`).join('')}</ol>
    ${sections('Evidence', data.brief.evidence)}${sections('Unknowns and questions', data.brief.unknowns)}
    <h2>Files</h2><nav><label for="filter">Show</label><select id="filter"><option value="all">All files</option><option value="important">Important</option><option value="low">Low attention</option>${[...new Set(data.files.flatMap(file => file.labels))].map(label => `<option value="${escape(label)}">${escape(label)}</option>`).join('')}</select><span id="count">${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}</span></nav>
    <section id="files">${cards}</section><p class="muted">Agent explanations are suggestions. Review checkboxes remain yours.</p>` : '<p>No enrichment for this comparison yet. Run the enrich-pr skill, or import its validated JSON from the view menu.</p>'}
    <script nonce="${nonce}">
    const vscode=acquireVsCodeApi(), publication=${JSON.stringify(state?.publicationId ?? '')};
    document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.link!==undefined)vscode.postMessage({action:'link',index:Number(b.dataset.link),publication});
    else if(b.dataset.step!==undefined)vscode.postMessage({action:'step',index:Number(b.dataset.step),publication});
    else if(b.dataset.file!==undefined)vscode.postMessage({action:'file',index:Number(b.dataset.file),annotation:b.dataset.annotation===undefined?undefined:Number(b.dataset.annotation),publication});});
    document.getElementById('filter')?.addEventListener('change',e=>{let count=0;for(const card of document.querySelectorAll('article')){card.hidden=!(e.target.value==='all'||card.dataset.labels.split(' ').includes(e.target.value)||card.dataset.priority===e.target.value);if(!card.hidden)count++;}document.getElementById('count').textContent=count+(count===1?' file':' files');});
    </script></body></html>`;
}
