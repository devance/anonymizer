import { useEffect, useMemo, useRef, useState } from 'react';
import { api, bytes, saveDocument, type Phase, type Review, type ReviewMatch } from '../api';
import { Icon, type IconName } from '../components/icons';
import { PdfPreview } from '../components/PdfPreview';
import { ErrorNotice, HighlightedText, Legend, Spinner, Toggle, copyText, formatDate, typeLabel, typeOptions, useLoad } from '../components/ui';
import { docError, t, translateError, warning, type Key } from '../i18n';
import { Link, navigate } from '../router';

const isText = (mime: string) => ['text/plain', 'text/markdown'].includes(mime);

export function Doc({ id }: { id: string }) {
  const { data, error, reload, setData } = useLoad(() => api.get<Review>(`/documents/${id}`), [id]);

  // Files are analyzed and rendered on a queue; poll while that runs, and
  // now and then while the document waits for the model.
  const status = data?.document.status;
  const busy = status && ['uploaded', 'analyzing', 'rendering'].includes(status);
  useEffect(() => {
    if (!busy && status !== 'waiting') return;
    const t = setTimeout(() => void reload(), busy ? 1000 : 10_000);
    return () => clearTimeout(t);
  }, [data, busy, status, reload]);

  if (error)
    return (
      <div className="dv-page narrow">
        <ErrorNotice error={error} />
      </div>
    );
  if (!data)
    return (
      <div className="dv-page narrow">
        <Spinner />
      </div>
    );
  if (data.document.status === 'uploaded' || data.document.status === 'analyzing') return <Analyzing review={data} />;
  if (data.document.status === 'waiting') return <Waiting review={data} onRetry={reload} />;
  if (data.document.status === 'failed' && data.document.error === 'password_required') return <PasswordNeeded review={data} onDone={reload} />;
  const kind = data.document.kind;
  if (kind === 'anonymized' || kind === 'restored') return <Output review={data} />;
  return <ReviewPage review={data} onChange={reload} setReview={setData} />;
}

function Header({ review, title, children }: { review: Review; title?: string; children?: React.ReactNode }) {
  const d = review.document;
  return (
    <header className="dv-page-head">
      <div className="grow">
        <Link href={`/p/${d.projectId}`} className="dv-crumb">
          <Icon name="arrowLeft" />
          {d.projectName}
        </Link>
        <h1 className="truncate">{d.kind === 'anonymized' ? (d.outName ?? t('doc.anonymizedCopy')) : d.filename}</h1>
        <p className="meta dv-num">{title ? `${title}, ${formatDate(d.createdAt)}` : formatDate(d.createdAt)}</p>
      </div>
      {children}
    </header>
  );
}

/** Reading a document: where the work is, from review.progress. */
function Analyzing({ review }: { review: Review }) {
  const file = !isText(review.document.mime);
  const phases: Array<{ id: Phase | 'review'; label: Key }> = [
    ...(file ? [{ id: 'extract' as const, label: 'phase.extract' as const }] : []),
    { id: 'detect', label: 'phase.detect' },
    { id: 'review', label: 'phase.review' },
  ];
  const now = review.document.status === 'uploaded' ? -1 : Math.max(0, phases.findIndex((p) => p.id === (review.progress ?? (file ? 'extract' : 'detect'))));
  return (
    <div className="dv-page narrow">
      <Header review={review} title={t('doc.reading')} />
      <div className="dv-shell">
        <div className="dv-core work" role="status" aria-live="polite">
          <div className="work-title">
            <Spinner big />
            {review.document.status === 'uploaded' ? t('doc.waitingEngine') : t(phases[now]?.label ?? 'phase.detect')}
          </div>
          <ol className="phases" aria-label={t('doc.reading')}>
            {phases.map((p, i) => (
              <li key={p.id} className={i < now ? 'done' : i === now ? 'current' : ''} aria-current={i === now ? 'step' : undefined}>
                <span className="bar" />
                <span className="label">
                  {i < now && <Icon name="check" />}
                  {t(p.label)}
                </span>
              </li>
            ))}
          </ol>
          <p className="muted small">
            {file ? t('doc.readingFile') : t('doc.readingText')} {t('doc.canLeave')}
          </p>
        </div>
      </div>
    </div>
  );
}

