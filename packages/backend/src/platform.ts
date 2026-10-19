import type { AnalyzeResult, Candidate, ClaudeUsage, EntityAttrs, EntityType, EntityValue, ExtractInfo, FakeKind, ReviewPayload, SealedReal, Steps } from '@anon/core';
import type { LoadedEntity, ModelClient } from '@anon/pipeline';

/**
 * What the shared service needs from where it runs. Everything the two
 * targets do differently sits behind these interfaces; everything else
 * (routes, detection, fakes, review, rendering, restore) is one codebase.
 *
 *              desktop (Tauri, one user)          web (Cloudflare Worker + VPS, many users)
 *   store      SQLCipher through Rust (SqlStore)  D1, real values sealed per project (web/worker)
 *   blobs      encrypted files through Rust       R2, sealed per project
 *   compute    in the page (localCompute)         on the VPS processor, which runs localCompute
 *   queue      in memory, one job at a time       Cloudflare Queues + cron
 *   account    the one local user                 Cloudflare Access user, admins, usage cap
 */

export type Param = string | number | boolean | null;

/** D1-shaped SQL access: the desktop's SQLCipher database, node:sqlite in tests. */
export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  /** One transaction: all statements or none. */
  batch(stmts: Array<{ sql: string; params?: Param[] }>): Promise<void>;
}

/** f = upload or output file, t = extracted text, w = working copy, x = fields. */
export type BlobKind = 'f' | 't' | 'w' | 'x';

/** Which document a blob belongs to: the web seals it with that project's key and binds it to the document. */
export interface BlobOwner {
  projectId: string;
  docId: string;
  /** False only for files the old web version stored unsealed (anonymized outputs). */
  sealed?: boolean;
}

export interface Blobs {
  put(kind: BlobKind, bytes: Uint8Array, owner: BlobOwner): Promise<string>;
  get(key: string, owner: BlobOwner): Promise<Uint8Array<ArrayBuffer>>;
  /** For serving a file: bytes or a stream, whichever the store does cheaply. */
  open(key: string, owner: BlobOwner): Promise<Uint8Array<ArrayBuffer> | ReadableStream>;
  delete(keys: string[]): Promise<void>;
}

/** fetch-shaped access to a helper; the path is relative ("/extract"). */
export type LocalFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Which model reads documents next to the rules and the engine's small model.
 *   none     fast detection only (rules + the engine's small model)
 *   builtin  desktop: a Gemma model in llama-server, downloaded by the app
 *   ollama   desktop: the user's Ollama; web: Ollama on the remote PC
 *   claude   web: Claude on the VPS (admins only)
 */
export type Detector =
  | { engine: 'none' }
  | { engine: 'builtin'; model: string }
  | { engine: 'ollama'; model: string }
  | { engine: 'claude' };

export type DetectorEngine = Detector['engine'];

export type LogLevel = 'info' | 'warn' | 'error';
/** The diagnostic log. Ids, steps, timings, counts and error messages only: never document text, file or project names, or values. */
export type Log = (level: LogLevel, source: string, message: string) => void;

export type DocKind = 'source' | 'anonymized' | 'external' | 'restored';
/** 'waiting': parked until the detection model can run. */
export type DocStatus = 'uploaded' | 'analyzing' | 'waiting' | 'needs_review' | 'rendering' | 'ready' | 'failed';
/** What a running job is doing, for the progress line on the document screen. */
export type Phase = 'extract' | 'detect' | 'render' | 'check';

export interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
  /** Always 'owner' on the desktop. */
  role: 'owner' | 'member';
}

export interface ProjectSummary extends ProjectRow {
  /** Documents at the top level (outputs not counted). */
  documents: number;
  /** People with access, the owner included. */
  members: number;
}

/** A document as the service sees it: the filename in the clear, blobs by key. */
export interface DocRow {
  id: string;
  project_id: string;
  kind: DocKind;
  parent_id: string | null;
  filename: string;
  out_name: string | null;
  mime: string;
  size: number;
  file_key: string | null;
  /** False for the old web version's anonymized outputs, stored unsealed. */
  file_sealed: boolean;
  text_key: string | null;
  work_key: string | null;
  work_mime: string | null;
  fields_key: string | null;
  status: DocStatus;
  error: string | null;
  /** JSON Steps. */
  steps: string;
  /** JSON Review. */
  review: string;
  /** Web: the job's current phase, kept with the row. Desktop: in memory (Progress). */
  phase?: Phase | null;
  created_at: number;
  updated_at: number;
}

export interface Review {
  /** Per-match decisions keyed "start:end", overriding the default. */
  overrides?: Record<string, boolean>;
}

