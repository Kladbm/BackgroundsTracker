'use strict';

const progressRail = (() => {
  const state = {
    loading: null,
    pokemonBySlug: new Map(),
  };

  const $ = (sel) => document.querySelector(sel);

  const els = () => ({
    rail: $('#collection-progress'),
    fill: $('#collection-progress-fill'),
    marker: $('#collection-progress-marker'),
    percent: $('#collection-progress-percent'),
    total: $('#collection-progress-total'),
    collected: $('#collection-progress-collected'),
  });

  const ensureRail = () => {
    if ($('#collection-progress')) return;
    const rail = document.createElement('aside');
    rail.className = 'collection-progress';
    rail.id = 'collection-progress';
    rail.setAttribute('aria-label', 'Overall collection progress');

    const readout = document.createElement('div');
    readout.className = 'collection-progress-readout';
    const percent = document.createElement('span');
    percent.id = 'collection-progress-percent';
    percent.textContent = '0%';
    const marker = document.createElement('span');
    marker.className = 'collection-progress-marker';
    marker.id = 'collection-progress-marker';
    marker.setAttribute('aria-hidden', 'true');
    readout.append(percent, marker);

    const total = document.createElement('div');
    total.className = 'collection-progress-total';
    total.id = 'collection-progress-total';
    total.textContent = '0';

    const track = document.createElement('div');
    track.className = 'collection-progress-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    fill.className = 'collection-progress-fill';
    fill.id = 'collection-progress-fill';
    track.appendChild(fill);

    const collected = document.createElement('div');
    collected.className = 'collection-progress-collected';
    collected.id = 'collection-progress-collected';
    collected.textContent = '0';

    rail.append(readout, total, track, collected);
    document.body.appendChild(rail);
  };

  const updatePosition = () => {
    ensureRail();
    const dom = els();
    if (!dom.rail) return;
    const topbar = $('.topbar');
    const topbarHeight = topbar ? topbar.getBoundingClientRect().height : 0;
    const centerTop = topbarHeight + ((window.innerHeight - topbarHeight) / 2);
    dom.rail.style.setProperty('--progress-center-top', `${centerTop}px`);
  };

  const render = (collected, total) => {
    ensureRail();
    const dom = els();
    if (!dom.rail || !dom.fill || !dom.marker || !dom.percent || !dom.total || !dom.collected) return;
    updatePosition();
    const pct = total ? Math.round((collected / total) * 100) : 0;
    const progress = `${pct}%`;
    const progressOffset = `${(pct / 100) * 320}px`;
    dom.rail.style.setProperty('--progress', progress);
    dom.rail.style.setProperty('--progress-offset', progressOffset);
    dom.percent.textContent = progress;
    dom.total.textContent = total;
    dom.collected.textContent = collected;
  };

  const loadTotals = async () => {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status} for data/index.json`);
    const data = await res.json();
    const backgrounds = Array.isArray(data.backgrounds) ? data.backgrounds : [];
    await Promise.all(backgrounds.map(async (b) => {
      try {
        const detailRes = await fetch(`data/backgrounds/${encodeURIComponent(b.slug)}.json`);
        if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`);
        const detail = await detailRes.json();
        state.pokemonBySlug.set(b.slug, Array.isArray(detail.pokemon) ? detail.pokemon : []);
      } catch {
        state.pokemonBySlug.set(b.slug, []);
      }
    }));
  };

  const refresh = async () => {
    if (!state.loading) state.loading = loadTotals();
    await state.loading;
    const collected = storage.read();
    let collectedTotal = 0;
    let pokemonTotal = 0;
    for (const [slug, pokemon] of state.pokemonBySlug.entries()) {
      pokemonTotal += pokemon.length;
      collectedTotal += storage.collectedCount(collected, slug, pokemon);
    }
    render(collectedTotal, pokemonTotal);
  };

  const start = () => {
    ensureRail();
    updatePosition();
    window.addEventListener('resize', updatePosition);
    render(0, 0);
    refresh().catch(() => render(0, 0));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  return { refresh };
})();

window.progressRail = progressRail;
