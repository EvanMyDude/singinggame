type Child = Node | string | number | null | undefined | false | Child[];

type Props = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  [attr: string]: unknown;
};

/** Tiny hyperscript helper: h('button', { class: 'btn', onclick }, 'Go'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v as string;
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function svg(markup: string, cls = ''): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const s = t.content.firstElementChild as SVGSVGElement;
  if (cls) s.setAttribute('class', cls);
  return s;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Segmented control. */
export function segmented<T extends string | number>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
  ariaLabel: string,
): HTMLDivElement {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': ariaLabel });
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(o.value === value),
        onclick: () => {
          buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i]!.value === o.value)));
          onChange(o.value);
        },
      },
      o.label,
    ),
  );
  wrap.append(...buttons);
  return wrap;
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', null, label));
}

export function slider(opts: {
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (v: number) => void;
  ariaLabel: string;
}): HTMLInputElement {
  const input = h('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
    'aria-label': opts.ariaLabel,
  });
  const paint = () => {
    const f = ((Number(input.value) - opts.min) / (opts.max - opts.min)) * 100;
    input.style.setProperty('--fill', `${f}%`);
  };
  input.addEventListener('input', () => {
    paint();
    opts.onInput(Number(input.value));
  });
  paint();
  return input;
}

export function brandMark(): SVGSVGElement {
  return svg(
    `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" stroke="rgba(255,255,255,.14)"/><path d="M5 19c3 0 3-8 6-8s3 11 6 11 3-14 6-14 3 7 4 7" stroke="#5ee0ff" stroke-width="2.4" stroke-linecap="round"/><path d="M21 7l1.2 2.6L25 10.8l-2.8 1.2L21 14.6l-1.2-2.6L17 10.8l2.8-1.2z" fill="#ffe14d"/></svg>`,
    'brand-mark',
  );
}

export const ICONS = {
  play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h3l2-6 3 12 3-9 2 3h3"/></svg>`,
  practice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/></svg>`,
  trainer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
  monitor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4v16h18"/><path d="M6 14c1.5 0 2-5 3.5-5S11 15 12.5 15 14 7 15.5 7 17 11 20 11"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>`,
  play2: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 001.5.87l11-6.5a1 1 0 000-1.74l-11-6.5A1 1 0 008 5.5z"/></svg>`,
  restart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9"/><path d="M3 4v5h5"/></svg>`,
  speaker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 010 6"/><path d="M18.5 6.5a8 8 0 010 11"/></svg>`,
  warmup: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  sing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/><path d="M3 6l2 2M21 6l-2 2"/></svg>`,
  lyrics: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h10M4 18h13"/></svg>`,
  files: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z"/></svg>`,
};

export function icon(name: keyof typeof ICONS, cls = 'icon'): SVGSVGElement {
  return svg(ICONS[name], cls);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function backButton(onClick: () => void, label = 'Back'): HTMLButtonElement {
  return h('button', { class: 'btn ghost', onclick: onClick, 'aria-label': label }, svg(ICONS.back, 'kbd-icon'), label);
}
