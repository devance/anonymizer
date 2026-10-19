import { useEffect, useState } from 'react';
import { target } from '@target';
import { ApiError, SIGNED_OUT } from './api';
import { Brand } from './components/Brand';
import { LangSwitch, ThemeSwitch } from './components/Controls';
import { DialogHost } from './components/Dialog';
import { Icon } from './components/icons';
import { t, translateError, useLang } from './i18n';
import { Doc } from './pages/Doc';
import { Home } from './pages/Home';
import { Project } from './pages/Project';
import { Restore } from './pages/Restore';
import { SITE_URL, Settings } from './pages/Settings';
import { Link, match, useLocation } from './router';

/**
 * Errors nobody caught: a lost web session (every later call fails too, so it
 * stays up with a reload button) or a failed call behind a plain button.
 */
function Banner() {
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const out = () => setSignedOut(true);
    const unhandled = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof ApiError && e.reason.status !== 401) setError(e.reason.message);
    };
    window.addEventListener(SIGNED_OUT, out);
    window.addEventListener('unhandledrejection', unhandled);
    return () => {
      window.removeEventListener(SIGNED_OUT, out);
      window.removeEventListener('unhandledrejection', unhandled);
    };
  }, []);
  if (!signedOut && !error) return null;
  return (
    <div className="banner" role="alert">
      <div className="dv-notice error">
        <Icon name="warningCircle" />
        <span className="grow">{signedOut ? t('session.expired') : translateError(error!)}</span>
        {signedOut ? (
          <button className="dv-button primary small" onClick={() => location.reload()}>
            {t('session.reload')}
          </button>
        ) : (
          <button className="dv-button ghost small" onClick={() => setError(null)}>
            {t('dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The app once signed in or unlocked: the top bar and the pages, the same on both targets. */
export function App() {
  useLang();
  const { path } = useLocation();

  let page: React.ReactNode;
  let p: Record<string, string> | null;
  if (path === '/') page = <Home />;
  else if ((p = match('/p/:id', path))) page = <Project key={p.id} id={p.id!} />;
  else if ((p = match('/doc/:id', path))) page = <Doc key={p.id} id={p.id!} />;
  else if (path === '/restore') page = <Restore />;
  else if (path === '/settings') page = <Settings />;
  else
    page = target.page(path) ?? (
      <div className="dv-page empty">
        {t('notFound')} <Link href="/">{t('home')}</Link>
      </div>
    );

  const nav = (href: string, label: string, active: boolean) => (
    <Link href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
      {label}
    </Link>
  );
  const drag = target.dragRegion ? { 'data-tauri-drag-region': true } : {};

  return (
    <>
      <div className="dv-backdrop" aria-hidden="true" />
      <header className={`dv-topbar topbar ${target.kind}`} {...drag}>
        <Link href="/" className="dv-brand" aria-label={`Devance ${t('brand')}`}>
          <Brand product={t('brand')} />
        </Link>
        <nav className="dv-segmented nav" aria-label={t('nav.label')}>
          {nav('/', t('nav.projects'), path === '/' || path.startsWith('/p/') || path.startsWith('/doc/'))}
          {nav('/restore', t('nav.restore'), path === '/restore')}
          {nav('/settings', t('nav.settings'), path === '/settings')}
        </nav>
        <span className="grow" {...drag} />
        <div className="topbar-controls">
          <button type="button" className="dv-button ghost small out-link" onClick={() => target.openExternal(SITE_URL)} title="devance.ca">
            <span>devance.ca</span>
            <Icon name="arrowUpRight" />
          </button>
          <target.TopbarEnd />
          <LangSwitch />
          <ThemeSwitch />
        </div>
      </header>
      <Banner />
      <main id="main">{page}</main>
      <DialogHost />
    </>
  );
}
