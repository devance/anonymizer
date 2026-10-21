import { useCallback, useEffect, useRef, useState } from 'react';
import { ENTITY_TYPES, type ReviewMatch } from '../api';
import { locale, t, translateError, type Key } from '../i18n';
import { Icon } from './icons';

export function Spinner({ big }: { big?: boolean }) {
  return <span className={big ? 'dv-spinner big' : 'dv-spinner'} role="status" aria-label={t('loading')} />;
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="dv-switch" disabled={disabled} onClick={() => onChange(!on)} />;
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="dv-notice error" role="alert">
      <Icon name="warningCircle" />
      <span>{translateError(error instanceof Error ? error.message : String(error))}</span>
    </div>
  );
}

/** Load something, with reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** The highlight colour of a type of value: one of the design system's seven kinds (.dv-mark, .dv-swatch). */
const KINDS: Record<string, string> = {
  person: 'person',
  address: 'address',
  postal_code: 'address',
  email: 'contact',
  phone: 'contact',
  sin: 'id',
  health_card: 'id',
  card_number: 'id',
  bank_account: 'id',
  id_number: 'id',
  dob: 'date',
  date: 'date',
  amount: 'date',
  organization: 'org',
};

export function markKind(type: string) {
  return KINDS[type] ?? 'other';
}

export function typeLabel(type: string) {
  return (ENTITY_TYPES as readonly string[]).includes(type) ? t(`type.${type}` as Key) : type;
}

/** [type, label] pairs for a <select>. */
export function typeOptions(): Array<[string, string]> {
  return ENTITY_TYPES.map((type) => [type, typeLabel(type)]);
}

export function Legend() {
  const items: Array<[string, string]> = [
    ['person', t('legend.person')],
    ['address', t('legend.address')],
    ['phone', t('legend.contact')],
    ['id_number', t('legend.ids')],
    ['dob', t('legend.dates')],
    ['organization', t('legend.orgs')],
  ];
  return (
    <div className="legend">
      {items.map(([type, label]) => (
        <span key={type}>
          <i className={`dv-swatch ${markKind(type)}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The document with every match highlighted. Each highlight shows what will
 * replace it; clicking toggles it. Unchecked matches stay visible but muted,
 * so it's obvious what's being left alone.
 */
export function HighlightedText({
  text,
  matches,
  showReplacement,
  onToggle,
  mono,
}: {
  text: string;
  matches: ReviewMatch[];
  showReplacement: boolean;
  onToggle?: (m: ReviewMatch) => void;
  mono?: boolean;
}) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of matches) {
    if (m.start < at) continue;
    if (m.start > at) parts.push(text.slice(at, m.start));
    const cls = ['dv-mark', markKind(m.type), 'span', m.checked ? '' : 'off', m.confidence === 'low' ? 'low' : '', m.suggested ? 'suggested' : ''].filter(Boolean).join(' ');
    const title = `${typeLabel(m.type)}${m.suggested ? t('mark.suggested') : m.confidence === 'low' ? t('mark.uncertain') : ''} : ${m.surface} → ${m.replacement}${m.checked ? '' : t('mark.skipped')}`;
    parts.push(
      <mark key={m.key} className={cls} title={title} onClick={onToggle ? () => onToggle(m) : undefined}>
        {showReplacement && m.checked ? (
          <>
            <span className="was">{m.surface}</span>
            <span className="repl">{m.replacement}</span>
          </>
        ) : (
          m.surface
        )}
      </mark>,
    );
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <pre className={`doc-text${mono ? ' mono' : ''}`}>{parts}</pre>;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return t('unit.gb', { n: (n / 1e9).toFixed(1) });
  return t('unit.mb', { n: Math.max(1, Math.round(n / 1e6)) });
}
