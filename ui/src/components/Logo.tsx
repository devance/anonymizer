import wordmark from '@devance/design/brand/wordmark.svg?raw';

/** The Devance wordmark (the design system's), drawn in the current text colour so each theme can tint it. */
const SVG = wordmark.trim().replace(' role="img" aria-label="Devance"', ' aria-hidden="true" focusable="false"');

export function Logo({ className }: { className?: string }) {
  return <span className={className} role="img" aria-label="Devance" dangerouslySetInnerHTML={{ __html: SVG }} />;
}
