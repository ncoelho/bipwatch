/**
 * Filtering, selection and URL state for the "What it needs" and Positions
 * explorers (page templates spec). The pages are complete without it; this
 * only hides what a filter excludes, shows the selected item in the side
 * panel, and mirrors the state in the hash so every view can be shared:
 *
 *   #needs?tier=important&dim=technical_maturity&area=design&piece=BIP%20375&kind=task&item=<id>&done=1
 *
 * tier is the priority group (lib/triage.ts); without it the list opens on the
 * first group that has items, and tier=all shows every group.
 *   #positions?item=<id>
 *
 * A bare claim id (#task-…), as evidence links and old anchors use, selects
 * that claim in whichever explorer holds it. The frame's tab script picks the
 * tab from the same hash.
 */

type WorkState = { tier: string; dim: string; area: string; piece: string; kind: string; item: string; done: boolean };

const $$ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => [...root.querySelectorAll<T>(sel)] as T[];

function parseHash(): { tab: string; params: URLSearchParams } {
  const raw = decodeURIComponent(location.hash.slice(1));
  const q = raw.indexOf('?');
  return q < 0 ? { tab: raw, params: new URLSearchParams() } : { tab: raw.slice(0, q), params: new URLSearchParams(raw.slice(q + 1)) };
}

function writeHash(tab: string, params: Record<string, string | boolean | undefined>) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${v === true ? '1' : encodeURIComponent(String(v))}`)
    .join('&');
  history.replaceState(null, '', `#${tab}${q ? `?${q}` : ''}`);
}

function showInPanel(panel: HTMLElement, row: HTMLElement | undefined) {
  const detail = row?.querySelector<HTMLElement>('.detail');
  if (!detail) {
    panel.hidden = true;
    return;
  }
  panel.innerHTML = detail.outerHTML;
  panel.hidden = false;
}

