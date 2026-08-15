const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'public', 'data');
const CATALOG_FILE = process.env.POKEDEX_CATALOG_FILE || path.join(DATA_DIR, 'pokedex-catalog.json');
const OUTPUT_FILE = process.env.EVOLUTION_FAMILIES_OUTPUT || path.join(DATA_DIR, 'evolution-families.json');
const POKEAPI_BASE = process.env.POKEAPI_BASE || 'https://pokeapi.co/api/v2';
const POKEAPI_DELAY_MS = Number(process.env.POKEAPI_DELAY_MS || 25);
const USER_AGENT = process.env.USER_AGENT || 'dittotracker-evolution-family-generator';

const SPECIES_NORMALIZATIONS = {
  'corsola-galarian': 'corsola',
  'ponyta-galarian': 'ponyta',
  'zigzagoon-galarian': 'zigzagoon',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function normalizeSpeciesSlug(slug) {
  return SPECIES_NORMALIZATIONS[slug] || slug;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchPokeApi(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${POKEAPI_BASE}${pathOrUrl}`;
  const data = await fetchJson(url);
  if (POKEAPI_DELAY_MS > 0) await delay(POKEAPI_DELAY_MS);
  return data;
}

function flattenEvolutionChain(node, depth = 0, out = []) {
  out.push({ species_slug: node.species.name, stage: depth, family_order: out.length });
  for (const child of node.evolves_to || []) flattenEvolutionChain(child, depth + 1, out);
  return out;
}

function formRank(entry) {
  const speciesSlug = normalizeSpeciesSlug(entry.species_slug || entry.pokedex_slug || '');
  const isPlain =
    entry.pokedex_slug === entry.species_slug &&
    entry.is_costume !== true &&
    entry.is_shadow !== true &&
    entry.is_mega !== true &&
    entry.is_dynamax !== true &&
    entry.is_gigantamax !== true &&
    !entry.regional_form;
  if (isPlain) return 0;
  if (entry.pokedex_slug === speciesSlug && entry.is_costume !== true && entry.is_shadow !== true) return 0;
  return 1;
}

async function buildEvolutionFamilies(catalogFile = CATALOG_FILE) {
  const catalog = readJson(catalogFile);
  const pokemon = Array.isArray(catalog.pokemon) ? catalog.pokemon : [];
  const speciesSlugs = [...new Set(pokemon
    .map((entry) => normalizeSpeciesSlug(entry.species_slug || entry.pokedex_slug))
    .filter(Boolean))]
    .sort();

  const speciesBySlug = new Map();
  for (let i = 0; i < speciesSlugs.length; i++) {
    const slug = speciesSlugs[i];
    const species = await fetchPokeApi(`/pokemon-species/${slug}/`);
    speciesBySlug.set(slug, species);
    if ((i + 1) % 100 === 0) console.log(`Fetched ${i + 1}/${speciesSlugs.length} species from PokeAPI`);
  }

  const chainUrls = [...new Set([...speciesBySlug.values()].map((species) => species.evolution_chain && species.evolution_chain.url).filter(Boolean))];
  const chainsByUrl = new Map();
  for (let i = 0; i < chainUrls.length; i++) {
    const url = chainUrls[i];
    const chain = await fetchPokeApi(url);
    chainsByUrl.set(url, chain);
    if ((i + 1) % 100 === 0) console.log(`Fetched ${i + 1}/${chainUrls.length} evolution chains from PokeAPI`);
  }

  const speciesFamilies = {};
  const familiesById = new Map();
  for (const [slug, species] of speciesBySlug) {
    const chain = chainsByUrl.get(species.evolution_chain.url);
    if (!chain || !chain.chain) continue;
    const members = flattenEvolutionChain(chain.chain);
    const base = members[0];
    const baseSpecies = speciesBySlug.get(base.species_slug) || await fetchPokeApi(`/pokemon-species/${base.species_slug}/`);
    const familyId = base.species_slug;
    const family = familiesById.get(familyId) || {
      family_id: familyId,
      base_species_slug: base.species_slug,
      base_dex: baseSpecies.id,
      members: [],
    };
    const known = new Set(family.members.map((member) => member.species_slug));
    for (const member of members) {
      if (!known.has(member.species_slug)) {
        const memberSpecies = speciesBySlug.get(member.species_slug);
        family.members.push({
          species_slug: member.species_slug,
          dex: memberSpecies ? memberSpecies.id : null,
          stage: member.stage,
          family_order: member.family_order,
        });
        known.add(member.species_slug);
      }
    }
    familiesById.set(familyId, family);
    const member = members.find((item) => item.species_slug === slug) || base;
    speciesFamilies[slug] = {
      family_id: familyId,
      base_species_slug: base.species_slug,
      base_dex: baseSpecies.id,
      stage: member.stage,
      family_order: member.family_order,
    };
  }

  const forms = {};
  for (const entry of pokemon) {
    const speciesSlug = normalizeSpeciesSlug(entry.species_slug || entry.pokedex_slug);
    const family = speciesFamilies[speciesSlug] || {
      family_id: speciesSlug,
      base_species_slug: speciesSlug,
      base_dex: entry.dex,
      stage: 0,
      family_order: 0,
    };
    forms[entry.pokedex_slug] = {
      family_id: family.family_id,
      base_species_slug: family.base_species_slug,
      base_dex: family.base_dex,
      species_slug: speciesSlug,
      dex: entry.dex,
      stage: family.stage,
      family_order: family.family_order,
      form_rank: formRank(entry),
      is_costume_like: entry.is_costume === true || entry.is_shadow === true,
    };
  }

  const families = [...familiesById.values()]
    .map((family) => ({
      ...family,
      members: family.members.sort((a, b) => a.family_order - b.family_order || (a.dex || 0) - (b.dex || 0)),
    }))
    .sort((a, b) => a.base_dex - b.base_dex || a.family_id.localeCompare(b.family_id));

  return {
    updated_at: new Date().toISOString(),
    source: 'https://pokeapi.co/api/v2',
    normalizations: SPECIES_NORMALIZATIONS,
    families,
    species: speciesFamilies,
    forms,
  };
}

async function writeEvolutionFamilies(outputFile = OUTPUT_FILE) {
  const data = await buildEvolutionFamilies();
  writeJson(outputFile, data);
  return { outputFile, data };
}

async function main() {
  console.log('Building evolution family catalog from PokeAPI ...');
  const { outputFile, data } = await writeEvolutionFamilies();
  console.log(`Wrote ${outputFile} (${data.families.length} families, ${Object.keys(data.species).length} species, ${Object.keys(data.forms).length} forms)`);
}

module.exports = {
  buildEvolutionFamilies,
  writeEvolutionFamilies,
  normalizeSpeciesSlug,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Evolution family generation failed:', err.message);
    process.exit(1);
  });
}
