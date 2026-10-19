import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

/**
 * In-app confirmation: the WebView's confirm() is unreliable across WKWebView
 * and WebView2, and blocks the page. `askConfirm()` resolves true or false.
 */

interface Ask {
  message: string;
  confirm?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const listeners = new Set<(a: Ask | null) => void>();

export function askConfirm(message: string, opts: { confirm?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => listeners.forEach((l) => l({ message, ...opts, resolve })));
}

export function DialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    listeners.add(setAsk);
    return () => void listeners.delete(setAsk);
  }, []);
  useEffect(() => {
    if (ask) ref.current?.showModal();
    else ref.current?.close();
  }, [ask]);
  const done = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return (
    <dialog ref={ref} className="dv-dialog" aria-labelledby="dialog-message" onCancel={(e) => (e.preventDefault(), done(false))}>
      {ask && (
        <form method="dialog" className="dv-core dialog-body" onSubmit={(e) => (e.preventDefault(), done(true))}>
          <p id="dialog-message">{ask.message}</p>
          <div className="dv-dialog-actions">
            <button type="button" className="dv-button ghost" onClick={() => done(false)}>
              {t('cancel')}
            </button>
            <button type="submit" className={ask.danger ? 'dv-button danger solid' : 'dv-button primary'} autoFocus>
              {ask.confirm ?? t('confirm')}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
