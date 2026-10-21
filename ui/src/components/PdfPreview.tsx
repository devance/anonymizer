import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Spinner } from './ui';

type PdfJs = typeof import('pdfjs-dist');
let pdfjs: Promise<PdfJs> | null = null;

/** pdf.js is ~1 MB; load it only when a PDF is shown. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

/** Every page of a PDF, rendered to canvases at the container's width. */
export function PdfPreview({ source, label }: { source: () => Promise<Uint8Array>; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    const el = box.current!;
    el.replaceChildren();
    (async () => {
      try {
        const lib = await loadPdfJs();
        // pdf.js 4+ never evals; a hostile PDF gets no script into the page that holds the database.
        const doc = await lib.getDocument({ data: await source() }).promise;
        const width = el.clientWidth || 500;
        for (let n = 1; n <= Math.min(doc.numPages, 50) && !cancelled; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const scale = (width / base.width) * (window.devicePixelRatio || 1);
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.setAttribute('aria-label', t('pdf.page', { label, n }));
          el.appendChild(canvas);
          await page.render({ canvas, viewport: vp }).promise;
        }
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  return (
    <div>
      {state === 'loading' && (
        <div className="row muted small">
          <Spinner /> {t('pdf.rendering', { label: label.toLowerCase() })}
        </div>
      )}
      {state === 'error' && <div className="dv-notice info">{t('pdf.failed')}</div>}
      <div ref={box} className="pdf-pages" />
    </div>
  );
}