function StateCard({ icon, title, body, children }: { icon: IconName; title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="dv-core work">
      <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
        <span className="state-icon">
          <Icon name={icon} />
        </span>
        <div className="stack" style={{ gap: 4 }}>
          <h2>{title}</h2>
          <p className="muted">{body}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Waiting({ review, onRetry }: { review: Review; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="dv-page narrow">
      <Header review={review} title={t('doc.reading')} />
      <div className="dv-shell">
        <StateCard icon="hourglass" title={t('doc.waitingTitle')} body={t('doc.waitingBody')}>
          <ErrorNotice error={error} />
          <div className="row">
            <button
              className="dv-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.post(`/documents/${review.document.id}/analyze`);
                } catch (e) {
                  setError(e);
                }
                await onRetry();
                setBusy(false);
              }}
            >
              {busy ? <Spinner /> : <Icon name="restore" />}
              {t('doc.tryNow')}
            </button>
            <Link href="/settings" className="small">
              {t('doc.pickModel')}
            </Link>
          </div>
        </StateCard>
      </div>
    </div>
  );
}

function PasswordNeeded({ review, onDone }: { review: Review; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="dv-page narrow">
      <Header review={review} title={t('doc.password')} />
      <form
        className="dv-shell"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post(`/documents/${review.document.id}/analyze`, { password });
            await onDone();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <StateCard icon="lockKey" title={t('doc.passwordProtected')} body={t('doc.passwordNote')}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="dv-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('doc.pdfPassword')} autoFocus aria-label={t('doc.pdfPassword')} style={{ flex: 1 }} />
            <button className="dv-button primary has-icon" type="submit" disabled={!password}>
              <span>{t('open')}</span>
              <span className="dv-button-icon">
                <Icon name="arrowRight" />
              </span>
            </button>
          </div>
          <ErrorNotice error={error} />
        </StateCard>
      </form>
    </div>
  );
}