export interface NewDoc {
  id: string;
  projectId: string;
  kind: DocKind;
  parentId?: string;
  filename: string;
  outName?: string;
  mime: string;
  size: number;
  fileKey: string | null;
  textKey?: string | null;
  fieldsKey?: string | null;
  workKey?: string | null;
  workMime?: string | null;
  status: DocStatus;
  steps?: Steps;
}

export interface DocPatch {
  status?: DocStatus;
  error?: string | null;
  steps?: Steps;
  review?: Review;
  textKey?: string;
  fieldsKey?: string;
  workKey?: string | null;
  workMime?: string | null;
}

export interface ProfileEntry {
  id: string;
  type: EntityType;
  real: EntityValue;
}

/** One transaction's worth of entity changes, planned by upsertCandidates (or a render's mentions). */
export interface EntityWrites {
  inserts: Array<{ id: string; type: EntityType; real: SealedReal; indexKey: string; fake: EntityValue; attrs: EntityAttrs; enabled: boolean }>;
  /** An entity's real side, rewritten whole: new surface forms, or what an output wrote (mentions). */
  reals: Array<{ id: string; real: SealedReal }>;
  /** A fake drawn again because it equals a real value of the project; the old one stays an alias once it has left the tool. */
  fakes: Array<{ id: string; fake: EntityValue; aliases: EntityValue[] }>;
  claims: Array<{ kind: FakeKind; scope: string; key: string; entityId: string }>;
}

/** Two writers raced for the same value or fake: reload and plan again. */
export class ConflictError extends Error {}

/**
 * Rows, scoped to whoever is asking: on the web every read checks project
 * membership, so a method returning null or [] is also "not yours".
 */
export interface Store {
  getDetector(): Promise<Detector>;
  setDetector(detector: Detector): Promise<void>;

  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectRow | null>;
  createProject(name: string): Promise<string>;
  renameProject(id: string, name: string): Promise<void>;
  /** The project row; its documents (and their blobs) are deleted first by the caller. */
  deleteProject(id: string): Promise<void>;

  loadEntities(projectIds: string[]): Promise<LoadedEntity[]>;
  /** `${type}|${indexKey}` of each entity of the current normalization, to its id. */
  entityIndex(projectId: string): Promise<Map<string, string>>;
  /** How a value's key is stored: as is on the desktop (the file is encrypted), an HMAC on the web. */
  indexKey(projectId: string, type: EntityType, key: string): Promise<string>;
  /** Fakes claimed across the database, plus those claimed in this project (phones). */
  loadClaims(projectId: string): Promise<Map<FakeKind, Set<string>>>;
  /** All or nothing; throws ConflictError when a unique value or fake was taken meanwhile. */
  writeEntities(projectId: string, writes: EntityWrites): Promise<void>;
  setEntity(projectId: string, id: string, patch: { enabled?: boolean; fake?: EntityValue; aliases?: EntityValue[] }): Promise<void>;
  /** Only an entity whose fake never left the tool. */
  deleteEntity(projectId: string, id: string): Promise<void>;
  /** The fakes a document's output used have left the tool: they can't silently change any more. */
  freezeEntitiesOf(docId: string): Promise<void>;

  insertDoc(doc: NewDoc): Promise<void>;
  getDoc(id: string): Promise<DocRow | null>;
  /** Every document of a project, newest first, outputs included. */
  listDocs(projectId: string): Promise<DocRow[]>;
  outputsOf(docId: string): Promise<Array<{ id: string; kind: string; created_at: number; out_name: string | null }>>;
  updateDoc(id: string, patch: DocPatch): Promise<void>;
  /** Removes documents and their outputs; returns the blob keys they held. */
  deleteDocs(ids: string[]): Promise<string[]>;
  setDocEntities(docId: string, hits: Record<string, number>): Promise<void>;
  /** Documents parked for the model, oldest first. */
  waitingDocs(limit?: number): Promise<Array<{ id: string; project_id: string }>>;
  /** Parked documents back to 'uploaded', in one statement (the web's request has few calls to spare). */
  markUploaded(ids: string[]): Promise<void>;
  countWaiting(): Promise<number>;

  loadProfile(): Promise<ProfileEntry[]>;
  addProfileEntry(type: EntityType, real: EntityValue): Promise<string>;
  deleteProfileEntry(id: string): Promise<void>;
}

/** A stored document as the compute side needs it. */
export interface DocRef {
  id: string;
  projectId: string;
  kind: DocKind;
  mime: string;
  filename: string;
  fileKey: string | null;
  fileSealed: boolean;
  textKey: string | null;
  workKey: string | null;
  workMime: string | null;
  fieldsKey: string | null;
}

export interface Extracted {
  textKey: string;
  fieldsKey: string;
  workKey: string | null;
  workMime: string | null;
  info: ExtractInfo;
  chars: number;
}

