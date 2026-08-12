const fs = require('fs');
const path = require('path');

const SITE_BASE = process.env.SITE_BASE || 'https://www.dittobase.com';
const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DATA_DIR = process.env.DATA_DIR ||
  path.join(__dirname, '..', 'public', 'data');
const OUTPUT_FILE = process.env.POKEDEX_CATALOG_OUTPUT ||
  path.join(DATA_DIR, 'pokedex-catalog.json');

const NEXT_F_CHUNK_RE = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

function decodeRscPayload(html) {
  let out = '';
  let m;
  NEXT_F_CHUNK_RE.lastIndex = 0;
  while ((m = NEXT_F_CHUNK_RE.exec(html))) {
    try { out += JSON.parse('"' + m[1] + '"'); }
    catch { out += m[1]; }
  }
  return out;
}

function endOfObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractCatalogObjects(rsc) {
  const bySlug = new Map();
  let pos = 0;
  while ((pos = rsc.indexOf('{"slug":"', pos)) !== -1) {
    const end = endOfObject(rsc, pos);
    if (end < 0) break;
    const raw = rsc.slice(pos, end);
    pos += 9;
    try {
      const obj = JSON.parse(raw);
      if (
        typeof obj.slug === 'string' &&
        typeof obj.speciesId === 'number' &&
        typeof obj.speciesSlug === 'string' &&
        Array.isArray(obj.PokemonImage)
      ) {
        bySlug.set(obj.slug, obj);
      }
    } catch {
      // RSC contains many non-JSON fragments; malformed slices are expected.
    }
  }
  return [...bySlug.values()];
}

function mapTypes(raw) {
  return (raw.types || raw.PokemonTypes || [])
    .slice()
    .sort((a, b) => (a.slot || 0) - (b.slot || 0))
    .map((entry) => {
      if (typeof entry.slug === 'string') return entry.slug;
      if (entry.type && typeof entry.type.slug === 'string') return entry.type.slug;
      return null;
    })
    .filter(Boolean);
}

function mapCatalogEntry(raw) {
  const normal = raw.PokemonImage.find((img) => img && img.isShiny === false && img.imageUrl);
  const shiny = raw.PokemonImage.find((img) => img && img.isShiny === true && img.imageUrl);
  const entry = {
    dex: raw.speciesId,
    pokedex_slug: raw.slug,
    species_slug: raw.speciesSlug,
    name: raw.name || raw.slug,
    types: mapTypes(raw),
    image_normal: normal ? normal.imageUrl : null,
    is_released: raw.isReleased === true,
    shiny_available: raw.isShinyReleased === true && Boolean(shiny),
    is_costume: raw.isCostume === true,
    is_shadow: raw.isShadow === true,
    is_mega: raw.isMega === true,
    is_dynamax: raw.isDynamax === true,
    is_gigantamax: raw.isGigantamax === true,
    regional_form: raw.regionalForm || null,
  };
  if (entry.shiny_available) entry.image_shiny = shiny.imageUrl;
  return entry;
}

function parsePokedexCatalog(html) {
  const rsc = decodeRscPayload(html);
  const pokemon = extractCatalogObjects(rsc)
    .filter((raw) => raw.isReleased === true)
    .map(mapCatalogEntry)
    .filter((entry) => entry.image_normal)
    .sort((a, b) => a.dex - b.dex || a.pokedex_slug.localeCompare(b.pokedex_slug));

  return {
    updated_at: new Date().toISOString(),
    pokemon,
  };
}

async function fetchPokedexCatalog() {
  const url = `${SITE_BASE}/pokemon-go/pokedex`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return parsePokedexCatalog(await res.text());
}

async function writePokedexCatalog(outputFile = OUTPUT_FILE) {
  const catalog = await fetchPokedexCatalog();
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(catalog, null, 2) + '\n');
  return { outputFile, catalog };
}

async function main() {
  console.log(`Fetching live pokedex catalog from ${SITE_BASE}/pokemon-go/pokedex ...`);
  const { outputFile, catalog } = await writePokedexCatalog();
  const speciesCount = new Set(catalog.pokemon.map((p) => `${p.dex}|${p.species_slug}`)).size;
  console.log(`Wrote ${outputFile} (${catalog.pokemon.length} released forms, ${speciesCount} species)`);
}

module.exports = {
  parsePokedexCatalog,
  fetchPokedexCatalog,
  writePokedexCatalog,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Pokedex catalog scrape failed:', err.message);
    process.exit(1);
  });
}
