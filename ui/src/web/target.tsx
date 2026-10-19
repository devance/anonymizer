import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, SIGNED_OUT, api, bytes } from '../api';
import { Icon } from '../components/icons';
import { Spinner } from '../components/ui';
import { t, translateError, useLang } from '../i18n';
import type { Target } from '../target-types';
import { CliAuthorize } from './CliAuthorize';
import { webCopy } from './copy';
import { Members } from './Members';
import { WebSettings } from './Settings';

/**
 * The web build, served by the Worker at anon.devance.ca behind Cloudflare
 * Access: the same pages, talking to the same service over HTTPS. Projects
 * and their data live on the server; documents are read on the VPS and the
 * remote PC.
 */

export interface Me {
  email: string;
  usage: { month: string; inputTokens: number; outputTokens: number; calls: number };
  tokenCap: number;
  admin: boolean;
}

/** Who is signed in, once Boot has asked. */
export let me: Me | null = null;

// Links from before the UI moved to hash routes (bookmarks, "anon login" opening /cli/authorize?…) still land.
if (location.pathname !== '/' && !location.pathname.startsWith('/api/')) {
  history.replaceState(null, '', `/#${location.pathname}${location.search}`);
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    // Access answers an expired session with a redirect to its login page,
    // which fetch can't follow cross-origin; catch it and ask for a reload.
    res = await fetch(path, { ...init, credentials: 'same-origin', redirect: 'manual' });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    window.dispatchEvent(new Event(SIGNED_OUT));
    throw new ApiError(401, 'unauthorized');
  }
  return res;
}

/** The output as a download; the server freezes its fakes as it hands it over. */
async function saveDocument(id: string): Promise<boolean> {
  const res = await request(`/api/documents/${id}/download`, { method: 'GET' });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `${res.status}`);
  }
  const name = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name ? decodeURIComponent(name) : 'document';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Asks who is signed in (Access already let them through), then shows the app. */
function Boot({ children }: { children: ReactNode }) {
  useLang();
  const [state, setState] = useState<'loading' | 'ready' | Error>('loading');
  useEffect(() => {
    api
      .get<Me>('/me')
      .then((m) => {
        me = m;
        setState('ready');
      })
      .catch((e: unknown) => setState(e instanceof Error ? e : new Error(String(e))));
  }, []);
  if (state === 'loading')
    return (
      <div className="boot">
        <Spinner />
      </div>
    );
  if (state instanceof Error)
    return (
      <div className="boot">
        <div className="dv-notice error">
          <Icon name="warningCircle" />
          <span className="grow">{state instanceof ApiError && state.status === 401 ? t('session.expired') : translateError(state.message)}</span>
          <button className="dv-button primary small" onClick={() => location.reload()}>
            {t('session.reload')}
          </button>
        </div>
      </div>
    );
  return <>{children}</>;
}

function TopbarEnd() {
  return me ? (
    <span className="who truncate" title={t('settings.signedInAs', { email: me.email })}>
      {me.email}
    </span>
  ) : null;
}

export const target: Target = {
  kind: 'web',
  request,
  saveDocument,
  openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
  Boot,
  TopbarEnd,
  SettingsSections: WebSettings,
  projectTabs: [{ id: 'members', label: 'tab.members', render: ({ projectId, owner }) => <Members projectId={projectId} owner={owner} /> }],
  page: (path) => (path === '/cli/authorize' ? <CliAuthorize /> : null),
  dragRegion: false,
  copy: webCopy,
};

// Builds for web/e2e (vite build --mode web keeps these out unless E2E): the scripts shared with desktop/e2e reach the app here.
if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
  // A file from the repo's fixtures/ folder, handed over by web/e2e/run.mjs.
  const fixture = async (name: string) => {
    const b64 = await (window as unknown as { __e2eFixture: (n: string) => Promise<string> }).__e2eFixture(name);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };
  void import('../router').then(({ navigate }) => Object.assign(window, { __anon: { api, bytes, navigate, fixture, target: 'web' } }));
}
