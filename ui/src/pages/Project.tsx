import { useEffect, useRef, useState } from 'react';
import { target } from '@target';
import { api, type DocSummary, type EntityRow, type ProjectDetail } from '../api';
import { askConfirm } from '../components/Dialog';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner, Toggle, formatDate, markKind, typeLabel, typeOptions, useLoad } from '../components/ui';
import { saveDocument } from '../api';
import { t, type Key } from '../i18n';
import { Link, navigate } from '../router';
import { ACCEPT, rememberProject } from './Home';

const kindLabel = (k: DocSummary['kind']) => t(`kind.${k}` as Key);
const STATUSES = new Set(['uploaded', 'analyzing', 'waiting', 'needs_review', 'rendering', 'ready', 'failed']);
const statusLabel = (st: string) => (STATUSES.has(st) ? t(`status.${st}` as Key) : st);

export function Project({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => api.get<ProjectDetail>(`/projects/${id}`), [id]);
  const [tab, setTab] = useState<string>('documents');
  useEffect(() => rememberProject(id), [id]);
  if (error)
    return (
      <div className="dv-page">
        <ErrorNotice error={error} />
      </div>
    );
  if (!data)
    return (
      <div className="dv-page">
        <Spinner />
      </div>
    );
  const sources = data.documents.filter((d) => !d.parentId).length;
  const owner = data.project.role === 'owner';
  const tabs: Array<{ id: string; label: Key }> = [
    { id: 'documents', label: 'tab.documents' },
    { id: 'values', label: 'tab.values' },
    ...target.projectTabs,
  ];
  const extra = target.projectTabs.find((x) => x.id === tab);

  return (
    <div className="dv-page">
      <header className="dv-page-head">
        <div className="grow">
          <Link href="/" className="dv-crumb">
            <Icon name="arrowLeft" />
            {t('nav.projects')}
          </Link>
          <h1 className="truncate">{data.project.name}</h1>
          <p className="meta dv-num">
            {t('home.docCount', { n: sources })}, {t('project.created', { d: formatDate(data.project.createdAt) })}
          </p>
        </div>
        {owner ? (
          <button
            className="dv-button ghost danger"
            onClick={async () => {
              if (!(await askConfirm(t('project.deleteConfirm', { name: data.project.name }), { danger: true, confirm: t('project.delete') }))) return;
              await api.del(`/projects/${id}`);
              navigate('/');
            }}
          >
            <Icon name="trash" />
            {t('project.delete')}
          </button>
        ) : (
          <span className="dv-badge">{t('home.shared')}</span>
        )}
      </header>
      <div className="tabs-row">
        <div className="dv-segmented" role="tablist" aria-label={data.project.name}>
          {tabs.map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}>
              {t(x.label)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'documents' && <Documents projectId={id} docs={data.documents} onChange={reload} />}
      {tab === 'values' && <Values projectId={id} />}
      {extra?.render({ projectId: id, owner })}
    </div>
  );
}

