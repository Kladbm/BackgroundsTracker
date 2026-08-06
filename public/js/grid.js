// Ditto Tracker - homepage grid (step 4).
//
// Loads public/data/index.json and renders the background grid. Each card:
// hero image, type badge, title, release date ("Aug 28, 2026" or "-" when
// null), and a "X/Y collected" counter. Y = pokemon.length from the detail
// JSON (NOT pokemon_count from index.json - they measure different things by
// design; index counts catchable + evolvable, the detail page only catchable).
// X = number of pokemon marked collected in localStorage (spec section 5).
//
// The grid renders immediately from index.json; detail JSONs load in the
// background and fill in the Y denominator as they arrive, so a card shows
// "..." for a moment. If a detail JSON fails to load, that card falls back to
// "-". No framework, no build step.
//
// localStorage reads/writes and the "X/Y" counting live in the shared
// storage.js module (spec section 6) so the homepage and the detail page
// always agree on the same collected state.

'use strict';

(() => {
  const state = {
    backgrounds: [],      // raw entries from index.json
    collected: {},        // parsed localStorage 'collected'
    yBySlug: {},          // slug -> pokemon.length (detail JSON), null on failure
    pokemonBySlug: {},    // slug -> pokemon[] (detail JSON), for pokemon-name search + list-view strips
    type: 'All',
    sort: 'newest',
    search: '',
    selectedPokemon: null,   // exact pokemon name picked from the dropdown
    pokemonIndex: new Map(), // lowercased name -> { name, image } (from detail JSONs)
    view: 'grid',
  };

  // Readable labels for the raw type codes used in index.json.
  const TYPE_LABELS = { sb: 'Special Background', lc: 'Location Card' };

  const $ = (sel) => document.querySelector(sel);

  const fmtDate = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const isShadowPokemon = (p) => String(p.pokedex_slug || '').endsWith('-shadow');

  const buildShadowBadge = () => {
    const badge = document.createElement('img');
    badge.className = 'shadow-badge';
    badge.src = 'images/icons/shadow.png';
    badge.alt = '';
    badge.loading = 'lazy';
    badge.setAttribute('aria-hidden', 'true');
    return badge;
  };

  // Newest/oldest by release_date; backgrounds without a date sort last in
  // both directions.
  const sortBackgrounds = (list) => {
    const copy = [...list];
    copy.sort((a, b) => {
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
      if (state.selectedPokemon) {
        const names = (state.pokemonBySlug[b.slug] || []).map((p) => p.name.toLowerCase());
        if (!names.includes(state.selectedPokemon.toLowerCase())) return false;
      }
      return true;
    });
    return sortBackgrounds(filtered);
  };

  const countText = (slug) => {
    const y = state.yBySlug[slug];
    if (y === undefined) return '...'; // detail JSON still loading
    if (y === null) return '-';      // detail JSON failed to load
    return `${storage.collectedCount(state.collected, slug, state.pokemonBySlug[slug])}/${y}`;
  };

  const buildCard = (b) => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `background.html?slug=${encodeURIComponent(b.slug)}`;
    card.dataset.slug = b.slug;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'card-img';
    const img = document.createElement('img');
    img.src = `images/backgrounds/${b.slug}.png`;
    img.alt = b.title;
    img.loading = 'lazy';
    imgWrap.appendChild(img);

    const body = document.createElement('div');
    body.className = 'card-body';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'card-type';
    typeBadge.dataset.type = b.type;
    typeBadge.textContent = TYPE_LABELS[b.type] || b.type;

    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = b.title;

    // Release date + collected count sit together on one line (reference layout).
    const meta = document.createElement('div');
    meta.className = 'card-meta';

    const date = document.createElement('span');
    date.className = 'card-date';
    date.textContent = fmtDate(b.release_date);

    const count = document.createElement('span');
    count.className = 'card-count';
    count.textContent = countText(b.slug);

    meta.append(date, count);

    // Pokemon thumb-strip: filled from detail JSONs as they load; shown in
    // list view (display:none in grid view, so lazy images never download).
    const strip = document.createElement('div');
    strip.className = 'card-strip';
    const imgs = stripImages(b.slug);
    if (imgs.length) strip.append(...imgs);

    body.append(typeBadge, title, meta, strip);
    card.append(imgWrap, body);
    return card;
  };

  // First few pokemon of a background, as lazy <img> thumbnails. Empty (no
  // imgs) until that slug's detail JSON has been fetched.
  const stripImages = (slug) => {
    const pokemon = state.pokemonBySlug[slug] || [];
    return pokemon.slice(0, 8).map((p) => {
      const item = document.createElement('span');
      item.className = 'card-strip-item';

      const s = document.createElement('img');
      s.className = 'card-strip-img';
      s.src = p.image_normal;
      s.alt = p.name;
      s.loading = 'lazy';
      item.appendChild(s);
      if (isShadowPokemon(p)) item.appendChild(buildShadowBadge());
      return item;
    });
  };

  // Index one background's Pokemon for the dropdown, deduping repeated species.
  const addToPokemonIndex = (slug) => {
    for (const p of state.pokemonBySlug[slug] || []) {
      const key = p.name.toLowerCase();
      if (!state.pokemonIndex.has(key)) {
        state.pokemonIndex.set(key, {
          name: p.name,
          image: p.image_normal,
          pokedex_slug: p.pokedex_slug,
        });
      }
    }
  };

  // Called as each detail JSON arrives: fill in the strip that buildCard left
  // empty (and any strip on cards recreated by a later render).
  const refreshStrip = (slug) => {
    const strip = document.querySelector(`.card[data-slug="${slug}"] .card-strip`);
    if (!strip) return;
    const imgs = stripImages(slug);
    if (imgs.length) strip.replaceChildren(...imgs);
  };

  const render = () => {
    const grid = $('#grid');
    const list = visibleBackgrounds();
    grid.replaceChildren(...list.map(buildCard));
    $('#count-label').textContent = `Displaying ${list.length} of ${state.backgrounds.length} backgrounds.`;
  };

  const updateCount = (slug) => {
    const card = document.querySelector(`.card[data-slug="${slug}"]`);
    if (card) card.querySelector('.card-count').textContent = countText(slug);
  };

  // Fetch every detail JSON in the background; fill in Y as each arrives.
  const loadDetails = () => {
    for (const b of state.backgrounds) {
      fetch(`data/backgrounds/${b.slug}.json`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          state.yBySlug[b.slug] = Array.isArray(d.pokemon) ? d.pokemon.length : 0;
          state.pokemonBySlug[b.slug] = Array.isArray(d.pokemon) ? d.pokemon : [];
          addToPokemonIndex(b.slug);
          updateCount(b.slug);
          refreshStrip(b.slug);
          if (pkmInput().value.trim() && !state.selectedPokemon) renderPkmDropdown(pkmInput().value);
        })
        .catch(() => {
          state.yBySlug[b.slug] = null;
          updateCount(b.slug);
        });
    }
  };

  const buildTypeControls = () => {
    const types = [...new Set(state.backgrounds.map((b) => b.type))].sort();
    const container = $('#type-controls .dropdown-menu');
    for (const t of types) {
      const btn = document.createElement('button');
      btn.dataset.type = t;
      btn.textContent = TYPE_LABELS[t] || t;
      btn.setAttribute('aria-pressed', 'false');
      container.appendChild(btn);
    }
  };

  const setActive = (containerSel, activeBtn) => {
    $(containerSel).querySelectorAll('button').forEach((b) => {
      const on = b === activeBtn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };


  const pkmDropdown = () => $('#pokemon-dropdown');
  const pkmInput = () => $('#pokemon-search');

  const openPkmDropdown = () => {
    pkmDropdown().hidden = false;
    pkmInput().setAttribute('aria-expanded', 'true');
  };

  const closePkmDropdown = () => {
    pkmDropdown().hidden = true;
    pkmInput().setAttribute('aria-expanded', 'false');
  };

  const pkmMatches = (query) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return [...state.pokemonIndex.entries()]
      .filter(([key]) => key.includes(q))
      .slice(0, 30)
      .map(([, p]) => p);
  };

  const setPkmHighlight = (index) => {
    const btns = [...pkmDropdown().querySelectorAll('button')];
    btns.forEach((b, i) => b.classList.toggle('active', i === index));
    return btns[index] || null;
  };

  const renderPkmDropdown = (query) => {
    const box = pkmDropdown();
    const matches = pkmMatches(query);
    if (!matches.length) {
      box.replaceChildren();
      closePkmDropdown();
      return;
    }
    box.replaceChildren(...matches.map((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.role = 'option';
      btn.dataset.name = p.name;
      const imgWrap = document.createElement('span');
      imgWrap.className = 'pkm-option-thumb';
      const img = document.createElement('img');
      img.className = 'pkm-option-img';
      img.src = p.image;
      img.alt = '';
      img.loading = 'lazy';
      imgWrap.appendChild(img);
      if (isShadowPokemon(p)) imgWrap.appendChild(buildShadowBadge());
      const label = document.createElement('span');
      label.className = 'pkm-option-name';
      label.textContent = p.name;
      btn.append(imgWrap, label);
      return btn;
    }));
    openPkmDropdown();
    setPkmHighlight(-1);
  };

  const pickPokemon = (name) => {
    state.selectedPokemon = name;
    pkmInput().value = name;
    closePkmDropdown();
    render();
  };

  const wirePkmSearch = () => {
    const input = pkmInput();
    const dropdown = pkmDropdown();

    input.addEventListener('input', () => {
      const text = input.value;
      if (state.selectedPokemon && text.trim().toLowerCase() !== state.selectedPokemon.toLowerCase()) {
        state.selectedPokemon = null;
      }
      if (!text.trim()) {
        closePkmDropdown();
        render();
        return;
      }
      renderPkmDropdown(text);
    });

    dropdown.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn.dataset.name) pickPokemon(btn.dataset.name);
    });

    input.addEventListener('keydown', (e) => {
      if (dropdown.hidden) return;
      const btns = [...dropdown.querySelectorAll('button')];
      if (!btns.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let idx = btns.findIndex((b) => b.classList.contains('active'));
        idx = idx === -1 ? (dir === 1 ? 0 : btns.length - 1) : idx + dir;
        idx = (idx + btns.length) % btns.length;
        const el = setPkmHighlight(idx);
        if (el) el.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const active = btns.find((b) => b.classList.contains('active'));
        if (active) {
          e.preventDefault();
          active.click();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePkmDropdown();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pkm-search')) closePkmDropdown();
    });
  };

  const wireControls = () => {
    $('#search').addEventListener('input', (e) => {
      state.search = e.target.value;
      render();
    });


    $('#sort-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.sort) return;
      state.sort = btn.dataset.sort;
      setActive('#sort-controls', btn);
      $('#sort-label').textContent = btn.textContent;
      $('#sort-controls').open = false; // native <details> close
      render();
    });

    $('#type-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.type) return;
      state.type = btn.dataset.type;
      setActive('#type-controls', btn);
      $('#type-label').textContent = btn.textContent;
      $('#type-controls').open = false; // native <details> close
      render();
    });

    $('#view-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.view) return;
      state.view = btn.dataset.view;
      setActive('#view-controls', btn);
      const grid = $('#grid');
      grid.classList.toggle('grid-view', state.view === 'grid');
      grid.classList.toggle('list-view', state.view === 'list');
    });
  };

  const main = async () => {
    state.collected = storage.read();
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status} for data/index.json`);
    state.backgrounds = (await res.json()).backgrounds;
    buildTypeControls();
    wireControls();
    wirePkmSearch();
    render();
    loadDetails();
  };

  main().catch((err) => {
    console.error('Grid failed to load:', err.message);
    $('#grid').textContent = `Failed to load index.json (${err.message})`;
  });
})();
