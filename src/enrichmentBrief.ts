import { randomBytes } from 'crypto';
import type { EnrichmentState } from '../shared/enrichment.cjs';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function briefHtml(state: EnrichmentState | undefined): string {
    const nonce = randomBytes(16).toString('hex');
    const data = state?.data;
    const fresh = new Set(state?.fresh);
    const cards = data?.files.map((file, index) => `<article data-kind="${escape(file.kind)}" data-priority="${file.priority}">
        <header><button class="file" data-file="${index}">${escape(file.path)}</button>
        <span class="tag">${file.priority === 'important' ? 'Important · ' : ''}${escape(file.kind)}</span>
        ${fresh.has(file.path) ? '' : '<span class="stale">Out of date</span>'}</header>
        <p>${escape(file.reason)}</p>
        ${file.annotations.map((note, annotation) => `<button class="note" data-file="${index}" data-annotation="${annotation}">${escape(note.title)} · ${note.side}, lines ${note.startLine}–${note.endLine}</button>`).join('')}
        </article>`).join('') ?? '';
    return `<!doctype html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1000px;margin:auto}
    h1{font-size:25px} h2{font-size:18px} p{white-space:pre-wrap;line-height:1.6} .muted{color:var(--vscode-descriptionForeground)}
    article{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:18px;margin:12px 0} header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    button,select{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:1px solid transparent;padding:6px 10px;cursor:pointer;border-radius:3px}
    button:focus,select:focus{outline:1px solid var(--vscode-focusBorder)} .file{font-weight:600}.tag{font-size:12px}.stale{color:var(--vscode-editorWarning-foreground)}
    .note{display:block;margin-top:8px;color:var(--vscode-textLink-foreground);background:none;text-align:left} nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    [hidden]{display:none!important} ol{line-height:2} .summary{border-left:3px solid var(--vscode-focusBorder);padding-left:16px}
    </style></head><body><h1>Review Brief</h1>
    ${data ? `<div class="muted">${escape(data.producer)} · ${escape(state!.snapshot!.branch)} · ${state!.snapshot!.left.slice(0, 8)} → ${state!.snapshot!.right?.slice(0, 8) ?? 'Working tree'}</div>
    ${state!.current ? '' : '<p class="stale">This comparison has changed. This is the previous analysis; re-enrich to update it. Stale explanations are not attached to code.</p>'}
    <p class="summary">${escape(data.summary)}</p>
    <h2>Suggested reading order</h2><ol>${data.guide.map((step, index) => `<li><button data-step="${index}">${escape(step.title)}</button> <span class="muted">${escape(step.path)}</span></li>`).join('')}</ol>
    <nav><label for="filter">Show</label><select id="filter"><option value="all">All files</option><option value="important">Important</option>${[...new Set(data.files.map(f => f.kind))].map(k => `<option value="${escape(k)}">${escape(k)}</option>`).join('')}</select><span id="count">${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}</span></nav>
    <section id="files">${cards}</section><p class="muted">Agent explanations are suggestions. Review checkboxes remain yours.</p>` : '<p>No enrichment for this comparison yet. Run the enrich-pr skill, or import its validated JSON from the view menu.</p>'}
    <script nonce="${nonce}">
    const vscode=acquireVsCodeApi();
    document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.step!==undefined)vscode.postMessage({action:'step',index:Number(b.dataset.step)});
    else if(b.dataset.file!==undefined)vscode.postMessage({action:'file',index:Number(b.dataset.file),annotation:b.dataset.annotation===undefined?undefined:Number(b.dataset.annotation)});});
    document.getElementById('filter')?.addEventListener('change',e=>{let count=0;for(const card of document.querySelectorAll('article')){card.hidden=!(e.target.value==='all'||card.dataset.kind===e.target.value||card.dataset.priority===e.target.value);if(!card.hidden)count++;}document.getElementById('count').textContent=count+(count===1?' file':' files');});
    </script></body></html>`;
}
