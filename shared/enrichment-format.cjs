'use strict';

const LABELS = ['behaviour', 'refactor', 'plumbing', 'configuration', 'schema', 'tests', 'docs', 'dependencies', 'generated', 'formatting', 'whitespace', 'other'];
function fail(message) { throw new Error(message); }
function object(value, keys, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name}: expected an object`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name}: unknown field ${key}`);
}
function text(value, max, name) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name}: expected nonempty text of at most ${max} characters`); }
function array(value, min, max, name) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${name}: expected ${min}–${max} entries`); }
function range(value, file, name) {
    if (!['before', 'after'].includes(value.side) || !Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine) || value.startLine < 1 || value.endLine < value.startLine || value.endLine > 1000000) fail(`${name}: invalid 1-based range`);
    if (value.scope !== undefined && !['file', 'comparison'].includes(value.scope)) fail(`${name}: invalid scope`);
    if (!file[value.side] || file.unsupported) fail(`${name}: range requires an existing regular text side`);
}
function normalize(data) {
    if (data.version === 2) return data;
    return { version: 2, snapshotId: data.snapshotId, producer: data.producer, summary: data.summary,
        files: data.files.map(({ kind, ...file }) => ({ ...file, labels: [kind] })),
        guide: data.guide.map(({ path, annotation, title, description }) => ({ title, description,
            links: [{ path, label: path, ...(annotation === undefined ? {} : { annotation }) }] })),
        brief: { visuals: [], focus: [], evidence: [], unknowns: [] } };
}
function links(data) {
    return [
        ...data.guide.flatMap(step => step.links),
        ...['focus', 'evidence', 'unknowns'].flatMap(section => data.brief[section].flatMap(item => item.links)),
        ...data.brief.visuals.flatMap(visual => visual.kind === 'flow' ? visual.steps.flatMap(step => step.links) : visual.links),
    ];
}
function validate(data, snapshot) {
    object(data, ['version', 'snapshotId', 'producer', 'summary', 'files', 'guide', 'brief'], 'result');
    if (data.version !== 2 || data.snapshotId !== snapshot.id) fail('Expected version 2 and the exported snapshotId');
    text(data.producer, 100, 'producer'); text(data.summary, 6000, 'summary');
    array(data.files, 0, 2000, 'files'); array(data.guide, 0, 100, 'guide');
    const known = new Map(snapshot.files.map(file => [file.path, file])), files = new Map();
    let notes = 0, targets = 0;
    for (const file of data.files) {
        object(file, ['path', 'priority', 'labels', 'reason', 'annotations'], 'file');
        if (!known.has(file.path) || files.has(file.path)) fail('file.path: must be a unique path in the exported comparison');
        if (!['low', 'normal', 'important'].includes(file.priority)) fail('file.priority: expected low, normal or important');
        array(file.labels, 1, 4, 'file.labels');
        if (new Set(file.labels).size !== file.labels.length || file.labels.some(label => !LABELS.includes(label))) fail('file.labels: expected unique supported labels');
        text(file.reason, 2000, 'file.reason'); array(file.annotations, 0, 20, 'annotations');
        notes += file.annotations.length; if (notes > 200) fail('At most 200 annotations per result');
        for (const note of file.annotations) {
            object(note, ['side', 'startLine', 'endLine', 'scope', 'title', 'body'], 'annotation');
            range(note, known.get(file.path), 'annotation'); text(note.title, 200, 'annotation.title'); text(note.body, 6000, 'annotation.body');
        }
        files.set(file.path, file);
    }
    const checkLinks = (values, min = 0) => {
        array(values, min, 12, 'links');
        targets += values.length; if (targets > 500) fail('At most 500 diff links per result');
        for (const link of values) {
            object(link, ['path', 'label', 'annotation', 'range'], 'link');
            const file = files.get(link.path);
            if (!file) fail('link.path: must have a file entry in this comparison');
            text(link.label, 200, 'link.label');
            if (link.annotation !== undefined && link.range !== undefined) fail('link: choose an annotation or a range, not both');
            if (link.annotation !== undefined && (!Number.isSafeInteger(link.annotation) || link.annotation < 0 || link.annotation >= file.annotations.length)) fail('link.annotation: invalid zero-based annotation index');
            if (link.range !== undefined) {
                object(link.range, ['side', 'startLine', 'endLine', 'scope'], 'link.range');
                range(link.range, known.get(link.path), 'link.range');
            }
        }
    };
    const covered = new Set();
    for (const step of data.guide) {
        object(step, ['title', 'description', 'links'], 'guide step');
        text(step.title, 200, 'guide.title'); text(step.description, 2000, 'guide.description'); checkLinks(step.links, 1);
        for (const link of step.links) covered.add(link.path);
    }
    for (const file of data.files) if (file.priority === 'important' && !covered.has(file.path)) fail(`Important file missing from review guide: ${file.path}`);
    object(data.brief, ['visuals', 'focus', 'evidence', 'unknowns'], 'brief');
    for (const section of ['focus', 'evidence', 'unknowns']) {
        array(data.brief[section], 0, 8, `brief.${section}`);
        for (const item of data.brief[section]) {
            object(item, ['text', 'links'], `brief.${section} item`); text(item.text, 2000, `brief.${section}.text`); checkLinks(item.links);
        }
    }
    array(data.brief.visuals, 0, 3, 'visuals');
    for (const visual of data.brief.visuals) {
        object(visual, visual.kind === 'flow' ? ['kind', 'title', 'steps'] : ['kind', 'title', 'body', 'links'], 'visual');
        text(visual.title, 200, 'visual.title');
        if (visual.kind === 'flow') {
            array(visual.steps, 2, 12, 'visual.steps');
            for (const step of visual.steps) { object(step, ['label', 'links'], 'flow step'); text(step.label, 200, 'flow.label'); checkLinks(step.links); }
        } else {
            if (!['tree', 'pseudocode', 'diff'].includes(visual.kind)) fail('visual.kind: expected flow, tree, pseudocode or diff');
            text(visual.body, 4000, 'visual.body'); checkLinks(visual.links);
        }
    }
    return data;
}
module.exports = { LABELS, validate, normalize, links };