function workExplorer(root: HTMLElement) {
  const cardsRoot = document.getElementById('needs-cards');
  const cards = cardsRoot ? $$<HTMLElement>(cardsRoot, '[data-card]') : [];
  const rows = $$<HTMLElement>(root, '[data-row]');
  const panel = root.querySelector<HTMLElement>('[data-panel]')!;
  const count = root.querySelector<HTMLElement>('[data-count]');
  const doneBtn = root.querySelector<HTMLButtonElement>('[data-done]');
  const clear = root.querySelector<HTMLButtonElement>('[data-clear]')!;
  const nothing = root.querySelector<HTMLElement>('[data-nothing]')!;
  const filters = $$<HTMLElement>(root, '.achip, .barrow');
  const pieceSelect = root.querySelector<HTMLSelectElement>('[data-piece-select]');
  const kindBtns = $$<HTMLButtonElement>(root, '[data-kind-filter]');
  const tierBtns = $$<HTMLButtonElement>(root, '[data-tier-filter]');
  const tierHint = root.querySelector<HTMLElement>('[data-tier-hint]');
  const firstTier = root.querySelector<HTMLElement>('[data-first-tier]')?.dataset.firstTier ?? 'all';
  const st: WorkState = { tier: firstTier, dim: '', area: '', piece: '', kind: '', item: '', done: false };

  const cardOf = (dim: string) => cards.find((c) => c.dataset.card === dim);
  // Addressed items have no group; they show whenever "Show addressed" is on.
  const inTier = (r: HTMLElement) => st.tier === 'all' || r.dataset.open === '0' || r.dataset.tier === st.tier;
  const matches = (r: HTMLElement, skipTier = false) => {
    if (!skipTier && !inTier(r)) return false;
    if (st.area && r.dataset.area !== st.area) return false;
    if (st.piece && r.dataset.piece !== st.piece) return false;
    if (st.kind && r.dataset.kind !== st.kind) return false;
    if (st.dim) {
      const c = cardOf(st.dim);
      const areas = (c?.dataset.areas ?? '').split(' ').filter(Boolean);
      const ev = (c?.dataset.evidence ?? '').split(' ');
      if (!areas.includes(r.dataset.area ?? '') && !ev.includes(r.id)) return false;
    }
    return true;
  };

  const render = (scroll = false) => {
    const visible = rows.filter((r) => matches(r) && (st.done || r.dataset.open === '1'));
    // A selected item stays visible even when a filter would hide it.
    const sel = rows.find((r) => r.id === st.item) ?? visible[0];
    for (const r of rows) {
      r.hidden = !(visible.includes(r) || r === sel);
      r.classList.toggle('sel', r === sel);
    }
    showInPanel(panel, sel);
    const nOpen = visible.filter((r) => r.dataset.open === '1').length;
    const nDone = visible.length - nOpen;
    if (count) count.textContent = `${nOpen} open${st.done && nDone ? ` · ${nDone} addressed` : ''}${st.area || st.piece || st.kind || st.dim || st.tier !== 'all' ? ' in this view' : ' items'}`;
    if (doneBtn) {
      doneBtn.setAttribute('aria-pressed', String(st.done));
      doneBtn.querySelector('[data-done-label]')!.textContent = st.done ? 'Hide addressed' : `Show ${rows.filter((r) => r.dataset.open === '0' && matches(r)).length} addressed`;
    }
    nothing.hidden = visible.length > 0;
    const dimAreas = st.dim ? (cardOf(st.dim)?.dataset.areas ?? '').split(' ') : null;
    for (const f of filters) {
      const on = f.dataset.area === st.area;
      f.setAttribute('aria-pressed', String(on));
      f.classList.toggle('dim', !!dimAreas && f.dataset.area !== undefined && !dimAreas.includes(f.dataset.area));
    }
    for (const b of tierBtns) {
      const key = b.dataset.tierFilter!;
      b.setAttribute('aria-pressed', String(key === st.tier));
      const n = rows.filter((r) => r.dataset.open === '1' && matches(r, true) && (key === 'all' || r.dataset.tier === key)).length;
      b.querySelector('[data-tier-count]')!.textContent = String(n);
      if (key === st.tier && tierHint) tierHint.textContent = b.title || 'Every open item, in priority order';
    }
    for (const b of kindBtns) b.setAttribute('aria-pressed', String(b.dataset.kindFilter === st.kind));
    if (pieceSelect) {
      pieceSelect.value = st.piece;
      pieceSelect.classList.toggle('on', !!st.piece);
    }
    for (const c of cards) {
      const on = c.dataset.card === st.dim;
      c.classList.toggle('on', on);
      c.querySelector('[data-dim]')?.setAttribute('aria-pressed', String(on));
    }
    const parts = [st.dim && cardOf(st.dim)?.dataset.label, st.piece, st.kind && kindBtns.find((b) => b.dataset.kindFilter === st.kind)?.firstChild?.nextSibling?.textContent?.trim(), st.area && root.querySelector<HTMLElement>(`[data-area="${st.area}"] .bt, .achip[data-area="${st.area}"]`)?.firstChild?.textContent?.trim()].filter(Boolean);
    clear.hidden = !parts.length;
    clear.textContent = `${parts.join(' · ')} · Show all ✕`;
    if (scroll && sel) sel.scrollIntoView({ block: 'nearest' });
  };

  const commit = () => {
    writeHash('needs', { tier: st.tier === firstTier ? '' : st.tier, dim: st.dim, area: st.area, piece: st.piece, kind: st.kind, item: st.item, done: st.done });
    render();
  };

  for (const c of cards) {
    c.querySelector('[data-dim]')?.addEventListener('click', () => {
      st.dim = st.dim === c.dataset.card ? '' : c.dataset.card!;
      st.item = '';
      commit();
    });
  }
  for (const f of filters) {
    f.addEventListener('click', () => {
      // Type of work and piece (the select) combine.
      st.area = st.area === f.dataset.area ? '' : (f.dataset.area ?? '');
      st.item = '';
      commit();
    });
  }
  for (const b of tierBtns)
    b.addEventListener('click', () => {
      st.tier = b.dataset.tierFilter!;
      st.item = '';
      commit();
    });
  for (const b of kindBtns)
    b.addEventListener('click', () => {
      st.kind = st.kind === b.dataset.kindFilter ? '' : b.dataset.kindFilter!;
      st.item = '';
      commit();
    });
  pieceSelect?.addEventListener('change', () => {
    st.piece = pieceSelect.value;
    st.item = '';
    commit();
  });
  for (const r of rows) {
    r.querySelector('[data-select]')?.addEventListener('click', () => {
      st.item = r.id;
      commit();
    });
  }
  const toggleDone = () => {
    st.done = !st.done;
    commit();
  };
  doneBtn?.addEventListener('click', toggleDone);
  root.querySelector('[data-done-inline]')?.addEventListener('click', toggleDone);
  clear.addEventListener('click', () => {
    st.dim = st.area = st.piece = st.kind = st.item = '';
    commit();
  });

  return {
    has: (id: string) => rows.some((r) => r.id === id),
    fromHash(tab: string, p: URLSearchParams) {
      if (tab === 'needs') {
        st.tier = p.get('tier') ?? firstTier;
        st.dim = p.get('dim') ?? '';
        st.area = p.get('area') ?? '';
        st.piece = p.get('piece') ?? '';
        st.kind = p.get('kind') ?? '';
        st.item = p.get('item') ?? '';
        st.done = p.get('done') === '1';
      } else if (rows.some((r) => r.id === tab)) {
        st.item = tab;
      }
      const it = rows.find((r) => r.id === st.item);
      if (it && it.dataset.open === '0') st.done = true;
      // A linked item opens in its own group.
      if (it && it.dataset.open === '1' && st.tier !== 'all' && it.dataset.tier !== st.tier) st.tier = it.dataset.tier!;
      render(!!st.item);
    },
  };
}

