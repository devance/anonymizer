import { useState } from 'react';
import { api, type DetectionSettings, type Detector } from '../api';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner, formatDate, useLoad } from '../components/ui';
import { t } from '../i18n';
import { Profile, Section, SITE_URL, SOURCE_URL } from '../pages/Settings';
import { me } from './target';

/** The web's settings: the account, the model that reads documents (admins), the CLI, Claude use. */
export function WebSettings() {
  return (
    <>
      <Account />
      <Detection />
      <Profile />
      <Tokens />
      <Usage />
      <About />
    </>
  );
}

function Account() {
  if (!me) return null;
  return (
    <Section title={t('settings.account')}>
      <div className="setting">
        <div className="setting-label">{t('settings.signedInAs', { email: me.email })}</div>
        {me.admin && <span className="dv-badge accent">{t('settings.admin')}</span>}
      </div>
    </Section>
  );
}

/** Fast detection, the remote PC's model or Claude; whether the PC is up. */
function Detection() {
  const { data, error, reload } = useLoad(() => api.get<DetectionSettings>('/settings/detection'), []);
  const [model, setModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  if (error) return <ErrorNotice error={error} />;
  if (!data)
    return (
      <Section title={t('settings.detection')} plain>
        <Spinner />
      </Section>
    );

  const local = data.status?.local;
  const current = data.detector;
  const pcModel = model ?? (current.engine === 'ollama' ? current.model : (local?.models[0]?.name ?? 'gemma4:26b'));
  const pcModels = [...new Set([...(local?.models.map((m) => m.name) ?? []), pcModel])];

  async function use(d: Detector) {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put('/settings/detection', d);
      setSaved(true);
      setModel(null);
      await reload();
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  /** One choice, like the desktop's model cards; a choice with a field (the PC's model) has its button next to it. */
  const card = (engine: Detector['engine'], name: string, hint: string, action: Detector, field?: React.ReactNode, disabled = false) => {
    const inUse = current.engine === engine && (engine !== 'ollama' || (current.engine === 'ollama' && current.model === pcModel));
    const button = data.admin && !inUse && (
      <button className={`dv-button small${field ? '' : ' primary'}`} disabled={saving || disabled} onClick={() => void use(action)}>
        {t('model.use')}
      </button>
    );
    return (
      <div className={`dv-core model wide${current.engine === engine ? ' selected' : ''}`}>
        <div>
          <div className="model-head">
            <span className="model-name">{name}</span>
            {current.engine === engine && <span className="dv-badge ok live">{t('model.inUse')}</span>}
          </div>
          <div className="model-meta">
            <span>{hint}</span>
          </div>
        </div>
        {field ? (
          <div className="model-extra">
            <div className="ollama-fields">
              {field}
              {button}
            </div>
          </div>
        ) : (
          button && <div className="model-actions">{button}</div>
        )}
      </div>
    );
  };

  return (
    <Section title={t('settings.detection')} intro={t('settings.webDetectionIntro')} plain>
      <div className="stack">
        <div className="dv-notice" role="status">
          <Icon name={!data.status ? 'warningCircle' : local?.online ? 'checkCircle' : 'hourglass'} />
          <span>
            {!data.status ? t('settings.pcUnknown') : local?.online ? t('settings.pcOnline') : t('settings.pcOffline')}
            {local?.loaded[0] ? t('settings.pcLoaded', { m: local.loaded[0] }) : ''}
            {data.waiting > 0 ? `. ${t('settings.waiting', { n: data.waiting })}` : ''}
          </span>
        </div>
        <div className="model-picker">
          <div className="models dv-shell">
            {card('none', t('settings.engineNone'), t('settings.engineNoneHint'), { engine: 'none' })}
            {card(
              'ollama',
              t('settings.engineLocal'),
              t('settings.engineLocalHint'),
              { engine: 'ollama', model: pcModel },
              <select className="dv-select" value={pcModel} onChange={(e) => (setModel(e.target.value), setSaved(false))} disabled={!data.admin} aria-label={t('settings.model')} style={{ flex: 1, maxWidth: 320 }}>
                {pcModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>,
            )}
            {data.engines.includes('claude') && card('claude', t('settings.engineClaude'), t('settings.engineClaudeHint'), { engine: 'claude' }, undefined, !data.status?.claude)}
          </div>
        </div>
        {!data.admin && <p className="muted small">{t('settings.adminOnly')}</p>}
        {saved && !saveError && <p className="muted small">{t('settings.saved')}</p>}
        <ErrorNotice error={saveError} />
      </div>
    </Section>
  );
}

interface Token {
  id: string;
  label: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function Tokens() {
  const tokens = useLoad(() => api.get<{ tokens: Token[] }>('/tokens'), []);
  const [error, setError] = useState<unknown>(null);
  const list = tokens.data?.tokens ?? [];
  return (
    <Section title={t('settings.cliTitle')} intro={t('settings.cliIntro')}>
      {tokens.loading && !tokens.data && <Spinner />}
      {tokens.data && list.length === 0 && (
        <div className="setting">
          <span className="muted">{t('settings.noTokens')}</span>
        </div>
      )}
      {list.map((tok) => (
        <div key={tok.id} className="setting">
          <div className="setting-label grow">
            <div>{tok.label}</div>
            <div className="sub dv-num">
              {t('settings.tokenCreated', { d: formatDate(tok.created_at) })}, {tok.last_used_at ? t('settings.tokenUsed', { d: formatDate(tok.last_used_at) }) : t('settings.tokenNeverUsed')},{' '}
              {tok.revoked_at ? t('settings.tokenRevoked') : tok.expires_at < Date.now() / 1000 ? t('settings.tokenExpired') : t('settings.tokenExpires', { d: formatDate(tok.expires_at) })}
            </div>
          </div>
          {!tok.revoked_at && (
            <button
              className="dv-button ghost danger small"
              onClick={async () => {
                setError(null);
                try {
                  await api.del(`/tokens/${tok.id}`);
                  await tokens.reload();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              {t('revoke')}
            </button>
          )}
        </div>
      ))}
      <ErrorNotice error={error} />
    </Section>
  );
}

function Usage() {
  if (!me) return null;
  const { usage, tokenCap } = me;
  return (
    <Section title={t('settings.usageTitle')}>
      <div className="setting">
        <span className="dv-num">
          {t('settings.usage', { calls: usage.calls, input: (usage.inputTokens / 1000).toFixed(0), output: (usage.outputTokens / 1000).toFixed(0) })}
          {tokenCap > 0 && t('settings.cap', { cap: (tokenCap / 1_000_000).toFixed(1), pct: Math.round(((usage.inputTokens + usage.outputTokens) / tokenCap) * 100) })}
        </span>
      </div>
    </Section>
  );
}

function About() {
  return (
    <Section title={t('settings.about')}>
      <div className="setting">
        <div className="setting-label">
          <div className="sub">{t('settings.license')}</div>
        </div>
        <a className="dv-button ghost small" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('settings.source')}
          <Icon name="arrowUpRight" />
        </a>
        <a className="dv-button ghost small" href={SITE_URL} target="_blank" rel="noopener noreferrer">
          devance.ca
          <Icon name="arrowUpRight" />
        </a>
      </div>
    </Section>
  );
}
