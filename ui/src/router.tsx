import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** Just enough routing for a handful of pages: the URL hash (the app has no server to fall back to index.html) + a path matcher. */

const listeners = new Set<() => void>();

function current() {
  const h = location.hash.replace(/^#/, '') || '/';
  const q = h.indexOf('?');
  return q < 0 ? { path: h, search: '' } : { path: h.slice(0, q), search: h.slice(q) };
}

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', `#${to}`);
  else history.pushState(null, '', `#${to}`);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useLocation() {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const update = () => setLoc(current());
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return loc;
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={`#${href}`}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
}
