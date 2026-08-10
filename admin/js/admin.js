'use strict';

(() => {
  const LIVE_BASE = 'https://kladbm.github.io/BackgroundsTracker/';
  const TYPE_LABELS = { sb: 'Special', lc: 'Location', custom: 'Custom' };

  const state = {
    backgrounds: [],
    detailBySlug: new Map(),
    type: 'All',
    sort: 'newest',
    search: '',
    activeSlug: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const liveUrl = (path) => new URL(path, LIVE_BASE).href;

  const fmtDate = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const dexLabel = (dex) => `#${String(dex).padStart(4, '0')}`;

  const resolveAsset = (path) => {
    if (!path) return '';
    try {
      return new URL(path, LIVE_BASE).href;
    } catch {
      return '';
    }
  };

  const sortBackgrounds = (list) => {
    const copy = [...list];
    copy.sort((a, b) => {
      if (state.sort === 'az' || state.sort === 'za') {
        const cmp = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        return state.sort === 'az' ? cmp : -cmp;
      }
      const aNull = !a.release_date;
      const bNull = !b.release_date;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      const cmp = a.release_date.localeCompare(b.release_date);
      return state.sort === 'newest' ? -cmp : cmp;
    });
    return copy;
  };

  const visibleBackgrounds = () => {
    const q = state.search.trim().toLowerCase();
    const filtered = state.backgrounds.filter((b) => {
      if (state.type !== 'All' && b.type !== state.type) return false;
      if (q && !b.title.toLowerCase().includes(q)) return false;
      return true;
    });
    return sortBackgrounds(filtered);
  };

  const renderCountLabel = (visibleCount) => {
    const total = state.backgrounds.length;
    const label = $('#count-label');
    label.replaceChildren();
    label.append('Displaying ');
    if (visibleCount < total) {
      const pill = document.createElement('span');
      pill.className = 'count-pill';
      pill.textContent = `${visibleCount} of ${total}`;
      label.append(pill);
    } else {
      label.append(`${visibleCount} of ${total}`);
    }
    label.append(' live backgrounds.');
  };

  const buildCard = (b) => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `#${encodeURIComponent(b.slug)}`;
    card.dataset.slug = b.slug;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'card-img';
    const img = document.createElement('img');
    img.src = liveUrl(`images/backgrounds/${b.slug}.png`);
    img.alt = b.title;
    img.loading = 'lazy';
    imgWrap.appendChild(img);

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = b.title;

    const meta = document.createElement('div');
    meta.className = 'card-meta';

    const date = document.createElement('span');
    date.className = 'card-date';
    date.textContent = fmtDate(b.release_date);

    const count = document.createElement('span');
    count.className = 'card-count';
    count.textContent = String(b.pokemon_count ?? '-');

    meta.append(date, count);
    body.append(title, meta);
    card.append(imgWrap, body);
    return card;
  };

  const renderGrid = () => {
    const list = visibleBackgrounds();
    const grid = $('#grid');
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'No backgrounds match the current filters.';
      grid.replaceChildren(empty);
    } else {
      grid.replaceChildren(...list.map(buildCard));
    }
    renderCountLabel(list.length);
  };

  const showGrid = () => {
    state.activeSlug = null;
    $('.admin-grid-head').hidden = false;
    $('.admin-detail-head').hidden = true;
    $('#grid').hidden = false;
    $('#detail').hidden = true;
    document.title = 'Admin Browse - Pokemon GO Backgrounds Tracker';
    if (location.hash) history.pushState('', document.title, location.pathname + location.search);
  };

  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  };

  const loadDetail = async (slug) => {
    if (!state.detailBySlug.has(slug)) {
      state.detailBySlug.set(slug, fetchJson(liveUrl(`data/backgrounds/${encodeURIComponent(slug)}.json`)));
    }
    return state.detailBySlug.get(slug);
  };

  const renderEvent = (data) => {
    const evt = $('#event');
    evt.hidden = !data.event;
    if (!data.event) return;

    evt.classList.remove('has-event-image', 'no-event-image');
    evt.classList.add('no-event-image');
    evt.href = data.event.url || '#';
    $('#event-name').textContent = data.event.name || '';
    $('#event-dates').textContent = data.event.date_range || '';

    const thumb = $('#event-thumb');
    thumb.hidden = true;
    thumb.alt = data.event.name || '';
    if (data.event.image) {
      thumb.src = resolveAsset(data.event.image);
      thumb.onload = () => {
        thumb.hidden = false;
        evt.classList.remove('no-event-image');
        evt.classList.add('has-event-image');
      };
      thumb.onerror = () => {
        thumb.hidden = true;
        evt.classList.remove('has-event-image');
        evt.classList.add('no-event-image');
      };
    }
  };

  const buildTypeIcons = (types = []) => {
    const wrap = document.createElement('span');
    wrap.className = 'p-types';
    for (const t of types) {
      const icon = document.createElement('img');
      icon.className = 'type-icon';
      icon.src = resolveAsset(`images/types/${t}.png`);
      icon.alt = t;
      icon.title = t;
      icon.loading = 'lazy';
      wrap.appendChild(icon);
    }
    return wrap;
  };

  const buildPokemonCard = (p) => {
    const card = document.createElement('div');
    card.className = 'pokemon-card';
    card.dataset.pokedexSlug = p.pokedex_slug;

    const imgWrap = document.createElement('span');
    imgWrap.className = 'p-img-wrap';
    const img = document.createElement('img');
    img.className = 'p-img';
    img.src = resolveAsset(p.image_normal);
    img.alt = p.name;
    img.loading = 'lazy';
    imgWrap.appendChild(img);

    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;

    const dex = document.createElement('span');
    dex.className = 'p-dex';
    dex.textContent = dexLabel(p.dex);

    const meta = document.createElement('span');
    meta.className = 'p-meta';
    meta.append(dex, buildTypeIcons(p.types));

    card.append(imgWrap, name, meta);
    return card;
  };

  const showDetail = async (slug) => {
    state.activeSlug = slug;
    $('.admin-grid-head').hidden = true;
    $('.admin-detail-head').hidden = false;
    $('#grid').hidden = true;
    $('#detail').hidden = false;
    $('#page-title').textContent = 'Loading...';
    $('#pokemon-list').replaceChildren();

    const data = await loadDetail(slug);
    if (state.activeSlug !== slug) return;

    document.title = `${data.title} - Admin Browse`;
    $('#page-title').textContent = data.title;
    $('#hero-img').src = liveUrl(`images/backgrounds/${data.slug}.png`);
    $('#hero-img').alt = data.title;
    $('#meta-date').textContent = `Released ${fmtDate(data.release_date)}`;

    const desc = $('#description');
    desc.hidden = !data.description;
    desc.textContent = data.description || '';

    renderEvent(data);
    const pokemon = Array.isArray(data.pokemon) ? data.pokemon : [];
    $('#pokemon-count').textContent = `(${pokemon.length})`;
    $('#pokemon-list').replaceChildren(...pokemon.map(buildPokemonCard));
  };

  const buildTypeControls = () => {
    const present = new Set(state.backgrounds.map((b) => b.type));
    const menu = $('#type-controls .dropdown-menu');
    for (const t of ['sb', 'lc', 'custom']) {
      if (!present.has(t)) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.type = t;
      btn.textContent = TYPE_LABELS[t] || t;
      btn.setAttribute('aria-pressed', 'false');
      menu.appendChild(btn);
    }
  };

  const setActive = (containerSel, activeBtn) => {
    $(containerSel).querySelectorAll('button').forEach((btn) => {
      const active = btn === activeBtn;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  };

  const wireControls = () => {
    $('#search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderGrid();
    });

    $('#sort-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.sort) return;
      state.sort = btn.dataset.sort;
      setActive('#sort-controls', btn);
      $('#sort-label').textContent = btn.textContent;
      $('#sort-controls').open = false;
      renderGrid();
    });

    $('#type-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.type) return;
      state.type = btn.dataset.type;
      setActive('#type-controls', btn);
      $('#type-label').textContent = btn.textContent;
      $('#type-controls').open = false;
      renderGrid();
    });

    $('#grid').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      history.pushState('', '', `#${encodeURIComponent(card.dataset.slug)}`);
      showDetail(card.dataset.slug).catch(showError);
    });

    $('#back-to-grid').addEventListener('click', showGrid);
    window.addEventListener('popstate', () => {
      const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (slug) showDetail(slug).catch(showError);
      else showGrid();
    });
  };

  const showError = (err) => {
    console.error('Admin browse failed:', err);
    const message = err && err.message ? err.message : String(err);
    if (state.activeSlug) {
      $('#pokemon-list').replaceChildren();
      $('#page-title').textContent = 'Failed to load background';
      $('#description').hidden = false;
      $('#description').textContent = message;
    } else {
      $('#grid').textContent = `Failed to load live data (${message})`;
    }
  };

  const main = async () => {
    const index = await fetchJson(liveUrl('data/index.json'));
    state.backgrounds = Array.isArray(index.backgrounds) ? index.backgrounds : [];
    buildTypeControls();
    wireControls();
    renderGrid();

    const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (slug) await showDetail(slug);
  };

  main().catch(showError);
})();
