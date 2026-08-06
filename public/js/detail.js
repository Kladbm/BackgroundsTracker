// Ditto Tracker — background detail page (step 5).
//
// Reads ?slug= from the query string, fetches data/backgrounds/{slug}.json,
// and renders the hero image, title, release date, description, event info
// (when present), and the pokemon list.
//
// Clicking a pokemon toggles its "collected" state in localStorage via the
// shared storage module (spec section 5). The shiny switch is a DISPLAY
// toggle: it swaps image_normal <-> image_shiny for pokemon with
// shiny_available. Collected state always keys off the pokedex_slug string and the
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
      evt.classList.remove('has-event-image', 'no-event-image');
      evt.classList.add('no-event-image');
      evt.href = state.data.event.url || '#';
      $('#event-name').textContent = state.data.event.name;
      $('#event-dates').textContent = state.data.event.date_range || '';

      // Event thumbnail sits above the event name; hide when the file is
      // missing (older JSONs have no image path, some downloads 404).
      const thumb = $('#event-thumb');
      thumb.hidden = true;
      thumb.alt = state.data.event.name;
      if (state.data.event.image) {
        thumb.src = state.data.event.image;
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
    }
  };

  const buildPokemonCard = (p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pokemon-card' + (storage.isCollected(state.collected, state.slug, p.pokedex_slug) ? ' collected' : '');
    btn.dataset.pokedexSlug = p.pokedex_slug;
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

    const imgWrap = document.createElement('span');
    imgWrap.className = 'p-img-wrap';
    imgWrap.appendChild(img);
    if (isShadowPokemon(p)) imgWrap.appendChild(buildShadowBadge());

    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;

    const dex = document.createElement('span');
    dex.className = 'p-dex';
    dex.textContent = dexLabel(p.dex);

    const types = document.createElement('span');
    types.className = 'p-types';
    for (const t of p.types || []) {
      const icon = document.createElement('img');
      icon.className = 'type-icon';
      icon.src = `images/types/${t}.png`;
      icon.alt = t;
      icon.title = t;
      icon.loading = 'lazy';
      types.appendChild(icon);
    }

    btn.append(check, imgWrap, name, dex, types);
    return btn;
  };

  const renderPokemon = () => {
    const list = $('#pokemon-list');
    list.replaceChildren(...state.data.pokemon.map(buildPokemonCard));
    $('#pokemon-count').textContent = `(${state.data.pokemon.length})`;
  };

  const renderCounter = () => {
    const x = storage.collectedCount(state.collected, state.slug, state.data.pokemon);
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

  // Flip the "normal" collected bit for a pokemon (keyed by pokedex_slug).
  // Record the shiny sub-field when collected while the shiny display is on
  // and that pokemon actually has a shiny form.
  const toggleCollected = (p) => {
    const slugObj = { ...((state.collected && state.collected[state.slug]) || {}) };
    const cur = slugObj[p.pokedex_slug];
    const wasCollected = cur && cur.normal === true;
    slugObj[p.pokedex_slug] = {
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
  // a card (image, name, types) maps back to its pokemon by pokedex_slug.
  const wireCards = () => {
    $('#pokemon-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.pokemon-card');
      if (!btn) return;
      const p = state.data.pokemon.find((x) => x.pokedex_slug === btn.dataset.pokedexSlug);
      if (p) toggleCollected(p);
    });
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
  };

  main().catch((err) => {
    console.error('Detail page failed to load:', err.message);
    $('#detail').textContent = `Failed to load ${slug}.json (${err.message})`;
  });
})();