export interface RenderedDoc {
  fileKey: string;
  textKey: string;
  size: number;
  outMime: string;
  outName: string;
  verify: NonNullable<Steps['verify']>;
  entityHits: Record<string, number>;
  /** Entities whose mention logs this output changed, their real side to store (see MentionLog). Anonymizing only. */
  reals?: Array<{ id: string; real: SealedReal }>;
}

export interface RestoreInput {
  /** The new document's id, chosen before its blobs are stored. */
  id: string;
  /** Projects the text may come from. */
  projectIds: string[];
  /** Set when the user picked the project. */
  projectId?: string;
  text?: string;
  file?: Uint8Array<ArrayBuffer>;
  mime: string;
  password?: string;
  suggest: boolean;
  detector: Detector;
}

export interface Restored {
  projectId: string;
  ranking: Array<{ projectId: string; hits: number }>;
  steps: Steps;
  usage?: ClaudeUsage;
  fileKey: string;
  textKey: string;
  fieldsKey: string | null;
  workKey: string | null;
  workMime: string | null;
  size: number;
  chars: number;
}

/** Whether the detection model can be reached, for Settings. */
export interface DetectionStatus {
  /** Ollama on the remote PC (web) or the user's Ollama (desktop, not reported here). */
  local: { online: boolean; models: Array<{ name: string; sizeGb: number }>; loaded: string[] };
  claude: boolean;
}

/**
 * The CPU-heavy steps, on stored documents. The desktop runs them in the page
 * (localCompute); the web sends sealed blobs and the project keys to the
 * processor on the VPS, which runs the very same localCompute.
 */
export interface Compute {
  /** A PDF, Word file or photo → text, fields outside the page flow and a working copy, stored. */
  extract(doc: DocRef, password?: string): Promise<Extracted>;
  /** Rules, the engine's small model and the detector's model. Throws DetectorOfflineError when the model can't run now. */
  detect(doc: DocRef, detector: Detector, opts: { useModel: boolean }): Promise<AnalyzeResult>;
  /** The review screen's text, matches and values. */
  review(doc: DocRef, opts: { overrides: Record<string, boolean>; steps: Steps }): Promise<Pick<ReviewPayload, 'text' | 'matches' | 'entities'>>;
  /** The anonymized (or restored) copy of a reviewed document, stored under the output's id. */
  render(doc: DocRef, opts: { outId: string; overrides: Record<string, boolean>; steps: Steps }): Promise<RenderedDoc>;
  /** An outside document: which project its fakes came from, the model's suggestions, stored for review. */
  restore(input: RestoreInput): Promise<Restored>;
  /** Web: the remote PC's model and Claude. */
  status?(): Promise<DetectionStatus | null>;
  /** Web: worth queueing parked documents now? */
  detectorOnline?(detector: Detector): Promise<boolean>;
}

export interface Job {
  docId: string;
  projectId: string;
  kind: 'analyze' | 'render';
  /** PDF password: never stored; sealed in the web queue. */
  password?: string;
  /** Queued again by resumeWaiting, because the model looked ready. */
  resumed?: boolean;
}

export interface JobQueue {
  enqueue(job: Job): Promise<void>;
  /** Several at once (Cloudflare Queues: one call per batch). Without it, enqueue one by one. */
  enqueueAll?(jobs: Job[]): Promise<void>;
}

export interface Progress {
  set(docId: string, phase: Phase | null): Promise<void>;
  get(doc: Pick<DocRow, 'id' | 'phase'>): Phase | null;
}

/** Who is asking, and what they may do. The desktop has one user who may do everything. */
export interface Account {
  /** May change app-wide settings (the detection model). */
  admin: boolean;
  /** Detector engines this target offers. */
  engines: readonly DetectorEngine[];
  /** A cloud model's monthly cap is reached: detection runs without it. */
  capReached(): Promise<boolean>;
  recordUsage(usage: ClaudeUsage): Promise<void>;
}

export interface Scope {
  store: Store;
  blobs: Blobs;
  compute: Compute;
  queue: JobQueue;
  progress: Progress;
  account: Account;
  log: Log;
}

/** What the compute side needs: the engine, a model, the project's values and the blob store. */
export interface ComputeEnv {
  engine: LocalFetch;
  /** A client for this detector, ready to take requests. Null when none is configured; throws DetectorOfflineError when it can't run now. */
  model(detector: Detector): Promise<ModelClient | null>;
  entities(projectIds: string[]): Promise<LoadedEntity[]>;
  blobs: Pick<Blobs, 'get' | 'put'>;
  log: Log;
}

export type { AnalyzeResult, Candidate };
