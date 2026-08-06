// Ditto Tracker — background detail page (step 5).
//
// Reads ?slug= from the query string, fetches data/backgrounds/{slug}.json,
// and renders the hero image, title, release date, description, event info
// (when present), and the pokemon list.
//
// Clicking a pokemon toggles its "collected" state in localStorage via the
// shared storage module (spec section 5). The shiny switch is a DISPLAY
// toggle: it swaps image_normal <-> image_shiny for pokemon with
// shiny_available. Collected state always keys off the dex string and the
// "X / Y" counter counts `normal` entries — identical logic to the homepage,
// so the two pages never disagree. The `shiny` sub-field is recorded (true
// when collected while viewing the shiny display) but does not affect the
// counter; it's there for schema completeness per the spec.
//
// The `event.image` / `image_shiny` files are not all downloaded yet, so
// images render with an onerror fallback rather than a broken icon.

'use strict';

(() => {
  const slug = new URLSearchParams(location.search).get('slug');

  const state = {
    slug,
    data: null,
    collected: storage.read(),
    shinyOn: false, // display toggle
  };

  const $ = (sel) => document.querySelector(sel);

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const dexLabel = (dex) => `#${String(dex).padStart(4, '0')}`;

  // Which image to show for a pokemon, given the shiny display toggle.
  const imageFor = (p) =>
    state.shinyOn && p.shiny_available && p.image_shiny ? p.image_shiny : p.image_normal;

  // ---- rendering ----

  const renderTitle = () => {
    document.title = `${state.data.title} · Pokémon GO Backgrounds`;
    $('#page-title').textContent = state.data.title;
  };

  const renderHero = () => {
    const img = $('#hero-img');
    img.src = `images/backgrounds/${state.data.slug}.png`;
    img.alt = state.data.title;
  };

  const renderMeta = () => {
    $('#meta-date').textContent = `Released ${fmtDate(state.data.release_date)}`;

    const desc = $('#description');
    desc.hidden = !state.data.description;
    if (state.data.description) desc.textContent = state.data.description;

    const evt = $('#event');
    evt.hidden = !state.data.event;
    if (state.data.event) {
      $('#event-name').textContent = state.data.event.name;
      $('#event-dates').textContent = state.data.event.date_range || '';
      const link = $('#event-link');
      link.href = state.data.event.url || '#';
      link.hidden = !state.data.event.url;
    }
  };

  const buildPokemonCard = (p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pokemon-card' + (storage.isCollected(state.collected, state.slug, p.dex) ? ' collected' : '');
    btn.dataset.dex = String(p.dex);
    btn.title = p.name;

    const check = document.createElement('span');
    check.className = 'p-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'p-img';
    img.src = imageFor(p);
    img.alt = p.name;
    img.loading = 'lazy';
    // Shadow-form shinies aren't on the CDN — never show a broken image:
    // fall back to the normal image if a shiny request fails. Compare against
    // the resolved normal URL (a `/shiny` substring check misses files like
    // `145-zapdos-shadow-shiny.png`, where "shiny" follows a dash, not a slash).
    img.addEventListener('error', () => {
      if (img.dataset.fallback === '1') return;
      const normalHref = new URL(p.image_normal, location.href).href;
      if (img.src !== normalHref) {
        img.dataset.fallback = '1';
        img.src = p.image_normal;
      }
    });

    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;

    const dex = document.createElement('span');
    dex.className = 'p-dex';
    dex.textContent = dexLabel(p.dex);

    const types = document.createElement('span');
    types.className = 'p-types';
    for (const t of p.types || []) {
      const badge = document.createElement('span');
      badge.className = `type-badge type-${t}`;
      badge.textContent = t;
      types.appendChild(badge);
    }

    btn.append(check, img, name, dex, types);
    return btn;
  };

  const renderPokemon = () => {
    const list = $('#pokemon-list');
    list.replaceChildren(...state.data.pokemon.map(buildPokemonCard));
    $('#pokemon-count').textContent = `(${state.data.pokemon.length})`;
  };

  const renderCounter = () => {
    const x = storage.collectedCount(state.collected, state.slug);
    $('#collected-count').textContent = `${x} / ${state.data.pokemon.length}`;
  };

  const render = () => {
    renderTitle();
    renderHero();
    renderMeta();
    renderPokemon();
    renderCounter();
  };

  // ---- interactions ----

  // Flip the "normal" collected bit for a pokemon (keyed by dex per spec).
  // Record the shiny sub-field when collected while the shiny display is on
  // and that pokemon actually has a shiny form.
  const toggleCollected = (p) => {
    const slugObj = { ...((state.collected && state.collected[state.slug]) || {}) };
    const cur = slugObj[p.dex];
    const wasCollected = cur === true || (cur && cur.normal === true);
    slugObj[p.dex] = {
      normal: !wasCollected,
      shiny: !wasCollected && state.shinyOn && p.shiny_available,
    };
    state.collected = { ...(state.collected || {}), [state.slug]: slugObj };
    storage.write(state.collected);
    renderPokemon();
    renderCounter();
  };

  const wireShiny = () => {
    $('#shiny-toggle').addEventListener('change', (e) => {
      state.shinyOn = e.target.checked;
      renderPokemon(); // re-picks imageFor for every card; collected marks unchanged
    });
  };

  // Click-to-collect via delegation on the list container: a click anywhere on
  // a card (image, name, types) maps back to its pokemon by dex.
  const wireCards = () => {
    $('#pokemon-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.pokemon-card');
      if (!btn) return;
      const dex = Number(btn.dataset.dex);
      const p = state.data.pokemon.find((x) => x.dex === dex);
      if (p) toggleCollected(p);
    });
  };

  const flashMsg = (text) => {
    const el = $('#msg');
    el.textContent = text;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, 3000);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  };

  const readClipboard = async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (err) {
      return prompt('Paste your exported collected JSON here:');
    }
  };

  const exportJSON = async () => {
    const text = JSON.stringify(state.collected, null, 2);
    const ok = await copyText(text);
    if (ok) {
      flashMsg(`Copied progress for ${Object.keys(state.collected).length} background(s) to clipboard`);
    } else {
      flashMsg('Copy failed — your browser blocked clipboard access');
      console.log('Exported collected JSON:', text);
    }
  };

  const importJSON = async () => {
    const text = await readClipboard();
    if (text == null) return; // cancelled
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a plain object');
      }
      state.collected = parsed;
      storage.write(state.collected);
      renderPokemon();
      renderCounter();
      flashMsg(`Imported progress for ${Object.keys(parsed).length} background(s)`);
    } catch (err) {
      flashMsg('Import failed — that is not valid collected JSON');
    }
  };

  const wireButtons = () => {
    $('#btn-export').addEventListener('click', exportJSON);
    $('#btn-import').addEventListener('click', importJSON);
  };

  // ---- boot ----

  const main = async () => {
    if (!slug) {
      $('#detail').textContent = 'No slug given — pick a background from the grid.';
      return;
    }
    const res = await fetch(`data/backgrounds/${encodeURIComponent(slug)}.json`);
    if (!res.ok) {
      document.title = 'Not found · Pokémon GO Backgrounds';
      $('#detail').textContent = `Background "${slug}" not found (HTTP ${res.status}).`;
      return;
    }
    state.data = await res.json();
    render();
    wireShiny();
    wireCards();
    wireButtons();
  };

  main().catch((err) => {
    console.error('Detail page failed to load:', err.message);
    $('#detail').textContent = `Failed to load ${slug}.json (${err.message})`;
  });
})();
