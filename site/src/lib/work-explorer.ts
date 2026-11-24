/**
 * The /work/ island (work page spec). The page is complete without it: every
 * row and its detail are rendered, newest first, and the tiles and piece
 * rows are links to the filtered URL. This script only filters,
 * re-sorts by moving the rendered rows, selects an item into the side panel,
 * keeps the counts that depend on other filters current, and mirrors the
 * state in the query string:
 *
 *   /work/?tier=important&area=design&bip=352&kind=task&piece=352|light-client%20index&sort=old&item=<id>
 *
 * tier is the priority group (lib/triage.ts); without it the list opens on the
 * first group that has items, and tier=all shows them all. area=none means no
 * type of work recorded. Past about 1,000 items, render
 * the first 200 in the current order with a "Show 200 more" button here.
 */

type Sort = 'new' | 'old' | 'bip';
interface State { tier: string; area: string; bip: string; kind: string; piece: string; sort: Sort; item: string }

const KIND_LABEL: Record<string, string> = { task: 'Tasks', 'open-question': 'Open questions', objection: 'Objections' };

export function initWorkExplorer() {
  const root = document.querySelector<HTMLElement>('[data-work]');
  if (!root) return;
  document.documentElement.classList.add('js-work');
  const $$ = <T extends HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];

  const list = root.querySelector<HTMLElement>('[data-list]')!;
  const rows = $$<HTMLElement>('[data-row]');
  const order = new Map(rows.map((r, i) => [r, i]));
  const panel = root.querySelector<HTMLElement>('[data-panel]')!;
  const select = root.querySelector<HTMLSelectElement>('[data-bip-select]')!;
  const options = [...select.options];
  const optionLabel = new Map(options.map((o) => [o.value, o.textContent!.replace(/ · \d+ open$/, '')]));
  const tiles = $$<HTMLAnchorElement>('[data-area-tile]');
  const tileLabel = new Map(tiles.map((t) => [t.dataset.areaTile!, t.querySelector('.rl')!.textContent!]));
  const kindPills = $$<HTMLButtonElement>('[data-kind-pill]');
  const tierPills = $$<HTMLButtonElement>('[data-tier-pill]');
  const tierHint = root.querySelector<HTMLElement>('[data-tier-hint]');
  const firstTier = root.querySelector<HTMLElement>('[data-first-tier]')?.dataset.firstTier ?? 'all';
  const sorts = $$<HTMLButtonElement>('[data-sort]');
  const pieceRows = $$<HTMLAnchorElement>('[data-piece-row]');
  const clear = root.querySelector<HTMLButtonElement>('[data-clear]')!;
  const nothing = root.querySelector<HTMLElement>('[data-nothing]')!;
  const title = root.querySelector<HTMLElement>('[data-list-title]')!;
  const count = root.querySelector<HTMLElement>('[data-list-count]')!;

  // Links become toggle buttons once the script runs.
  for (const el of [...tiles, ...pieceRows]) {
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', 'false');
  }

  const q = new URLSearchParams(location.search);
  const st: State = {
    tier: q.get('tier') ?? firstTier,
    area: q.get('area') ?? '',
    bip: q.get('bip') ?? '',
    kind: q.get('kind') ?? '',
    piece: q.get('piece') ?? '',
    sort: (['new', 'old', 'bip'].includes(q.get('sort') ?? '') ? q.get('sort') : 'new') as Sort,
    item: q.get('item') ?? '',
  };
  // A linked item opens in its own group; an item folded into a topic selects the topic's row.
  const linked = st.item ? rows.find((r) => r.dataset.id === st.item || (r.dataset.members ?? '').split(' ').includes(st.item)) : undefined;
  if (linked) st.item = linked.dataset.id!;
  if (linked && !q.get('tier') && linked.dataset.tier !== st.tier) st.tier = linked.dataset.tier!;

  type Dim = 'tier' | 'area' | 'bip' | 'kind' | 'piece';
  const matches = (r: HTMLElement, skip?: Dim) =>
    (skip === 'tier' || st.tier === 'all' || r.dataset.tier === st.tier) &&
    (skip === 'area' || !st.area || r.dataset.area === st.area) &&
    (skip === 'bip' || !st.bip || r.dataset.bip === st.bip) &&
    (skip === 'kind' || !st.kind || r.dataset.kind === st.kind) &&
    (skip === 'piece' || !st.piece || r.dataset.piece === st.piece);

  const sorted = () => {
    const byDate = (dir: number) => (a: HTMLElement, b: HTMLElement) => {
      const x = a.dataset.date!, y = b.dataset.date!;
      return !x && !y ? 0 : !x ? 1 : !y ? -1 : dir * x.localeCompare(y);
    };
    const tie = (a: HTMLElement, b: HTMLElement) => order.get(a)! - order.get(b)!;
    return [...rows].sort((a, b) =>
      st.sort === 'new'
        ? byDate(-1)(a, b) || tie(a, b)
        : st.sort === 'old'
          ? byDate(1)(a, b) || tie(a, b)
          : Number(a.dataset.bip) - Number(b.dataset.bip) || a.dataset.pieceName!.localeCompare(b.dataset.pieceName!) || byDate(-1)(a, b) || tie(a, b),
    );
  };

  const write = () => {
    const p = new URLSearchParams();
    if (st.tier !== firstTier) p.set('tier', st.tier);
    for (const k of ['area', 'bip', 'kind', 'piece'] as const) if (st[k]) p.set(k, st[k]);
    if (st.sort !== 'new') p.set('sort', st.sort);
    if (st.item) p.set('item', st.item);
    const qs = p.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  };

  const render = () => {
    // Order, then visibility.
    for (const r of sorted()) list.appendChild(r);
    const ordered = sorted();
    const visible = ordered.filter((r) => matches(r));
    for (const r of rows) r.hidden = !visible.includes(r);
    let sel = visible.find((r) => r.dataset.id === st.item);
    if (!sel) {
      sel = visible[0];
      if (st.item) st.item = '';
    }
    for (const r of rows) {
      const on = r === sel;
      r.classList.toggle('sel', on);
      r.querySelector('[data-select]')?.setAttribute('aria-pressed', String(on));
    }
    const detail = sel?.querySelector<HTMLElement>('.detail');
    panel.hidden = !detail;
    panel.innerHTML = detail ? detail.outerHTML : '';
    nothing.hidden = visible.length > 0;
    count.textContent = String(visible.length);
    title.textContent = st.area ? tileLabel.get(st.area) ?? 'Open work' : 'Open work';

    // Counts that respect every filter but their own.
    for (const t of tiles) {
      const key = t.dataset.areaTile!;
      const n = rows.filter((r) => matches(r, 'area') && (!key || r.dataset.area === key)).length;
      const c = t.querySelector('[data-count]')!;
      c.textContent = String(n);
      c.classList.toggle('hot', n > 0);
      t.classList.toggle('zero', n === 0);
      // An empty type of work is inactive: dimmed, and a click does nothing.
      if (n === 0 && st.area !== key) t.setAttribute('aria-disabled', 'true');
      else t.removeAttribute('aria-disabled');
      t.setAttribute('aria-pressed', String(st.area === key));
    }
    for (const o of options) {
      const n = rows.filter((r) => (st.tier === 'all' || r.dataset.tier === st.tier) && (!st.area || r.dataset.area === st.area) && (!st.kind || r.dataset.kind === st.kind) && (!o.value || r.dataset.bip === o.value)).length;
      o.textContent = `${optionLabel.get(o.value)} · ${n} open`;
    }
    select.value = st.bip;
    select.classList.toggle('on', !!st.bip);
    for (const p of kindPills) {
      const key = p.dataset.kindPill!;
      p.querySelector('[data-count]')!.textContent = String(rows.filter((r) => matches(r, 'kind') && (!key || r.dataset.kind === key)).length);
      p.setAttribute('aria-pressed', String(st.kind === key));
    }
    for (const p of tierPills) {
      const key = p.dataset.tierPill!;
      p.setAttribute('aria-pressed', String(key === st.tier));
      p.querySelector('[data-count]')!.textContent = String(rows.filter((r) => matches(r, 'tier') && (key === 'all' || r.dataset.tier === key)).length);
      if (key === st.tier && tierHint) tierHint.textContent = p.title || 'Every open item';
    }
    for (const s of sorts) s.setAttribute('aria-pressed', String(s.dataset.sort === st.sort));

    // Pieces.
    for (const p of pieceRows) p.setAttribute('aria-pressed', String(p.dataset.pieceRow === st.piece));

    // What is filtered, for the clear button.
    const parts = [
      st.area && tileLabel.get(st.area),
      st.bip && `BIP ${st.bip}`,
      st.kind && KIND_LABEL[st.kind],
      st.piece && (st.piece.split('|')[1] || `BIP ${st.piece.split('|')[0]} itself`),
    ].filter(Boolean);
    clear.hidden = !parts.length;
    clear.textContent = `${parts.join(' · ')} · Show all ✕`;
    write();
  };

  const setPiece = (key: string) => {
    st.piece = key;
    st.bip = key ? key.split('|')[0] : st.bip;
    st.area = '';
    st.kind = '';
    st.item = '';
  };

  for (const t of tiles)
    t.addEventListener('click', (e) => {
      e.preventDefault();
      if (t.getAttribute('aria-disabled') === 'true') return;
      st.area = t.dataset.areaTile!;
      st.item = '';
      render();
    });
  select.addEventListener('change', () => {
    st.bip = select.value;
    st.piece = '';
    st.item = '';
    render();
  });
  for (const p of tierPills)
    p.addEventListener('click', () => {
      st.tier = p.dataset.tierPill!;
      st.item = '';
      render();
    });
  for (const p of kindPills)
    p.addEventListener('click', () => {
      st.kind = p.dataset.kindPill!;
      st.item = '';
      render();
    });
  for (const s of sorts)
    s.addEventListener('click', () => {
      st.sort = s.dataset.sort as Sort;
      render();
    });
  for (const r of rows)
    r.querySelector('[data-select]')!.addEventListener('click', () => {
      st.item = r.dataset.id!;
      render();
    });
  const clearAll = () => {
    st.area = st.bip = st.kind = st.piece = st.item = '';
    render();
  };
  clear.addEventListener('click', clearAll);
  root.querySelector('[data-clear-inline]')?.addEventListener('click', clearAll);
  // "N more open on <piece>" lives in the panel's copy of the detail.
  panel.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('[data-piece-link]');
    if (!a) return;
    e.preventDefault();
    setPiece(a.dataset.pieceLink!);
    render();
  });
  for (const p of pieceRows)
    p.addEventListener('click', (e) => {
      e.preventDefault();
      if (st.piece === p.dataset.pieceRow) {
        st.piece = '';
        st.item = '';
      } else setPiece(p.dataset.pieceRow!);
      render();
      root.querySelector('#list')!.scrollIntoView({ block: 'start' });
    });

  render();
}
