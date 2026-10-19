import letterD from '@devance/design/brand/d.svg?raw';
import { Logo } from './Logo';

/** The D of the Devance wordmark (the design system's brand/d.svg), in the current text colour. */
const D_INNER = letterD.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '');

export function DGlyph() {
  return <svg viewBox="0 96 312 380" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: D_INNER }} />;
}

/** The glass D slab of devance.ca's hero: tilted, with the light it throws; settles once on load. */
export function GlassTile() {
  return (
    <div className="dv-glass-d-stage" aria-hidden="true">
      <div className="dv-glass-d">
        <div className="dv-glass-d-face">
          <DGlyph />
        </div>
      </div>
    </div>
  );
}

/** The app icon, small: the D on a glass square over the grain panel. */
export function AppMark() {
  return (
    <div className="dv-app-mark" aria-hidden="true">
      <span className="dv-app-mark-glass" />
      <DGlyph />
    </div>
  );
}

/** Wordmark and product name, as on the top bar and the first-launch panel. */
export function Brand({ product }: { product: string }) {
  return (
    <>
      <Logo className="brand-logo" />
      <span className="dv-brand-product">{product}</span>
    </>
  );
}
