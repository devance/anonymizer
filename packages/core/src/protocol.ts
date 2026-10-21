/**
 * Messages between the Worker (storage, sign-in, UI) and the processor on the
 * VPS (detection, matching, rendering, Claude). The Worker never decrypts large
 * content: it hands the processor encrypted blobs plus the project's data key
 * for that one request, and stores what comes back.
 */

import type { Candidate } from './merge';
import type { EntityType, EntityValue, Match, MentionLog } from './types';

/** An entities table row as stored in D1 (real value still sealed). */
export interface EntityRow {
  id: string;
  project_id: string;
  type: EntityType;
  real_enc: string;
  fake: string;
  aliases: string;
  attrs: string;
  enabled: number;
  frozen_at: number | null;
}

/** An entity's real side, sealed as one piece with its project's key (web) or in the encrypted database (desktop). */
export interface SealedReal {
  real: EntityValue;
  surfaces: string[];
  /** Real surfaces each output replaced; absent on rows written before restore kept them. */
  mentions?: MentionLog[];
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface Suggestion {
  start: number;
  end: number;
  entityId: string;
}

export interface ExtractInfo {
  sha256: string;
  ocr: 'none' | 'scan' | 'garbled' | 'image';
  pages: number | null;
}

export interface Leak {
  entityId: string;
  type: string;
  hits: number;
  where?: string;
}

export interface Steps {
  extract?: ExtractInfo;
  detect?: { at: number; found: number; nerError?: string; claudeError?: string; model?: string };
  /** Times in a row the analysis was parked for the model right after a resume that found the model ready. */
  parks?: number;
  route?: { ranking: Array<{ projectId: string; hits: number }> };
  suggest?: { items: Suggestion[]; error?: string };
  verify?: {
    leaks: Leak[];
    report?: Record<string, unknown>;
    /** Pages with a barcode or QR code: worth a look even when nothing real was decoded from it. */
    codePages?: number[];
    /** Words of the expected output not found in the actual one. */
    missingWords?: number;
  };
}

export interface ReviewMatch extends Match {
  key: string;
  checked: boolean;
  suggested?: boolean;
}

export interface ReviewDocument {
  id: string;
  projectId: string;
  projectName: string;
  kind: string;
  status: string;
  error: string | null;
  filename: string;
  mime: string;
  createdAt: number;
  parentId: string | null;
  outName: string | null;
}

export interface ReviewPayload {
  document: ReviewDocument;
  text: string;
  matches: ReviewMatch[];
  entities: Array<{ id: string; type: string; real: string; fake: string; enabled: boolean; frozen: boolean }>;
  steps: Steps;
  outputs: Array<{ id: string; kind: string; createdAt: number; outName: string | null }>;
}

/** POST /prepare: an uploaded file → text, out-of-flow fields, and a working copy (OCR'd, decrypted…). */
export interface PrepareSpec {
  docId: string;
  mime: string;
  /** Project data key, base64. */
  key: string;
  password?: string;
}

export interface PrepareMeta extends ExtractInfo {
  hasWork: boolean;
  workMime?: string;
}

/**
 * Which model reads documents: the local one on the PC (private, free, waits
 * when the PC is off) or Claude. Set in the app's Settings.
 */
export interface DetectorSpec {
  engine: 'local' | 'claude';
  /** Ollama model name for the local engine. */
  model?: string;
}

/** POST /analyze: detection on a document's text. */
export interface AnalyzeSpec {
  docId: string;
  key: string;
  entities: EntityRow[];
  /** False skips the model (Claude usage cap reached): regex and known values only. */
  useClaude: boolean;
  detector?: DetectorSpec;
}

export interface AnalyzeResult {
  candidates: Candidate[];
  /** The detection model in the engine failed; regex and known values still ran. */
  nerError?: string;
  claudeError?: string;
  usage?: ClaudeUsage;
  /** Parts whose model answer came back cut off and were split and asked again. */
  modelSplits?: number;
  /** The model that read the text (its name), when one was set and allowed; none means rules, known values and the small model only. */
  model?: string;
}

/** POST /review: the review screen's data, built where the matching happens. */
export interface ReviewSpec {
  document: ReviewDocument;
  key: string;
  entities: EntityRow[];
  overrides: Record<string, boolean>;
  steps: Steps;
  outputs: ReviewPayload['outputs'];
}

/** POST /render: the reviewed document → its anonymized or restored copy. */
export interface RenderSpec {
  docId: string;
  outId: string;
  projectId: string;
  mime: string;
  workMime?: string;
  restore: boolean;
  key: string;
  entities: EntityRow[];
  overrides: Record<string, boolean>;
  steps: Steps;
  filename: string;
}

export interface RenderMeta {
  verify: NonNullable<Steps['verify']>;
  entityHits: Record<string, number>;
  outMime: string;
  outName: string;
}

/** POST /route: an outside document → which project its fakes came from, plus Claude's suggestions. */
export interface RouteSpec {
  docId: string;
  keys: Record<string, string>;
  entities: EntityRow[];
  projectId?: string;
  suggest: boolean;
  mime: string;
  password?: string;
  detector?: DetectorSpec;
}

export interface RouteMeta {
  projectId: string;
  ranking: Array<{ projectId: string; hits: number }>;
  steps: Steps;
  extract?: PrepareMeta;
  usage?: ClaudeUsage;
}

/** Restore matches only use lone names from the project the document was routed to. */
export function matchOptions(restore: boolean, projectId: string) {
  return restore ? { preferProject: projectId } : {};
}