function Documents({ projectId, docs, onChange }: { projectId: string; docs: DocSummary[]; onChange: () => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { id } = await api.post<{ id: string }>(`/projects/${projectId}/documents`, form);
      navigate(`/doc/${id}`);
    } catch (e) {
      setError(e);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const roots = docs.filter((d) => !d.parentId);
  const children = (id: string) => docs.filter((d) => d.parentId === id);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="dv-shell">
        <button
          type="button"
          className={`dv-button drop${over ? ' over' : ''}`}
          onClick={() => input.current?.click()}
          disabled={busy}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            if (f) void upload(f);
          }}
        >
          <span className="drop-icon">{busy ? <Spinner /> : <Icon name="fileUp" />}</span>
          <span className="drop-text">
            <strong>{busy ? t('uploading') : t('docs.drop')}</strong>
            <span>{t('docs.dropHint')}</span>
          </span>
        </button>
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      <ErrorNotice error={error} />
      <div className="dv-tile doc-list">
        {roots.length === 0 && <div className="empty">{t('docs.empty')}</div>}
        {roots.map((d) => (
          <div key={d.id} className="doc-row">
            <span className="doc-icon">
              <Icon name={d.kind === 'external' ? 'restore' : 'fileText'} />
            </span>
            <div className="doc-title">
              <Link href={`/doc/${d.id}`} className="truncate">
                {d.filename}
              </Link>
              <span className={`dv-badge${d.kind === 'external' ? ' accent' : ''}`}>{kindLabel(d.kind)}</span>
              {d.status !== 'ready' && <span className={`dv-badge${d.status === 'failed' ? ' danger' : d.status === 'needs_review' ? ' warn' : ''}`}>{statusLabel(d.status)}</span>}
            </div>
            <span className="doc-date dv-num">{formatDate(d.createdAt)}</span>
            {children(d.id).length > 0 && (
              <div className="doc-outputs">
                {children(d.id).map((c) => (
                  <div key={c.id} className="doc-output">
                    <Icon name="elbow" />
                    <Link href={`/doc/${c.id}`} className="truncate grow">
                      {c.outName ?? c.filename}
                    </Link>
                    <span className="dv-badge">{kindLabel(c.kind)}</span>
                    <button className="dv-button small" onClick={() => void saveDocument(c.id).catch(setError)}>
                      <Icon name="download" />
                      {t('download')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Values({ projectId }: { projectId: string }) {
  const { data, error, reload, setData } = useLoad(() => api.get<{ entities: EntityRow[] }>(`/projects/${projectId}/entities`), [projectId]);
  const [type, setType] = useState('person');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [editError, setEditError] = useState<unknown>(null);
  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Spinner />;
  const rows = data.entities.filter((e) => !filter || `${e.real} ${e.fake}`.toLowerCase().includes(filter.toLowerCase()));

  /** Throws when the change is refused (a fake that is a real value of the project), after showing why. */
  async function patch(e: EntityRow, body: { enabled?: boolean; fake?: string }) {
    setEditError(null);
    setData({ entities: data!.entities.map((x) => (x.id === e.id ? { ...x, ...body } : x)) });
    try {
      await api.patch(`/projects/${projectId}/entities/${e.id}`, body);
    } catch (err) {
      setEditError(err);
      throw err;
    } finally {
      await reload();
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="dv-lead" style={{ marginTop: 0 }}>
        {t('values.intro')}
      </p>
      <form
        className="dv-tile values-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await api.post(`/projects/${projectId}/entities`, { type, text });
          setText('');
          await reload();
        }}
      >
        <strong>{t('values.alwaysReplace')}</strong>
        <select className="dv-select" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('type')}>
          {typeOptions().map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input className="dv-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('values.placeholder')} style={{ flex: 1, minWidth: 200 }} aria-label={t('value')} />
        <button className="dv-button" type="submit" disabled={!text.trim()}>
          <Icon name="plus" />
          {t('add')}
        </button>
      </form>
      <ErrorNotice error={editError} />
      <div className="dv-tile">
        <div className="row spread" style={{ marginBottom: 14 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            {t('tab.values')}
            <span className="dv-badge dv-num">{data.entities.length}</span>
          </h2>
          <label className="filter">
            <Icon name="search" />
            <input className="dv-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('filter')} aria-label={t('filter')} />
          </label>
        </div>
        <div className="dv-table-wrap">
          <table className="dv-table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>{t('values.on')}</th>
                <th style={{ width: 150 }}>{t('type')}</th>
                <th>{t('values.real')}</th>
                <th>{t('values.fake')}</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Toggle on={e.enabled} label={t('replaceX', { v: e.real })} onChange={(v) => void patch(e, { enabled: v }).catch(() => {})} />
                  </td>
                  <td>
                    <span className="type-tag">
                      <i className={`dv-swatch ${markKind(e.type)}`} />
                      {typeLabel(e.type)}
                    </span>
                  </td>
                  <td className="real">
                    {e.real}
                    {e.surfaces.length > 1 && (
                      <div className="sub">
                        {t('values.alsoWritten')}
                        {e.surfaces.filter((s) => s !== e.real).join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    <FakeEditor value={e.fake} onSave={(v) => patch(e, { fake: v })} />
                    {e.aliases.length > 0 && (
                      <div className="sub">
                        {t('values.previously')}
                        {e.aliases.join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    {e.frozen && (
                      <span className="dv-badge accent" title={t('values.inUseHint')}>
                        {t('values.inUse')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">{t('values.empty')}</div>}
        </div>
      </div>
    </div>
  );
}

function FakeEditor({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  if (!editing) {
    return (
      <button className="dv-button fake-edit" onClick={() => (setV(value), setEditing(true))} title={t('values.editFake')}>
        {value}
      </button>
    );
  }
  return (
    <form
      className="row"
      style={{ gap: 6, flexWrap: 'nowrap' }}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave(v);
          setEditing(false);
        } catch {
          // Refused: the reason shows above the table, the field stays open to try another.
        }
      }}
    >
      <input className="dv-input" value={v} onChange={(e) => setV(e.target.value)} autoFocus aria-label={t('values.fakeValue')} style={{ height: 32, minWidth: 0, flex: 1 }} />
      <button type="submit" className="dv-button primary small">
        {t('save')}
      </button>
      <button type="button" className="dv-button ghost small" onClick={() => setEditing(false)}>
        {t('cancel')}
      </button>
    </form>
  );
}