function ReviewPage({ review, onChange, setReview }: { review: Review; onChange: () => Promise<void>; setReview: (r: Review) => void }) {
  const restore = review.document.kind === 'external';
  const [showRepl, setShowRepl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const [selType, setSelType] = useState('person');
  const [selError, setSelError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  const checked = review.matches.filter((m) => m.checked).length;
  const lowUnchecked = review.matches.filter((m) => !m.checked && m.confidence === 'low' && !m.suggested).length;
  const suggestions = review.matches.filter((m) => m.suggested).length;
  const inDoc = useMemo(() => {
    const ids = new Map<string, number>();
    for (const m of review.matches) ids.set(m.entityId, (ids.get(m.entityId) ?? 0) + 1);
    return review.entities.filter((e) => ids.has(e.id)).map((e) => ({ ...e, hits: ids.get(e.id)! }));
  }, [review]);
  const disabledInProject = review.entities.filter((e) => !e.enabled);

  async function toggle(m: ReviewMatch) {
    setReview({ ...review, matches: review.matches.map((x) => (x.key === m.key ? { ...x, checked: !x.checked } : x)) });
    try {
      await api.patch(`/documents/${review.document.id}/review`, { overrides: { [m.key]: !m.checked } });
    } catch (e) {
      setError(e);
      await onChange();
    }
  }

  async function setEnabled(entityId: string, enabled: boolean) {
    try {
      await api.patch(`/projects/${review.document.projectId}/entities/${entityId}`, { enabled });
    } catch (e) {
      setError(e);
    }
    await onChange();
  }

  async function renderOutput() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/documents/${review.document.id}/render`);
      // Renders run on the job queue: wait for the new copy.
      const started = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const r = await api.get<Review>(`/documents/${review.document.id}`);
        if (r.document.status !== 'rendering') {
          if (r.document.error) throw new Error(docError(r.document.error));
          if (r.outputs[0]) return navigate(`/doc/${r.outputs[0].id}`);
          throw new Error(t('doc.copyNotCreated'));
        }
        if (Date.now() - started > 15 * 60_000) throw new Error(t('doc.stillWorking'));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function onMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || text.length > 200 || !textRef.current?.contains(sel.anchorNode)) {
      setSelection(null);
      return;
    }
    setSelError(null);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const box = textRef.current.getBoundingClientRect();
    // Keep the popover (about 460 px wide) inside the page.
    setSelection({ text, x: Math.max(8, Math.min(rect.left - box.left, box.width - 468)), y: rect.bottom - box.top + 8 });
  }

  async function addSelection() {
    if (!selection) return;
    setAdding(true);
    setSelError(null);
    try {
      await api.post(`/projects/${review.document.projectId}/entities`, { type: selType, text: selection.text });
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      await onChange();
    } catch (e) {
      setSelError(e);
    } finally {
      setAdding(false);
    }
  }

  const status = review.document.status;
  const detect = review.steps.detect;

  return (
    <div className="dv-page">
      <Header review={review} title={restore ? t('doc.restore') : t('doc.review')} />
      <div className="dv-split">
        <div className="stack" style={{ gap: 14 }}>
          {status === 'analyzing' && (
            <div className="dv-notice ok">
              <Spinner />
              <span>{t('doc.analyzing')}</span>
            </div>
          )}
          {status === 'failed' && (
            <div className="dv-notice error">
              <Icon name="warningCircle" />
              <span>{t('doc.analysisFailed', { e: docError(review.document.error ?? '') })}</span>
            </div>
          )}
          {status !== 'failed' && review.document.error && (
            <div className="dv-notice error">
              <Icon name="warningCircle" />
              <span>{docError(review.document.error)}</span>
            </div>
          )}
          {detect?.nerError && (
            <div className="dv-notice">
              <Icon name="warning" />
              <span>{t('doc.nerFailed')}</span>
            </div>
          )}
          {detect?.claudeError && !/no detection model/i.test(detect.claudeError) && (
            <div className="dv-notice">
              <Icon name="warning" />
              <span>
                {t('doc.modelFailed', { e: translateError(detect.claudeError) })}
                <button
                  className="dv-button link"
                  onClick={async () => {
                    try {
                      await api.post(`/documents/${review.document.id}/analyze`);
                    } catch (e) {
                      setError(e);
                    }
                    await onChange();
                  }}
                >
                  {t('doc.tryAgain')}
                </button>
                .
              </span>
            </div>
          )}
          {review.steps.suggest?.error && (
            <div className="dv-notice">
              <Icon name="warning" />
              <span>{t('doc.suggestFailed', { e: review.steps.suggest.error })}</span>
            </div>
          )}
          <div className="dv-shell">
            <div className="dv-core paper" ref={textRef} onMouseUp={onMouseUp}>
              <HighlightedText text={review.text} matches={review.matches} showReplacement={showRepl} onToggle={toggle} mono={review.document.mime === 'text/markdown'} />
              {selection && (
                <div className="popover" style={{ left: selection.x, top: selection.y }} onMouseUp={(e) => e.stopPropagation()}>
                  <span className="quote truncate">{t('doc.quote', { s: selection.text })}</span>
                  <select className="dv-select" value={selType} onChange={(e) => setSelType(e.target.value)} aria-label={t('type')}>
                    {typeOptions().map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <button className="dv-button primary small" onClick={addSelection} disabled={adding}>
                    {adding ? <Spinner /> : <Icon name="plus" />}
                    {restore ? t('add') : t('doc.replaceThis')}
                  </button>
                  {selError != null && (
                    <div style={{ flexBasis: '100%' }}>
                      <ErrorNotice error={selError} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {!restore && (
            <p className="selection-hint">
              <Icon name="info" />
              <span>{t('doc.missed')}</span>
            </p>
          )}
        </div>

        <aside className="side">
          <div className="dv-shell">
            <div className="dv-core summary">
              <div>
                <h2>{restore ? t('doc.putBack') : t('doc.replaceWithFakes')}</h2>
                <p className="count">{t(restore ? 'doc.countRestore' : 'doc.countReplace', { c: checked, n: review.matches.length })}</p>
              </div>
              {restore && lowUnchecked > 0 && (
                <div className="dv-notice">
                  <Icon name="warning" />
                  <span>{t('doc.lowUnchecked', { n: lowUnchecked })}</span>
                </div>
              )}
              {restore && suggestions > 0 && (
                <div className="dv-notice ok">
                  <Icon name="sparkle" />
                  <span>{t('doc.suggested', { n: suggestions })}</span>
                </div>
              )}
              <Legend />
              <label className="switch-row">
                <Toggle on={showRepl} onChange={setShowRepl} label={t('doc.showReplacements')} />
                {t('doc.showReplacements')}
              </label>
              <button className="dv-button primary has-icon" onClick={renderOutput} disabled={busy || status === 'analyzing' || review.matches.length === 0}>
                <span>{restore ? t('doc.createRestored') : t('doc.createAnonymized')}</span>
                <span className="dv-button-icon">{busy ? <Spinner /> : <Icon name="arrowRight" />}</span>
              </button>
              {busy && !isText(review.document.mime) && <p className="muted small">{t('doc.rewriting')}</p>}
              {review.outputs[0] && (
                <p className="small muted">
                  {t('doc.latest')}
                  <Link href={`/doc/${review.outputs[0].id}`}>{review.outputs[0].outName ?? t('doc.output')}</Link>
                </p>
              )}
              <ErrorNotice error={error} />
            </div>
          </div>

          {restore && review.steps.route && (
            <div className="dv-tile small">
              <h3>{review.document.projectName}</h3>
              <p className="muted" style={{ marginTop: 4 }}>
                {t('doc.picked', { n: review.steps.route.ranking[0]?.hits ?? 0 })}
                {review.steps.route.ranking.length > 1 ? t('doc.othersMatched', { n: review.steps.route.ranking.length - 1 }) : ''}.
              </p>
            </div>
          )}

          <div className="dv-tile">
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              {t('doc.inThisDoc')}
              {inDoc.length > 0 && <span className="dv-badge dv-num">{inDoc.length}</span>}
            </h3>
            <div className="entity-list">
              {inDoc.length === 0 && <p className="muted small" style={{ paddingTop: 10 }}>{t('doc.nothingFound')}</p>}
              {inDoc.map((e) => (
                <div key={e.id} className="entity">
                  <Toggle on={e.enabled} label={t('replaceX', { v: e.real })} onChange={(v) => void setEnabled(e.id, v)} />
                  <div style={{ minWidth: 0 }}>
                    <div className="truncate real">{restore ? e.fake : e.real}</div>
                    <div className="truncate fake">
                      <Icon name="arrowRight" className="arrow" />
                      {restore ? e.real : e.fake}
                    </div>
                    <div className="sub">
                      {typeLabel(e.type)}, {t('doc.hits', { n: e.hits })}
                    </div>
                  </div>
                </div>
              ))}
              {!restore && disabledInProject.length > 0 && (
                <details className="more-entities">
                  <summary>{t('doc.notReplaced', { n: disabledInProject.length })}</summary>
                  {disabledInProject.map((e) => (
                    <div key={e.id} className="entity">
                      <Toggle on={false} label={t('replaceX', { v: e.real })} onChange={(v) => void setEnabled(e.id, v)} />
                      <div className="truncate">
                        {e.real} <span className="muted">({typeLabel(e.type)})</span>
                      </div>
                    </div>
                  ))}
                </details>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Output({ review }: { review: Review }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [compare, setCompare] = useState(true);
  const restored = review.document.kind === 'restored';
  const verify = review.steps.verify;
  const leaks = verify?.leaks ?? [];
  const isPdf = review.document.mime === 'application/pdf';
  const text = isText(review.document.mime);
  const parent = review.document.parentId;
  return (
    <div className={`dv-page${isPdf && compare ? '' : ' narrow'}`}>
      <Header review={review} title={restored ? t('doc.restoredCopy') : t('doc.anonymizedCopy')} />
      <div className="stack" style={{ gap: 14 }}>
        {!restored && leaks.length === 0 && (
          <div className="dv-notice ok">
            <Icon name="shieldCheck" />
            <span>{isPdf ? t('out.checkedPdf') : t('out.checked')}</span>
          </div>
        )}
        {!restored && leaks.length > 0 && (
          <div className="dv-notice error">
            <Icon name="warningCircle" />
            <span>
              {t('out.leaks', {
                n: leaks.reduce((n, l) => n + l.hits, 0),
                list: leaks.map((l) => `${typeLabel(l.type)}${l.where ? ` (${t(`where.${l.where}` as Key)})` : ''}`).join(', '),
              })}{' '}
              {parent && <Link href={`/doc/${parent}`}>{t('backToReview')}</Link>}
            </span>
          </div>
        )}
        {!restored && (verify?.codePages?.length ?? 0) > 0 && (
          <div className="dv-notice">
            <Icon name="warning" />
            <span>{t('out.codes', { n: verify!.codePages!.length, pages: verify!.codePages!.map((p) => p + 1).join(', ') })}</span>
          </div>
        )}
        {!restored && (verify?.missingWords ?? 0) > 3 && (
          <div className="dv-notice">
            <Icon name="warning" />
            <span>{t('out.missingWords', { n: verify!.missingWords! })}</span>
          </div>
        )}
        {(verify?.report as { warnings?: string[] } | undefined)?.warnings?.map((w) => (
          <div key={w} className="dv-notice">
            <Icon name="warning" />
            <span>{warning(w)}</span>
          </div>
        ))}
        <div className="out-actions">
          <button className="dv-button primary has-icon" onClick={() => void saveDocument(review.document.id).then((ok) => ok && setSaved(true)).catch(setError)}>
            <span>{saved ? t('out.saved') : t('out.download', { name: review.document.outName ?? '' })}</span>
            <span className="dv-button-icon">
              <Icon name={saved ? 'check' : 'download'} />
            </span>
          </button>
          {text && (
            <button
              className="dv-button"
              onClick={async () => {
                const ok = await copyText(review.text);
                // Copied text leaves the app just like a saved file.
                if (ok && !restored) await api.post(`/documents/${review.document.id}/exported`);
                setCopied(ok);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? t('copied') : t('copyText')}
            </button>
          )}
          {isPdf && parent && (
            <label className="switch-row">
              <Toggle on={compare} onChange={setCompare} label={t('out.compare')} />
              {t('out.compare')}
            </label>
          )}
          <span className="grow" />
          {parent && (
            <Link href={`/doc/${parent}`} className="dv-crumb" style={{ margin: 0 }}>
              <Icon name="arrowLeft" />
              {t('backToReview')}
            </Link>
          )}
        </div>
        <ErrorNotice error={error} />
        {isPdf ? (
          <div className={compare && parent ? 'grid-compare' : ''}>
            {compare && parent && (
              <div>
                <h3 className="compare-label">{t('original')}</h3>
                <PdfPreview source={() => bytes(`/documents/${parent}/work`)} label={t('original')} />
              </div>
            )}
            <div>
              {compare && parent && <h3 className="compare-label">{restored ? t('restoredWord') : t('anonymizedWord')}</h3>}
              <PdfPreview source={() => bytes(`/documents/${review.document.id}/file`)} label={restored ? t('doc.restoredCopy') : t('doc.anonymizedCopy')} />
            </div>
          </div>
        ) : (
          <div className="dv-shell">
            <div className="dv-core paper">
              <pre className={`doc-text${review.document.mime === 'text/markdown' ? ' mono' : ''}`}>{review.text}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
