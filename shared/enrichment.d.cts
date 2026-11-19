export interface Selection { left: string; right: string | null; files?: { path: string; source: string; status?: string }[] }
export interface SnapshotFile { path: string; source: string; status: string; before: Side | null; after: Side | null; fingerprint: string; unsupported?: string }
export interface Side { mode: string; object?: string; hash?: string; lines?: number; unsupported?: string }
export interface Snapshot { version: 1; id: string; repo: string; branch: string; head: string; left: string; right: string | null; files: SnapshotFile[] }
export interface LineRange { side: 'before' | 'after'; startLine: number; endLine: number; scope?: 'file' | 'comparison' }
export interface Annotation extends LineRange { title: string; body: string }
export interface FileInfo { path: string; priority: 'low' | 'normal' | 'important'; labels: string[]; reason: string; annotations: Annotation[] }
export interface DiffLink { path: string; label: string; annotation?: number; range?: LineRange }
export interface GuideStep { title: string; description: string; links: DiffLink[] }
export interface LinkedText { text: string; links: DiffLink[] }
export type Visual = { kind: 'flow'; title: string; steps: { label: string; links: DiffLink[] }[] }
    | { kind: 'tree' | 'pseudocode' | 'diff'; title: string; body: string; links: DiffLink[] };
export interface Brief { visuals: Visual[]; focus: LinkedText[]; evidence: LinkedText[]; unknowns: LinkedText[] }
export interface Enrichment { version: 2; snapshotId: string; producer: string; summary: string; files: FileInfo[]; guide: GuideStep[]; brief: Brief }
export interface EnrichmentState { publicationId?: string; directory: string; current: boolean; fresh: string[]; data: Enrichment | null; snapshot: Snapshot | null }
export function saveSelection(repo: string, selection: Selection, expectedHead?: string): Promise<void>;
export function context(repo: string, selection?: Selection): Promise<Snapshot>;
export function load(repo: string, selection: Selection): Promise<EnrichmentState>;
export function publish(repo: string, file: string): Promise<{ snapshotId: string; file: string }>;
