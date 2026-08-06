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

  const updatePosition = () => {
    const dom = els();
    if (!dom.rail) return;
    const topbar = $('.topbar');
    const topbarHeight = topbar ? topbar.getBoundingClientRect().height : 0;
    const centerTop = topbarHeight + ((window.innerHeight - topbarHeight) / 2);
    dom.rail.style.setProperty('--progress-center-top', `${centerTop}px`);
  };

  const render = (collected, total) => {
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
