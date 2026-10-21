import { useState } from 'react';
import { api } from '../api';
import { AppMark } from '../components/Brand';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner } from '../components/ui';
import { t } from '../i18n';
import { useLocation } from '../router';
import { me } from './target';

/**
 * Opened by `anon login`. Hands the CLI a one-time code (bound to its PKCE
 * challenge) on its local callback; the CLI exchanges it for a token itself.
 */
export function CliAuthorize() {
  const params = new URLSearchParams(useLocation().search);
  const port = Number(params.get('port'));
  const state = params.get('state') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  const label = params.get('label') ?? 'CLI';
  const valid = Number.isInteger(port) && port > 1024 && port < 65536 && /^[A-Za-z0-9_-]{16,}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(challenge);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function authorize() {
    setBusy(true);
    try {
      const { code } = await api.post<{ code: string }>('/cli/codes', { challenge, label });
      setDone(true);
      location.href = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="dv-page narrow">
      <div className="dv-shell cli-card">
        <div className="dv-core stack">
          <AppMark />
          <h1>{t('cli.title')}</h1>
          {!valid ? (
            <div className="dv-notice error">
              <Icon name="warningCircle" />
              <span>{t('cli.incomplete')}</span>
            </div>
          ) : done ? (
            <div className="dv-notice ok">
              <Icon name="checkCircle" />
              <span>{t('cli.done')}</span>
            </div>
          ) : (
            <>
              <p>{t('cli.asking', { label, email: me?.email ?? t('cli.you') })}</p>
              <p className="muted small">{t('cli.onlyIf')}</p>
              <ErrorNotice error={error} />
              <div className="row">
                <button className="dv-button ghost" onClick={() => window.close()}>
                  {t('cancel')}
                </button>
                <button className="dv-button primary" onClick={authorize} disabled={busy}>
                  {busy && <Spinner />}
                  {t('authorize')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
