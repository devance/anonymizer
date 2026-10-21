import { useRef, useState } from 'react';
import { api, ApiError, type ProjectSummary } from '../api';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner, Toggle, useLoad } from '../components/ui';
import { t } from '../i18n';
import { navigate } from '../router';
import { ACCEPT } from './Home';

export function Restore() {
  const { data } = useLoad(() => api.get<{ projects: ProjectSummary[] }>('/projects'), []);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState('');
  const [suggest, setSuggest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [over, setOver] = useState(false);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let body: unknown;
      if (file) {
        const form = new FormData();
        form.append('file', file);
        if (projectId) form.append('projectId', projectId);
        if (password) form.append('password', password);
        form.append('suggest', String(suggest));
        body = form;
      } else {
        body = { text, projectId: projectId || undefined, suggest, filename: 'texte-ia.txt' };
      }
      const { id } = await api.post<{ id: string }>('/restore', body);
      navigate(`/doc/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) {
        setNeedPassword(true);
        setError(new Error(password ? t('err.wrongPassword') : t('err.passwordProtected')));
      } else {
        setError(e instanceof ApiError && e.status === 422 ? new Error(t('err.noFakes')) : e);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dv-page narrow">
      <header className="home-head">
        <h1>{t('restore.title')}</h1>
        <p className="dv-lead">{t('restore.intro')}</p>
      </header>
      <section
        className={`dv-shell${over ? ' over' : ''}`}
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
        <div className="dv-core composer restore-composer">
          {file ? (
            <div className="file-card">
              <span className="file-badge">
                <Icon name="fileText" />
              </span>
              <strong className="truncate">{file.name}</strong>
              <button className="dv-button small" onClick={() => setFile(null)}>
                <Icon name="x" />
                {t('remove')}
              </button>
            </div>
          ) : (
            <div className="composer-field">
              <textarea className="dv-textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label={t('restore.textLabel')} />
              {!text && (
                <div className="composer-empty" aria-hidden="true">
                  <span className="drop-icon">
                    <Icon name="restore" />
                  </span>
                  <strong>{t('restore.emptyTitle')}</strong>
                  <span>{t('restore.emptyBody')}</span>
                </div>
              )}
            </div>
          )}
          {needPassword && file && (
            <div className="composer-status">
              <input className="dv-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('doc.pdfPassword')} aria-label={t('doc.pdfPassword')} style={{ flex: 1 }} />
            </div>
          )}
          {error != null && (
            <div className="composer-status">
              <ErrorNotice error={error} />
            </div>
          )}
          <div className="composer-bar">
            {!file && (
              <>
                <button type="button" className="dv-button ghost small" onClick={() => input.current?.click()}>
                  <Icon name="paperclip" />
                  {t('home.chooseFile')}
                </button>
              </>
            )}
            <span className="grow" />
            <button className="dv-button primary has-icon" onClick={submit} disabled={busy || (!file && !text.trim())}>
              <span>{t('restore.find')}</span>
              <span className="dv-button-icon">{busy ? <Spinner /> : <Icon name="arrowRight" />}</span>
            </button>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
      </section>

      <div className="dv-tile restore-options">
        <div className="setting">
          <div className="setting-label">
            <div>{t('restore.projectLabel')}</div>
            <div className="sub">{t('restore.projectHint')}</div>
          </div>
          <select className="dv-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t('project')}>
            <option value="">{t('restore.detect')}</option>
            {data?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div className="setting-label">
            <div>{t('restore.suggest')}</div>
            <div className="sub">{t('restore.suggestHint')}</div>
          </div>
          <Toggle on={suggest} onChange={setSuggest} label={t('restore.suggest')} />
        </div>
      </div>
    </div>
  );
}
