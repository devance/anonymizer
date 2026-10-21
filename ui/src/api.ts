import type { Detector, DetectorEngine, DetectionStatus } from '@anon/backend';
import { target } from '@target';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the web sign-in session is gone; the app shows a reload banner. */
export const SIGNED_OUT = 'anon:signed-out';

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await target.request(`/api${path}`, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await (await call(method, path, body)).json()) as T;
}

/** Raw bytes of a stored file, for previews. */
export async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await call('GET', path)).arrayBuffer());
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Save (desktop) or download (web) an output; its fakes are frozen from then on. */
export function saveDocument(id: string): Promise<boolean> {
  return target.saveDocument(id);
}

export type { Detector, DetectorEngine };

export interface DetectionSettings {
  detector: Detector;
  waiting: number;
  /** May change the setting (always on the desktop; admins on the web). */
  admin: boolean;
  engines: DetectorEngine[];
  /** Web: the remote PC's model and Claude; null when the processor can't be reached. */
  status?: DetectionStatus | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: number;
  documents: number;
  role: 'owner' | 'member';
  members: number;
}

export interface DocSummary {
  id: string;
  kind: 'source' | 'anonymized' | 'external' | 'restored';
  parentId: string | null;
  filename: string;
  outName: string | null;
  mime: string;
  status: string;
  error: string | null;
  createdAt: number;
  progress: Phase | null;
}

export type Phase = 'extract' | 'detect' | 'render' | 'check';

export interface ProjectDetail {
  project: { id: string; name: string; createdAt: number; role: 'owner' | 'member' };
  documents: DocSummary[];
}

export interface EntityRow {
  id: string;
  type: string;
  real: string;
  fake: string;
  aliases: string[];
  surfaces: string[];
  enabled: boolean;
  frozen: boolean;
}

export interface ReviewMatch {
  start: number;
  end: number;
  surface: string;
  replacement: string;
  entityId: string;
  type: string;
  kind: string;
  confidence: 'high' | 'low';
  key: string;
  checked: boolean;
  suggested?: boolean;
}

export interface Review {
  document: {
    id: string;
    projectId: string;
    projectName: string;
    kind: DocSummary['kind'];
    status: string;
    error: string | null;
    filename: string;
    mime: string;
    createdAt: number;
    parentId: string | null;
    outName: string | null;
  };
  text: string;
  matches: ReviewMatch[];
  entities: Array<{ id: string; type: string; real: string; fake: string; enabled: boolean; frozen: boolean }>;
  steps: {
    detect?: { at: number; found: number; nerError?: string; claudeError?: string };
    route?: { ranking: Array<{ projectId: string; hits: number }> };
    suggest?: { items: unknown[]; error?: string };
    extract?: { sha256: string; ocr: string; pages: number | null };
    verify?: {
      leaks: Array<{ entityId: string; type: string; hits: number; where?: string }>;
      report?: Record<string, unknown>;
      codePages?: number[];
      missingWords?: number;
    };
  };
  outputs: Array<{ id: string; kind: string; createdAt: number; outName: string | null }>;
  progress: Phase | null;
}

export { ENTITY_TYPES } from './entity-types';