function positionsExplorer(root: HTMLElement) {
  const rows = $$<HTMLElement>(root, '[data-row]');
  const dots = $$<HTMLElement>(root, '.dot');
  const panel = root.querySelector<HTMLElement>('[data-panel]')!;
  let item = '';
  const render = (scroll = false) => {
    const sel = rows.find((r) => r.id === item) ?? rows[0];
    for (const r of rows) r.classList.toggle('sel', r === sel);
    for (const d of dots) {
      const on = d.dataset.select === sel?.id;
      d.classList.toggle('on', on);
      d.setAttribute('aria-pressed', String(on));
    }
    showInPanel(panel, sel);
    if (scroll && sel) sel.scrollIntoView({ block: 'nearest' });
  };
  for (const el of $$<HTMLElement>(root, '[data-select]')) {
    el.addEventListener('click', () => {
      item = el.dataset.select!;
      writeHash('positions', { item });
      render();
    });
  }
  return {
    has: (id: string) => rows.some((r) => r.id === id),
    fromHash(tab: string, p: URLSearchParams) {
      if (tab === 'positions') item = p.get('item') ?? '';
      else if (rows.some((r) => r.id === tab)) item = tab;
      render(!!item);
    },
  };
}

export function initExplorers() {
  const work = document.querySelector<HTMLElement>('[data-explorer="work"]');
  const pos = document.querySelector<HTMLElement>('[data-explorer="positions"]');
  if (!work && !pos) return;
  document.documentElement.classList.add('js-explore');
  const w = work ? workExplorer(work) : null;
  const p = pos ? positionsExplorer(pos) : null;
  const sync = () => {
    const { tab, params } = parseHash();
    w?.fromHash(tab, params);
    p?.fromHash(tab, params);
  };
  window.addEventListener('hashchange', sync);
  sync();
}
