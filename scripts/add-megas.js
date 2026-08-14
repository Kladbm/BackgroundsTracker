#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WATCHLIST_FILE = path.join(ROOT, 'custom', 'mega-watchlist.json');
const OVERRIDES_FILE = path.join(ROOT, 'custom', 'overrides.json');
const CATALOG_FILE = path.join(ROOT, 'public', 'data', 'pokedex-catalog.json');
const BACKGROUNDS_DIR = path.join(ROOT, 'public', 'data', 'backgrounds');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function ensureWatchlist() {
  if (!fs.existsSync(WATCHLIST_FILE)) {
    writeJson(WATCHLIST_FILE, []);
    console.log(`Created ${path.relative(ROOT, WATCHLIST_FILE)} with an empty watchlist.`);
  }
  const watchlist = readJson(WATCHLIST_FILE, []);
  if (!Array.isArray(watchlist)) {
    throw new Error(`${path.relative(ROOT, WATCHLIST_FILE)} must be a JSON array of national dex numbers.`);
  }
  return [...new Set(watchlist.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function normalizeOverrides(value) {
  return {
    background_patches: {},
    pokemon_exclusions: {},
    pokemon_additions: {},
    custom_backgrounds: [],
    ...(value && typeof value === 'object' ? value : {}),
  };
}

function additionFromCatalog(entry) {
  return {
    dex: entry.dex,
    name: entry.name,
    pokedex_slug: entry.pokedex_slug,
    types: Array.isArray(entry.types) ? entry.types.slice() : [],
    shiny_available: entry.shiny_available === true,
  };
}

function readBackgrounds() {
  return fs.readdirSync(BACKGROUNDS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(BACKGROUNDS_DIR, file), 'utf8')));
}

function main() {
  const watchlist = ensureWatchlist();
  const catalog = readJson(CATALOG_FILE, { pokemon: [] });
  const overrides = normalizeOverrides(readJson(OVERRIDES_FILE, {}));
  const backgrounds = readBackgrounds();

  let added = 0;
  let skippedExisting = 0;
  let backgroundMegaPairs = 0;
  const touchedBackgrounds = new Set();
  const missingMegaDex = [];

  for (const dex of watchlist) {
    const megaForms = (catalog.pokemon || []).filter((entry) =>
      entry.dex === dex &&
      entry.is_mega === true &&
      entry.is_costume === false
    );

    if (!megaForms.length) {
      missingMegaDex.push(dex);
      continue;
    }

    const matchingBackgrounds = backgrounds.filter((bg) =>
      (bg.pokemon || []).some((pokemon) => pokemon.dex === dex && pokemon.pokedex_slug && !pokemon.pokedex_slug.includes('mega'))
    );

    for (const bg of matchingBackgrounds) {
      const list = Array.isArray(overrides.pokemon_additions[bg.slug])
        ? overrides.pokemon_additions[bg.slug]
        : [];
      const existingSlugs = new Set(list.map((entry) => entry && entry.pokedex_slug).filter(Boolean));

      for (const mega of megaForms) {
        backgroundMegaPairs += 1;
        if (existingSlugs.has(mega.pokedex_slug)) {
          skippedExisting += 1;
          continue;
        }
        list.push(additionFromCatalog(mega));
        existingSlugs.add(mega.pokedex_slug);
        added += 1;
        touchedBackgrounds.add(bg.slug);
      }

      if (list.length) overrides.pokemon_additions[bg.slug] = list;
    }
  }

  writeJson(OVERRIDES_FILE, overrides);

  console.log(`Watchlist dex numbers: ${watchlist.length}`);
  console.log(`Background/mega pairs checked: ${backgroundMegaPairs}`);
  console.log(`Additions written: ${added}`);
  console.log(`Already present, skipped: ${skippedExisting}`);
  console.log(`Backgrounds touched: ${touchedBackgrounds.size}`);
  if (missingMegaDex.length) {
    console.log(`No clean mega forms found for dex: ${missingMegaDex.join(', ')}`);
  }
}

main();
