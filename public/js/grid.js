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
    detailRequests: new Map(),
    view: 'grid',
    pokemonColumns: 20,
    pokemonScope: 'all',
  };

  // Readable labels for the raw type codes used in index.json.
  const TYPE_LABELS = { sb: 'Special', lc: 'Location' };

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

  const displayPokemonName = (p) =>
    isShadowPokemon(p) ? p.name.replace(/^Shadow\s+/i, '') : p.name;

  // Sort by date or title; backgrounds without a date sort last in both date
  // directions.
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

  const renderCountLabel = (visibleCount) => {
    const label = $('#count-label');
    const total = state.backgrounds.length;
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
    label.append(' backgrounds.');
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

    body.append(title, meta, strip);
    card.append(imgWrap, body);
    return card;
  };

  const newestBackgrounds = (list) => {
    const copy = [...list];
    copy.sort((a, b) => {
      const aNull = !a.release_date;
      const bNull = !b.release_date;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return -a.release_date.localeCompare(b.release_date);
    });
    return copy;
  };

  const buildPokemonPlacementTile = (b, p) => {
    const tile = document.createElement('div');
    tile.className = 'pokemon-placement';
    if (!storage.isCollected(state.collected, b.slug, p.pokedex_slug)) {
      tile.classList.add('uncollected');
    }
    tile.dataset.slug = b.slug;
    tile.title = `${p.name} - ${b.title}`;

    const bg = document.createElement('img');
    bg.className = 'pokemon-placement-bg';
    bg.src = `images/backgrounds/${b.slug}.png`;
    bg.alt = '';
    bg.loading = 'lazy';
    bg.setAttribute('aria-hidden', 'true');

    const spriteWrap = document.createElement('span');
    spriteWrap.className = 'pokemon-placement-sprite-wrap';

    const sprite = document.createElement('img');
    sprite.className = 'pokemon-placement-sprite';
    sprite.src = p.image_normal;
    sprite.alt = p.name;
    sprite.loading = 'lazy';
    spriteWrap.appendChild(sprite);
    if (isShadowPokemon(p)) spriteWrap.appendChild(buildShadowBadge());

    tile.append(bg, spriteWrap);
    return tile;
  };

  const pokemonPlacements = (scope = state.pokemonScope) => {
    const placements = [];
    for (const b of newestBackgrounds(visibleBackgrounds())) {
      for (const p of state.pokemonBySlug[b.slug] || []) {
        const collected = storage.isCollected(state.collected, b.slug, p.pokedex_slug);
        if (scope === 'owned' && !collected) continue;
        placements.push({
          background: b,
          pokemon: p,
          collected,
        });
      }
    }
    return placements;
  };

  // First few pokemon of a background, as lazy <img> thumbnails. Empty (no
  // imgs) until that slug's detail JSON has been fetched.
  const stripImages = (slug) => {
    const pokemon = state.pokemonBySlug[slug] || [];
    const items = pokemon.slice(0, 6).map((p) => {
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
    const hiddenCount = pokemon.length - 6;
    if (hiddenCount > 0) {
      const more = document.createElement('span');
      more.className = 'card-strip-more';
      more.textContent = `+${hiddenCount}`;
      more.title = `${hiddenCount} more Pokemon`;
      items.push(more);
    }
    return items;
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
    if (state.view === 'pokemon') {
      const list = newestBackgrounds(visibleBackgrounds());
      const placements = pokemonPlacements();
      grid.replaceChildren(...placements.map(({ background, pokemon }) =>
        buildPokemonPlacementTile(background, pokemon)
      ));
      const visibleSlugs = new Set(placements.map(({ background }) => background.slug));
      renderCountLabel(list.filter((b) => visibleSlugs.has(b.slug)).length);
      return;
    }
    const list = visibleBackgrounds();
    grid.replaceChildren(...list.map(buildCard));
    renderCountLabel(list.length);
  };

  const updatePokemonViewControls = () => {
    const controls = $('#pokemon-table-controls');
    if (!controls) return;
    const visible = state.view === 'pokemon';
    controls.hidden = !visible;
    if (visible) {
      requestAnimationFrame(() => measureDropdownTrigger('#pokemon-scope-controls'));
    }
  };

  const updatePokemonColumns = (value) => {
    const columns = Math.max(15, Math.min(30, Number(value) || 30));
    state.pokemonColumns = columns;
    const grid = $('#grid');
    if (grid) grid.style.setProperty('--pokemon-columns', String(columns));
    const output = $('#pokemon-row-width-value');
    if (output) output.textContent = String(columns);
  };

  const updateCount = (slug) => {
    const card = document.querySelector(`.card[data-slug="${slug}"]`);
    if (card) card.querySelector('.card-count').textContent = countText(slug);
  };

  const loadBackgroundDetail = (b) => {
    if (state.detailRequests.has(b.slug)) return state.detailRequests.get(b.slug);
    const req = fetch(`data/backgrounds/${b.slug}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        state.yBySlug[b.slug] = Array.isArray(d.pokemon) ? d.pokemon.length : 0;
        state.pokemonBySlug[b.slug] = Array.isArray(d.pokemon) ? d.pokemon : [];
        addToPokemonIndex(b.slug);
        updateCount(b.slug);
        refreshStrip(b.slug);
        if (state.view === 'pokemon') render();
        if (pkmInput().value.trim() && !state.selectedPokemon) renderPkmDropdown(pkmInput().value);
        return d;
      })
      .catch((err) => {
        state.yBySlug[b.slug] = null;
        updateCount(b.slug);
        if (state.view === 'pokemon') render();
        throw err;
      });
    state.detailRequests.set(b.slug, req);
    return req;
  };

  // Fetch every detail JSON in the background; fill in Y as each arrives.
  const loadDetails = () => {
    for (const b of state.backgrounds) {
      loadBackgroundDetail(b).catch(() => {});
    }
  };

  const waitForCurrentDetails = async () => {
    await Promise.allSettled(visibleBackgrounds().map(loadBackgroundDetail));
  };

  const loadCanvasImage = (() => {
    const cache = new Map();
    return (src) => {
      if (cache.has(src)) return cache.get(src);
      const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${src}`));
        img.src = src;
      });
      cache.set(src, promise);
      return promise;
    };
  })();

  const roundedRect = (ctx, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  };

  const drawCover = (ctx, img, x, y, w, h) => {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  };

  const drawContain = (ctx, img, x, y, w, h) => {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.min(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  };

  const exportPokemonImage = async () => {
    const btn = $('#pokemon-export-image');
    const previousText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Preparing...';
    }
    try {
      state.collected = storage.read();
      await waitForCurrentDetails();
      const placements = pokemonPlacements();
      if (!placements.length) {
        window.alert('There are no Pokemon to export with the current filters.');
        return;
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;

      const root = getComputedStyle(document.documentElement);
      const bgColor = root.getPropertyValue('--bg').trim() || '#16181a';
      const panelColor = root.getPropertyValue('--panel').trim() || '#222426';
      const textColor = root.getPropertyValue('--text').trim() || '#fcf7ff';
      const mutedColor = root.getPropertyValue('--muted').trim() || '#858e96';
      const accentColor = root.getPropertyValue('--accent').trim() || '#f4a4f8';
      const borderColor = root.getPropertyValue('--border').trim() || 'rgba(255, 255, 255, 0.1)';
      const font = root.getPropertyValue('--font').trim() || 'Poppins, sans-serif';

      const columns = state.pokemonColumns;
      const tile = 56;
      const gap = 4;
      const pad = 24;
      const header = 84;
      const rows = Math.ceil(placements.length / columns);
      const width = pad * 2 + columns * tile + (columns - 1) * gap;
      const height = pad * 2 + header + rows * tile + Math.max(rows - 1, 0) * gap;
      const scale = 2;

      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = textColor;
      ctx.font = `700 24px ${font}`;
      ctx.fillText('Pokemon GO Backgrounds Collection', pad, pad + 28);

      const maxPlacements = pokemonPlacements('all').length;
      const collected = placements.filter((item) => item.collected).length;
      ctx.fillStyle = mutedColor;
      ctx.font = `500 13px ${font}`;
      const scopeLabel = state.pokemonScope === 'owned' ? 'owned only' : 'all';
      const countLabel = state.pokemonScope === 'owned'
        ? `${collected}/${maxPlacements} collected - ${scopeLabel}`
        : `${collected}/${placements.length} collected - ${scopeLabel}`;
      ctx.fillText(countLabel, pad, pad + 54);

      ctx.fillStyle = accentColor;
      ctx.font = `600 13px ${font}`;
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((collected / maxPlacements) * 100)}%`, width - pad, pad + 54);
      ctx.textAlign = 'left';

      const shadowIcon = await loadCanvasImage('images/icons/shadow.png').catch(() => null);
      const startY = pad + header;
      for (let i = 0; i < placements.length; i += 1) {
        const item = placements[i];
        const x = pad + (i % columns) * (tile + gap);
        const y = startY + Math.floor(i / columns) * (tile + gap);
        const bg = await loadCanvasImage(`images/backgrounds/${item.background.slug}.png`).catch(() => null);
        const sprite = await loadCanvasImage(item.pokemon.image_normal).catch(() => null);

        ctx.save();
        roundedRect(ctx, x, y, tile, tile, 4);
        ctx.clip();
        ctx.fillStyle = item.collected ? panelColor : 'rgb(13, 13, 13)';
        ctx.fillRect(x, y, tile, tile);
        if (bg) {
          ctx.globalAlpha = item.collected ? 1 : 0.05;
          drawCover(ctx, bg, x, y, tile, tile);
          ctx.globalAlpha = 1;
        }
        if (sprite) {
          ctx.filter = item.collected ? 'none' : 'brightness(0.05)';
          drawContain(ctx, sprite, x + tile * 0.09, y + tile * 0.09, tile * 0.82, tile * 0.82);
          ctx.filter = 'none';
        }
        if (shadowIcon && isShadowPokemon(item.pokemon)) {
          ctx.filter = item.collected ? 'none' : 'brightness(0.05)';
          drawContain(ctx, shadowIcon, x + 3, y + tile - 12, 9, 9);
          ctx.filter = 'none';
        }
        ctx.restore();

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        roundedRect(ctx, x + 0.5, y + 0.5, tile - 1, tile - 1, 4);
        ctx.stroke();
      }

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Canvas export failed');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      link.href = url;
      link.download = `pokemon-go-backgrounds-collection-${yyyy}-${mm}-${dd}-${hh}-${min}-${ss}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Image export failed:', err);
      window.alert(`Image export failed: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = previousText;
      }
    }
  };

  const buildTypeControls = () => {
    const present = new Set(state.backgrounds.map((b) => b.type));
    const types = ['sb', 'lc'].filter((t) => present.has(t));
    const container = $('#type-controls .dropdown-menu');
    for (const t of types) {
      const btn = document.createElement('button');
      btn.dataset.type = t;
      btn.textContent = TYPE_LABELS[t] || t;
      btn.setAttribute('aria-pressed', 'false');
      container.appendChild(btn);
    }
  };

  const measureDropdownTrigger = (controlsSel) => {
    const controls = $(controlsSel);
    if (!controls) return;
    const trigger = controls.querySelector('.dropdown-trigger');
    const label = controls.querySelector('.dropdown-label');
    const options = [...controls.querySelectorAll('.dropdown-menu button')].map((b) => b.textContent.trim());
    if (!trigger || !label || !options.length) return;

    const triggerStyle = getComputedStyle(trigger);
    const labelStyle = getComputedStyle(label);
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'nowrap';
    probe.style.fontFamily = labelStyle.fontFamily || triggerStyle.fontFamily;
    probe.style.fontSize = labelStyle.fontSize || triggerStyle.fontSize;
    probe.style.fontWeight = labelStyle.fontWeight || triggerStyle.fontWeight;
    probe.style.letterSpacing = labelStyle.letterSpacing || triggerStyle.letterSpacing;
    document.body.appendChild(probe);

    let maxLabelWidth = 0;
    for (const text of options) {
      probe.textContent = text;
      maxLabelWidth = Math.max(maxLabelWidth, probe.getBoundingClientRect().width);
    }
    probe.remove();

    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };

    controls.style.width = '';
    trigger.style.width = '';
    const children = [...trigger.children].filter((el) => el !== label);
    const iconsWidth = children.reduce((sum, el) => {
      const style = getComputedStyle(el);
      return sum +
        el.getBoundingClientRect().width +
        px(style.marginLeft) +
        px(style.marginRight);
    }, 0);
    const gapsWidth = px(triggerStyle.columnGap || triggerStyle.gap) * Math.max(trigger.children.length - 1, 0);
    const paddingWidth = px(triggerStyle.paddingLeft) + px(triggerStyle.paddingRight);
    const width = Math.ceil(maxLabelWidth + iconsWidth + gapsWidth + paddingWidth);
    controls.style.width = `${width}px`;
    trigger.style.width = '100%';
  };

  const measureDropdownTriggers = () => {
    measureDropdownTrigger('#sort-controls');
    measureDropdownTrigger('#type-controls');
    measureDropdownTrigger('#pokemon-scope-controls');
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
    const matches = [...state.pokemonIndex.entries()]
      .filter(([key]) => key.includes(q))
      .map(([, p]) => p);

    const bySlug = new Map(matches.map((p) => [p.pokedex_slug, p]));
    const used = new Set();
    const ordered = [];
    for (const p of matches) {
      if (used.has(p.pokedex_slug)) continue;
      if (isShadowPokemon(p)) {
        const baseSlug = p.pokedex_slug.replace(/-shadow$/, '');
        if (bySlug.has(baseSlug)) continue;
      }
      ordered.push(p);
      used.add(p.pokedex_slug);
      const shadowSlug = `${p.pokedex_slug}-shadow`;
      if (bySlug.has(shadowSlug) && !used.has(shadowSlug)) {
        ordered.push(bySlug.get(shadowSlug));
        used.add(shadowSlug);
      }
    }
    for (const p of matches) {
      if (!used.has(p.pokedex_slug)) ordered.push(p);
    }
    return ordered.slice(0, 30);
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
      label.textContent = displayPokemonName(p);
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
      grid.classList.toggle('pokemon-view', state.view === 'pokemon');
      updatePokemonViewControls();
      render();
    });

    const pokemonWidth = $('#pokemon-row-width');
    if (pokemonWidth) {
      updatePokemonColumns(pokemonWidth.value);
      pokemonWidth.addEventListener('input', () => updatePokemonColumns(pokemonWidth.value));
    }

    $('#pokemon-scope-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.scope) return;
      state.pokemonScope = btn.dataset.scope;
      setActive('#pokemon-scope-controls', btn);
      $('#pokemon-scope-label').textContent = btn.textContent;
      $('#pokemon-scope-controls').open = false;
      render();
    });

    const exportBtn = $('#pokemon-export-image');
    if (exportBtn) exportBtn.addEventListener('click', exportPokemonImage);
  };

  const main = async () => {
    state.collected = storage.read();
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status} for data/index.json`);
    state.backgrounds = (await res.json()).backgrounds;
    buildTypeControls();
    measureDropdownTriggers();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureDropdownTriggers);
    wireControls();
    wirePkmSearch();
    updatePokemonViewControls();
    render();
    loadDetails();
  };

  main().catch((err) => {
    console.error('Grid failed to load:', err.message);
    $('#grid').textContent = `Failed to load index.json (${err.message})`;
  });
})();
