import { useRef, useState } from 'react';
import { api, ApiError, type ProjectSummary } from '../api';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner, formatBytes, formatDate, useLoad } from '../components/ui';
import { t } from '../i18n';
import { Link, navigate } from '../router';

const LAST_PROJECT = 'anon:lastProject';
export const ACCEPT = '.pdf,.docx,.jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,.webp,.txt,.md';

function readLast(): string {
  try {
    return localStorage.getItem(LAST_PROJECT) ?? '';
  } catch {
    return '';
  }
}

export function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* private mode */
  }
}

export function Home() {
  const { data, error, reload } = useLoad(() => api.get<{ projects: ProjectSummary[] }>('/projects'), []);
  const projects = data?.projects ?? [];
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState(readLast);
  const [busy, setBusy] = useState<'anonymize' | 'restore' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [newName, setNewName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const hasInput = !!file || !!text.trim();

  function body(extra: Record<string, string> = {}): FormData | Record<string, string> {
    if (!file) return { text, ...extra };
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return form;
  }

  const selected = projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id ?? '';

  async function anonymize() {
    setBusy('anonymize');
    setActionError(null);
    try {
      // First time: no project to pick yet, so the document starts one rather than waiting for the user to.
      const pid = selected || (await api.post<{ id: string }>('/projects', { name: t('home.firstProject') })).id;
      const { id } = await api.post<{ id: string }>(`/projects/${pid}/documents`, body({ filename: 'texte-colle.txt' }));
      rememberProject(pid);
      navigate(`/doc/${id}`);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy('restore');
    setActionError(null);
    try {
      const { id } = await api.post<{ id: string }>('/restore', body({ filename: 'texte-ia.txt' }));
      navigate(`/doc/${id}`);
    } catch (e) {
      setActionError(e instanceof ApiError && e.status === 422 ? new Error(t('err.noFakes')) : e);
    } finally {
      setBusy(null);
    }
  }

  async function createProject() {
    if (!newName.trim()) return;
    const { id } = await api.post<{ id: string }>('/projects', { name: newName.trim() });
    setNewName('');
    rememberProject(id);
    await reload();
    navigate(`/p/${id}`);
  }

  return (
    <div className="dv-page">
      <header className="home-head">
        <h1>{t('home.title')}</h1>
        <p className="dv-lead">{t('home.intro')}</p>
      </header>
      <div className="dv-split">
        <section
          className={`dv-shell${over ? ' over' : ''}`}
          aria-label={t('home.title')}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            if (f) setFile(f);
          }}
        >
          <div className="dv-core composer">
            {file ? (
              <div className="file-card">
                <span className="file-badge">
                  <Icon name="fileText" />
                </span>
                <strong className="truncate">{file.name}</strong>
                <span className="muted small dv-num">{file.size < 1e6 ? t('unit.kb', { n: Math.max(1, Math.round(file.size / 1e3)) }) : formatBytes(file.size)}</span>
                <button className="dv-button small" onClick={() => setFile(null)}>
                  <Icon name="x" />
                  {t('remove')}
                </button>
              </div>
            ) : (
              <div className="composer-field">
                <textarea className="dv-textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label={t('home.textLabel')} />
                {!text && (
                  <div className="composer-empty" aria-hidden="true">
                    <span className="drop-icon">
                      <Icon name="fileUp" />
                    </span>
                    <strong>{t('home.emptyTitle')}</strong>
                    <span>{t('home.emptyBody')}</span>
                  </div>
                )}
              </div>
            )}
            {actionError != null && (
              <div className="composer-status">
                <ErrorNotice error={actionError} />
              </div>
            )}
            {busy && (
              <div className="composer-status" role="status">
                <Spinner />
                {file ? t('uploading') : busy === 'anonymize' ? t('home.reading') : t('home.finding')}
              </div>
            )}
            <div className="composer-bar">
              {!file && (
                <>
                  <button type="button" className="dv-button ghost small choose" onClick={() => fileInput.current?.click()} aria-label={t('home.chooseFile')} title={t('home.chooseFile')}>
                    <Icon name="paperclip" />
                    <span className="label">{t('home.chooseFile')}</span>
                  </button>
                </>
              )}
              <span className="grow" />
              <label className="select-label">
                <span className="dv-sr-only">{t('project')}</span>
                <select className="dv-select" value={selected} onChange={(e) => setProjectId(e.target.value)} disabled={projects.length === 0} title={t('project')}>
                  {projects.length === 0 && <option value="">{t('home.firstProject')}</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="dv-button" onClick={restore} disabled={!hasInput || busy !== null} title={t('home.restoreHint')}>
                <Icon name="restore" />
                {t('home.restore')}
              </button>
              <button className="dv-button primary has-icon" onClick={anonymize} disabled={!hasInput || busy !== null}>
                <span>{t('anonymize')}</span>
                <span className="dv-button-icon">{busy === 'anonymize' ? <Spinner /> : <Icon name="arrowRight" />}</span>
              </button>
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
        </section>

        <aside className="dv-tile projects">
          <h2 className="section-title">
            {t('home.projects')}
            {projects.length > 0 && <span className="dv-badge dv-num">{projects.length}</span>}
          </h2>
          {data && projects.length === 0 && <p className="muted small">{t('home.emptyProjects')}</p>}
          <ErrorNotice error={error} />
          {projects.length > 0 && (
            <div className="project-list">
              {projects.map((p) => (
                <Link key={p.id} href={`/p/${p.id}`} className={`project-link${p.id === selected ? ' current' : ''}`}>
                  <span className="folder">
                    <Icon name="folder" />
                  </span>
                  <span className="grow">
                    <span className="name truncate">{p.name}</span>
                    <span className="sub dv-num">
                      {t('home.docCount', { n: p.documents })}, {formatDate(p.created_at)}
                      {p.role === 'member' ? `, ${t('home.shared')}` : p.members > 1 ? `, ${t('home.sharedWith', { n: p.members - 1 })}` : ''}
                    </span>
                  </span>
                  <Icon name="caretRight" className="go" />
                </Link>
              ))}
            </div>
          )}
          <form
            className={projects.length === 0 ? 'new-project first' : 'new-project'}
            onSubmit={(e) => {
              e.preventDefault();
              void createProject();
            }}
          >
            <input className="dv-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('home.newProject')} aria-label={t('home.newProject')} />
            <button className="dv-button" type="submit" disabled={!newName.trim()}>
              <Icon name="plus" />
              {t('create')}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}
