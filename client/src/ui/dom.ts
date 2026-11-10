// Tiny DOM helpers.
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const fmt$ = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
export const fmtTime = (s: number) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };

let toastRoot: HTMLElement | null = null;
export function toast(text: string, kind: 'info' | 'error' | 'good' = 'info', ms = 3500) {
  if (!toastRoot) { toastRoot = h('div', { class: 'toasts' }); document.getElementById('ui-root')!.append(toastRoot); }
  if (!toastRoot.isConnected) document.getElementById('ui-root')!.append(toastRoot);
  const t = h('div', { class: 'toast ' + kind }, text);
  toastRoot.append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}

export function modal(title: string, body: Node | string, actions: { label: string; kind?: string; run?: () => void }[]): () => void {
  const wrap = h('div', { class: 'modal-wrap' });
  const close = () => wrap.remove();
  const box = h('div', { class: 'modal panel' },
    h('h3', { class: 'h-display', style: { fontSize: '1.6em' } }, title),
    typeof body === 'string' ? h('p', { class: 'muted', style: { margin: 0, lineHeight: 1.5 } }, body) : body,
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, ...actions.map((a) => h('button', { class: 'btn ' + (a.kind ?? ''), onclick: () => { close(); a.run?.(); } }, a.label))),
  );
  wrap.append(box);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.getElementById('ui-root')!.append(wrap);
  return close;
}

export const LOGO_SVG = '<svg class="mark" viewBox="0 0 64 64"><path d="M10 50 L32 12 L54 50 Z" fill="none" stroke="#e0a030" stroke-width="4"/><rect x="29" y="25" width="6" height="13" fill="#e0a030"/><rect x="29" y="41" width="6" height="5" fill="#e0a030"/></svg>';
