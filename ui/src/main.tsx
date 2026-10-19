import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { target } from '@target';
import { App } from './app';
import { registerCopy, t } from './i18n';
import '@devance/design/tokens.css';
import '@devance/design/base.css';
import '@devance/design/components.css';
import './theme';
import './styles.css';

// One UI for both builds; ./desktop/target.tsx or ./web/target.tsx is picked at build time (vite.config.ts).
registerCopy(target.copy);
document.title = t('brand');
document.documentElement.dataset.target = target.kind;
// Windows keeps its own title bar, so nothing on the page makes room for the macOS traffic lights.
document.documentElement.dataset.os = /Windows/.test(navigator.userAgent) ? 'windows' : 'mac';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <target.Boot>
      <App />
    </target.Boot>
  </StrictMode>,
);
