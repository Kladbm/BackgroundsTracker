const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const CUSTOM_DIR = path.join(ROOT_DIR, 'custom');
const OVERRIDES_FILE = path.join(CUSTOM_DIR, 'overrides.json');
const CUSTOM_IMAGES_DIR = path.join(CUSTOM_DIR, 'images');

function loadOverrides(logger = console) {
  if (!fs.existsSync(OVERRIDES_FILE)) return {};

  try {
    const raw = fs.readFileSync(OVERRIDES_FILE, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    logger.log(`WARN overrides: could not read ${OVERRIDES_FILE}: ${err.message}; using no overrides`);
    return {};
  }
}

function pokemonImagePaths(pokemon) {
  const file = `${pokemon.dex}-${pokemon.pokedex_slug}.png`;
  const paths = {
    normal: `images/pokemon/${file}`,
  };
  if (pokemon.shiny_available) {
    paths.shiny = `images/pokemon/${pokemon.dex}-${pokemon.pokedex_slug}-shiny.png`;
  }
  return paths;
}

function normalizePokemon(entry) {
  const pokemon = {
    dex: entry.dex,
    name: entry.name,
    pokedex_slug: entry.pokedex_slug,
    types: Array.isArray(entry.types) ? entry.types.slice() : [],
    shiny_available: entry.shiny_available === true,
  };
  const images = pokemonImagePaths(pokemon);
  pokemon.image_normal = images.normal;
  if (pokemon.shiny_available) pokemon.image_shiny = images.shiny;
  return pokemon;
}

function applyOverrides(indexBackgrounds, detailsBySlug, overrides, logger = console) {
  const backgroundPatches = overrides.background_patches || {};
  const pokemonExclusions = overrides.pokemon_exclusions || {};
  const pokemonAdditions = overrides.pokemon_additions || {};
  const customBackgrounds = overrides.custom_backgrounds || [];
  const indexBySlug = new Map(indexBackgrounds.map((b) => [b.slug, b]));
  const officialSlugs = new Set(indexBySlug.keys());

  for (const [slug, data] of detailsBySlug) {
    const patch = backgroundPatches[slug];
    if (patch) {
      if (Object.prototype.hasOwnProperty.call(patch, 'title')) data.title = patch.title;
      if (Object.prototype.hasOwnProperty.call(patch, 'description')) data.description = patch.description;
      if (indexBySlug.has(slug) && Object.prototype.hasOwnProperty.call(patch, 'title')) {
        indexBySlug.get(slug).title = patch.title;
      }
    }

    const exclusions = new Set(Array.isArray(pokemonExclusions[slug]) ? pokemonExclusions[slug] : []);
    if (exclusions.size) {
      data.pokemon = data.pokemon.filter((p) => !exclusions.has(p.pokedex_slug));
    }

    const additions = Array.isArray(pokemonAdditions[slug]) ? pokemonAdditions[slug] : [];
    for (const addition of additions) {
      if (data.pokemon.some((p) => p.pokedex_slug === addition.pokedex_slug)) {
        logger.log(`skipped addition ${slug}/${addition.pokedex_slug}: already present officially`);
        continue;
      }
      data.pokemon.push(normalizePokemon(addition));
    }

    if (indexBySlug.has(slug)) {
      indexBySlug.get(slug).pokemon_count = data.pokemon.length;
    }
  }

  for (const custom of customBackgrounds) {
    if (officialSlugs.has(custom.slug)) {
      throw new Error(`custom background slug collides with official background: ${custom.slug}`);
    }
    if (detailsBySlug.has(custom.slug)) {
      throw new Error(`duplicate custom background slug: ${custom.slug}`);
    }

    const data = {
      slug: custom.slug,
      type: custom.type || 'custom',
      title: custom.title,
      release_date: custom.release_date || null,
      description: custom.description || null,
      event: custom.event || null,
      pokemon: Array.isArray(custom.pokemon) ? custom.pokemon.map(normalizePokemon) : [],
      custom: true,
    };
    detailsBySlug.set(data.slug, data);
    indexBackgrounds.push({
      slug: data.slug,
      type: data.type,
      title: data.title,
      release_date: data.release_date,
      pokemon_count: data.pokemon.length,
      custom: true,
    });
  }
}

function copyIfAvailable(src, dest, label, required, logger, copied, skipped, missing) {
  if (fs.existsSync(dest)) {
    if (fs.existsSync(src)) {
      logger.log(`WARN custom image ${label}: destination already exists, keeping existing file`);
      skipped.push(label);
    }
    return;
  }

  if (!fs.existsSync(src)) {
    if (required) {
      logger.log(`WARN custom image ${label}: missing ${src}`);
      missing.push(label);
    }
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied.push(label);
}

function copyCustomImages(detailsBySlug, imagesDir, overrides, logger = console) {
  const copied = [];
  const skipped = [];
  const missing = [];
  const customBackgroundSlugs = new Set(
    Array.isArray(overrides.custom_backgrounds)
      ? overrides.custom_backgrounds.map((b) => b.slug)
      : []
  );

  for (const [slug, data] of detailsBySlug) {
    const heroLabel = `backgrounds/${slug}.png`;
    copyIfAvailable(
      path.join(CUSTOM_IMAGES_DIR, heroLabel),
      path.join(imagesDir, heroLabel),
      heroLabel,
      data.custom === true || customBackgroundSlugs.has(slug),
      logger,
      copied,
      skipped,
      missing
    );

    for (const pokemon of data.pokemon) {
      const images = pokemonImagePaths(pokemon);
      for (const rel of Object.values(images)) {
        const label = rel.replace(/^images\//, '');
        const src = path.join(CUSTOM_IMAGES_DIR, label);
        const dest = path.join(imagesDir, label);
        const sourceExists = fs.existsSync(src);
        const required = isCustomPokemon(slug, pokemon.pokedex_slug, overrides);
        if (sourceExists || required) {
          copyIfAvailable(src, dest, label, required, logger, copied, skipped, missing);
        }
      }
    }
  }

  return { copied, skipped, missing };
}

function isCustomPokemon(slug, pokedexSlug, overrides) {
  const additions = overrides.pokemon_additions || {};
  const customBackgrounds = overrides.custom_backgrounds || [];
  if (Array.isArray(additions[slug]) && additions[slug].some((p) => p.pokedex_slug === pokedexSlug)) {
    return true;
  }
  return customBackgrounds.some((bg) =>
    bg.slug === slug &&
    Array.isArray(bg.pokemon) &&
    bg.pokemon.some((p) => p.pokedex_slug === pokedexSlug)
  );
}

module.exports = {
  OVERRIDES_FILE,
  CUSTOM_IMAGES_DIR,
  loadOverrides,
  applyOverrides,
  copyCustomImages,
  normalizePokemon,
};
