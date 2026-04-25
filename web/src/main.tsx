import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Debug: report any element wider than the viewport. Visible at /?ofdebug=1.
if (new URLSearchParams(location.search).get('ofdebug') === '1') {
  const findOverflow = () => {
    const vw = window.innerWidth;
    const offenders: Array<{ tag: string; cls: string; w: number; right: number }> = [];
    document.querySelectorAll<HTMLElement>('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 0.5 || r.width > vw + 0.5) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className?.toString().slice(0, 60) ?? '',
          w: Math.round(r.width),
          right: Math.round(r.right),
        });
      }
    });
    const banner = document.createElement('pre');
    banner.style.cssText =
      'position:fixed;left:0;top:0;z-index:99999;background:#fee;color:#000;font:11px monospace;padding:6px;max-width:100vw;overflow:auto;border:1px solid red;white-space:pre-wrap;';
    banner.textContent =
      `viewport=${vw}px, offenders=${offenders.length}\n` +
      offenders
        .slice(0, 20)
        .map((o) => `${o.tag}.${o.cls} w=${o.w} right=${o.right}`)
        .join('\n');
    document.body.appendChild(banner);
  };
  setTimeout(findOverflow, 500);
}
