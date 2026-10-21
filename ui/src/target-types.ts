import type { ComponentType, ReactNode } from 'react';
import type { Entry, Key, Lang } from './i18n';

/**
 * What differs between the two builds of this UI. Everything else (every
 * page, the review, the copy) is shared. `@target` resolves at build time to
 * ./desktop/target.tsx (`vite build`, the Tauri app) or ./web/target.tsx
 * (`vite build --mode web`, served by the Worker), so neither build carries
 * the other's code.
 */
export interface Target {
  kind: 'desktop' | 'web';
  /** A request to the service: in the page on the desktop, over HTTPS on the web. */
  request(path: string, init: RequestInit): Promise<Response>;
  /**
   * Hand an output to the user: the native save dialog on the desktop, a
   * download on the web. Either way its fakes are frozen from then on.
   */
  saveDocument(id: string): Promise<boolean>;
  openExternal(url: string): void;
  /** Around the app: first launch and the lock screen on the desktop; the sign-in session on the web. */
  Boot: ComponentType<{ children: ReactNode }>;
  /** The right end of the top bar, before the language and theme switches. */
  TopbarEnd: ComponentType;
  /** Settings below Language and theme. */
  SettingsSections: ComponentType;
  /** Tabs a project shows after Documents and Values (the web's Members). */
  projectTabs: Array<{ id: string; label: Key; render: (p: { projectId: string; owner: boolean }) => ReactNode }>;
  /** Pages only this target has, by path. */
  page(path: string): ReactNode | null;
  /** The top bar drags the window (desktop). */
  dragRegion: boolean;
  /** Copy that reads differently here ("on this computer" vs "on the server"). */
  copy: Partial<Record<Lang, Partial<Record<Key, Entry>>>>;
}
