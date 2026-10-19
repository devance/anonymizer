import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/icons';
import { ErrorNotice, Spinner, useLoad } from '../components/ui';
import { t } from '../i18n';

interface Member {
  email: string;
  role: 'owner' | 'member';
  joined: boolean;
}

/** Who sees a project (web only). Invites are by email and work before the partner's first sign-in. */
export function Members({ projectId, owner }: { projectId: string; owner: boolean }) {
  const { data, error, reload } = useLoad(() => api.get<{ members: Member[] }>(`/projects/${projectId}/members`), [projectId]);
  const [email, setEmail] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Spinner />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="dv-lead" style={{ marginTop: 0 }}>
        {t('members.intro')}
      </p>
      <div className="dv-tile">
        {data.members.map((m) => (
          <div key={m.email} className="setting member-row">
            <span className="grow truncate">{m.email}</span>
            {!m.joined && <span className="dv-badge">{t('members.notJoined')}</span>}
            <span className={`dv-badge${m.role === 'owner' ? ' accent' : ''}`}>{m.role === 'owner' ? t('role.owner') : t('role.member')}</span>
            {owner && m.role !== 'owner' && (
              <button
                className="dv-button ghost danger small"
                onClick={async () => {
                  setActionError(null);
                  try {
                    await api.del(`/projects/${projectId}/members/${encodeURIComponent(m.email)}`);
                    await reload();
                  } catch (e) {
                    setActionError(e);
                  }
                }}
              >
                {t('remove')}
              </button>
            )}
          </div>
        ))}
      </div>
      {owner && (
        <form
          className="dv-tile values-add"
          onSubmit={async (e) => {
            e.preventDefault();
            setActionError(null);
            try {
              await api.post(`/projects/${projectId}/members`, { email });
              setEmail('');
              await reload();
            } catch (err) {
              setActionError(err);
            }
          }}
        >
          <input className="dv-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('members.placeholder')} aria-label={t('members.placeholder')} style={{ flex: 1, minWidth: 220 }} />
          <button className="dv-button" type="submit" disabled={!email.trim()}>
            <Icon name="plus" />
            {t('members.invite')}
          </button>
          <span className="muted small" style={{ flexBasis: '100%' }}>
            {t('members.access')}
          </span>
        </form>
      )}
      <ErrorNotice error={actionError} />
    </div>
  );
}
