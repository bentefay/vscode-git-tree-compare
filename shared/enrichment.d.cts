export interface Selection { left: string; right: string | null; files?: { path: string; source: string; status?: string }[] }
export interface SnapshotFile { path: string; source: string; status: string; before: Side | null; after: Side | null; fingerprint: string; unsupported?: string }
export interface Side { mode: string; object?: string; hash?: string; lines?: number; unsupported?: string }
export interface Snapshot { version: 1; id: string; repo: string; branch: string; head: string; left: string; right: string | null; files: SnapshotFile[] }
export interface Annotation { side: 'before' | 'after'; startLine: number; endLine: number; title: string; body: string; scope?: 'file' | 'comparison' }
export interface FileInfo { path: string; priority: 'normal' | 'important'; kind: string; reason: string; annotations: Annotation[] }
export interface GuideStep { path: string; title: string; description: string; annotation?: number }
export interface Enrichment { version: 1; snapshotId: string; producer: string; summary: string; files: FileInfo[]; guide: GuideStep[] }
export interface EnrichmentState { publicationId?: string; directory: string; current: boolean; fresh: string[]; data: Enrichment | null; snapshot: Snapshot | null }
export function saveSelection(repo: string, selection: Selection, expectedHead?: string): Promise<void>;
export function context(repo: string, selection?: Selection): Promise<Snapshot>;
export function load(repo: string, selection: Selection): Promise<EnrichmentState>;
export function publish(repo: string, file: string): Promise<{ snapshotId: string; file: string }>;
