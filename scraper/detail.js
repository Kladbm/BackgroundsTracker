// dittotracker scraper — step 2: one background detail page.
//
// Fetches a single background detail page and parses it into the
// data/backgrounds/<slug>.json shape (spec section 4): title, release_date,
// description, event {name, date_range, url, image}, and the pokemon list
// (dex, name, pokedex_slug, types, shiny_available, image paths).
//
// Also downloads the background hero image, every pokemon's NORMAL image, and
// every pokemon's SHINY image (where shiny_available) into
// public/images/{backgrounds,pokemon}/, skipping files that already exist
// locally. Shadow-form shiny sprites ({dex}-{slug}-shadow-shiny.png) usually
// 403/404 on the asset CDN — those are logged as failures and skipped; the
// frontend falls back to the normal sprite when a shiny file is missing.
//
// This module doubles as the parsing/downloading core for run-all.js (step 3),
// which drives it across every background in the index. Running this file
// directly still fetches the single page set in DETAIL_URL.
//
// Selectors are structural — anchored on stable attributes (href/src/alt and
// :has on the event link) rather than Chakra's hashed emotion class names
// (css-11z033u & co.), which can change between dittobase deploys.
//
// Card markup (per pokemon):
//   <a href="/pokemon-go/pokedex/{slug}">
//     <div>                                  <- card root
//       <div>                                <- image area
//         [<img alt="Shiny Pokémon" src="/images/shiny.png"/>]  <- shiny marker
//         <div><button>
//           <img src=".../go/pokemon/{dex}-{slug}.png"/>
//           [<img src=".../go/pokemon/{dex}-{slug}-shiny.png"/>]  <- shiny variant
//         </button></div>
//       </div>
//       <div>                                <- text area
//         <div>                              <- name row
//           <p>{name}</p>
//           <div><label>Shiny switch</label></div>
//         </div>
//         <div>                              <- types row (flex-wrap)
//           <img src=".../go/types/{type}.png"/> ...
//         </div>
//       </div>
//     </div>
//   </a>

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const SITE_BASE = process.env.SITE_BASE || 'https://www.dittobase.com';
const ASSET_BASE = 'https://assets.dittobase.com';
const DETAIL_URL = process.env.DETAIL_URL ||
  'https://www.dittobase.com/pokemon-go/backgrounds/sb-gofest2026-global';
const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const OUTPUT_FILE = process.env.OUTPUT_FILE ||
  path.join(__dirname, '..', 'docs', 'sample-detail-gofest2026-global.json');
const IMAGES_DIR = process.env.IMAGES_DIR ||
  path.join(__dirname, '..', 'public', 'images');
// Delay between image downloads. run-all.js uses REQUEST_DELAY_MS for the
// page-to-page delay; images default to 150ms each (REQUEST_DELAY_MS is kept
// as a fallback so `REQUEST_DELAY_MS=500 node scraper/detail.js` still works).
const IMAGE_DELAY_MS = Number(process.env.IMAGE_DELAY_MS || process.env.REQUEST_DELAY_MS || 150);

// Stable structural selectors (see comment at top).
const POKEDEX_CARD_SELECTOR = 'a[href*="/pokemon-go/pokedex/"]';
const EVENT_LINK_SELECTOR = 'a[href*="/pokemon-go/events/"]';
const POKEMON_IMG_SELECTOR = 'img[src*="assets.dittobase.com/go/pokemon/"]';
const TYPE_IMG_SELECTOR = 'img[src*="assets.dittobase.com/go/types/"]';
const SHINY_MARKER_SELECTOR = 'img[src="/images/shiny.png"]';
// The background's hero image on the page — an assets.dittobase.com
// /go/backgrounds/ img, same directory as the homepage cards. Its real src is
// read from the page instead of assumed as {slug}.png (see downloadDetailImages).
const HERO_IMG_SELECTOR = 'img[src*="assets.dittobase.com/go/backgrounds/"]';

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Finds the first "MMM D, YYYY" in a paragraph and returns it as ISO
// "YYYY-MM-DD". Returns null when absent (older backgrounds have no date).
// Unlike the index scraper we search anywhere in the text (the release
// sentence is prose, not a standalone date string).
function findReleaseDate(text) {
  if (!text) return null;
  const m = /([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/.exec(text);
  if (!m || !MONTHS[m[1]]) return null;
  const day = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${MONTHS[m[1]]}-${day}`;
}

// Collapses whitespace (the minified markup can contain stray runs of spaces
// around <!-- --> comment nodes) without touching the punctuation or the
// en-dash in date ranges.
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// dittobase serves some images through Next.js's image optimizer
// (/_next/image?url=<encoded>&w=...&q=75). For downloading we want the
// underlying asset URL, not the proxy. Returns src unchanged when it isn't a
// proxy URL (direct Sanity CDN links with their ?rect=/w=/h= params pass
// through verbatim so the downloaded file matches the reference crop).
function underlyingAssetUrl(src) {
  if (!src) return src;
  const m = /^\/_next\/image\?url=([^&]+)/.exec(src);
  if (!m) return src;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return src;
  }
}

// ---- React Server Components (RSC) payload parsing -------------------------
//
// dittobase is a Next.js App Router site, so the FULL pokemon list — including
// the evolution forms the page hides behind its "Show evolved" toggle — is
// embedded in the initial HTML as RSC flight-payload chunks:
//
//   self.__next_f.push([1,"...escaped json string..."]);
//
// The chunks are JSON-string-escaped fragments of one big payload. That whole
// payload is NOT JSON.parse-able standalone (it uses $D<id> reference markers
// for server components), but its nested plain-JSON arrays ARE valid. We
// brace-match every '"pokemon":[' array, JSON.parse each object, map it to our
// entry shape, merge all arrays, and dedupe by (dex, pokedex_slug).
//
// RSC entry schema (confirmed by probing live pages):
//   {
//     goPokemonSlug,                 // e.g. "treecko"
//     canBeShiny,
//     manuallyEvolved,               // true = evolution form (toggle-hidden)
//     goPokemon: {
//       slug,                        // same as goPokemonSlug
//       speciesId,                   // dex
//       isShadow, isMega, isDynamax, isGigantamax,
//       GoPokemonName: [{ name }],   // base species name
//       GoPokemonManualData: { nameOverride },  // display name (evolutions)
//       PokemonImage: [{ imageUrl, isShiny }],
//       PokemonTypes: [{ slot, type: { slug, TypeNames: [{ name }] } }],
//     },
//   }
//
// Gigantamax forms have manuallyEvolved:false and live in a SEPARATE page
// section, so they appear in their own "pokemon" array. That's why we scan for
// every '"pokemon":[' token instead of taking the first one.
const NEXT_F_CHUNK_RE = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

// Decodes all RSC flight chunks into one concatenated string. Each chunk's
// content is an escaped JSON string literal; unescaping it and appending in
// document order reconstructs the payload.
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

// Brace-matches the array that starts at '"pokemon":[' and JSON.parses each
// top-level object in it, keeping only entries that look like pokemon
// (goPokemonSlug set + numeric speciesId). Returns [] on malformed input; the
// DOM fallback in parsePage is the safety net, so this never throws.
function mapPokemonArray(full, start) {
  const bodyStart = start + '"pokemon":['.length;
  let depth = 1; // count the array's own opening '['
  let j = bodyStart;
  for (; j < full.length && depth > 0; j++) {
    if (full[j] === '[') depth++;
    else if (full[j] === ']') depth--;
  }
  const slice = full.slice(bodyStart, j - 1);
  const entries = [];
  let d = 0, s = -1;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c === '{') { if (d === 0) s = i; d++; }
    else if (c === '}') {
      d--;
      if (d === 0) {
        try {
          const raw = JSON.parse(slice.slice(s, i + 1));
          const g = raw.goPokemon;
          if (raw.goPokemonSlug && g && typeof g.speciesId === 'number') entries.push(raw);
        } catch { /* malformed object — skip */ }
      }
    }
  }
  return entries;
}

// Extracts the pokemon list from the RSC payload. Merges EVERY '"pokemon":[
// array (the main list + the Gigantamax section), maps entries to our JSON
// shape, and dedupes by (dex, pokedex_slug). Returns null when the payload
// yields zero entries — e.g. a non-RSC page — so parsePage can fall back to
// the SSR card markup.
//
// Image paths are read from the payload's PokemonImage[].imageUrl rather than
// reconstructed: shadow forms carry the BASE form's sprite filename (Shadow
// Zapdos -> 145-zapdos.png, not 145-zapdos-shadow.png), and evolutions /
// Gigantamax forms carry their own real files. Reconstructing "{dex}-{slug}.png"
// invents filenames that 403 on the CDN. We fall back to that reconstruction
// only when the payload has no imageUrl for a slot.
function parsePokemonFromRsc(html) {
  const full = decodeRscPayload(html);
  if (!full.includes('"pokemon":[')) return null;

  // Converts an absolute asset URL to our relative images/pokemon/{file} path.
  const rel = (url) => (url ? `images/pokemon/${url.split('/').pop()}` : null);

  const pokemon = [];
  let i = -1;
  while ((i = full.indexOf('"pokemon":[', i + 1)) !== -1) {
    for (const raw of mapPokemonArray(full, i)) {
      const g = raw.goPokemon;
      const name = (g.GoPokemonManualData && g.GoPokemonManualData.nameOverride)
        || (g.GoPokemonName && g.GoPokemonName[0] && g.GoPokemonName[0].name)
        || g.slug;
      const types = (g.PokemonTypes || [])
        .slice()
        .sort((a, b) => (a.slot || 0) - (b.slot || 0))
        .map((t) => t.type && t.type.slug)
        .filter(Boolean);
      const imgs = g.PokemonImage || [];
      const normalUrl = (imgs.find((im) => !im.isShiny) || {}).imageUrl;
      const shinyUrl = (imgs.find((im) => im.isShiny) || {}).imageUrl;
      const constructed = `images/pokemon/${g.speciesId}-${raw.goPokemonSlug}.png`;
      const entry = {
        dex: g.speciesId,
        name,
        pokedex_slug: raw.goPokemonSlug,
        types,
        shiny_available: raw.canBeShiny === true,
        image_normal: rel(normalUrl) || constructed,
      };
      if (entry.shiny_available) {
        entry.image_shiny = rel(shinyUrl) || `images/pokemon/${g.speciesId}-${raw.goPokemonSlug}-shiny.png`;
      }
      pokemon.push(entry);
    }
  }
  if (!pokemon.length) return null;

  // Dedupe by (dex, pokedex_slug), the same key and duplicate situations as
  // the DOM path (featured + full-list overlap). Silently dropped here: a
  // species can legitimately appear in both the main and Gigantamax arrays.
  const seen = new Set();
  const unique = [];
  for (const p of pokemon) {
    const key = `${p.dex}|${p.pokedex_slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

// Parses one detail page into the spec's data/backgrounds/<slug>.json shape.
// The slug is passed in by the caller (run-all.js loops over the index; the
// standalone entry derives it from DETAIL_URL).
function parsePage(html, slug) {
  const $ = cheerio.load(html);
  const problems = [];

  const title = $('h1').first().text().trim();

  // The release sentence is the one <p> containing an event link (the event
  // block's link lives in an <h2>, so this can't collide with it). Its full
  // text is the description; it also embeds the release date.
  //
  // Next.js injects emotion <style> nodes inline, and cheerio's .text()
  // includes their textContent (a browser would hide them), so strip
  // style/script before reading any prose.
  const sentence = $('p:has(' + EVENT_LINK_SELECTOR + ')').first();
  sentence.find('style, script').remove();
  const description = sentence.length ? collapse(sentence.text()) : null;
  const release_date = findReleaseDate(sentence.length ? sentence.text() : '');

  // Event block: h2 > a[href*="/pokemon-go/events/"] (name/url), followed by
  // a <style> and then a <p> with the date range. The block's thumbnail is
  // the <img> whose alt equals the event name (Sanity CDN).
  let event = null;
  const eventHeading = $('h2:has(' + EVENT_LINK_SELECTOR + ')').first();
  if (eventHeading.length) {
    const link = eventHeading.find(EVENT_LINK_SELECTOR).first();
    const name = collapse(link.text());
    const dateP = eventHeading.nextAll('p').first();
    dateP.find('style, script').remove();
    const date_range = collapse(dateP.text());
    const url = new URL(link.attr('href'), SITE_BASE).href;
    const eventImg = $('img').filter((_, el) => $(el).attr('alt') === name).first();
    const rawSrc = eventImg.length ? eventImg.attr('src') : null;
    const imageSrc = rawSrc ? underlyingAssetUrl(rawSrc) : null;
    event = {
      name,
      date_range,
      url,
      // Spec convention: event image is cached locally as {slug}.jpg. The real
      // remote src (Sanity CDN, possibly behind a Next.js /_next/image proxy)
      // is carried in imageSrc for the download pass only and stripped when the
      // JSON is written (run-all.js), exactly like heroSrc — the saved data
      // keeps the local path only.
      image: imageSrc ? `images/events/${slug}.jpg` : null,
      imageSrc,
    };
  }

  // Pokemon list: prefer the RSC flight payload, which carries the FULL list
  // including the evolution forms hidden behind the page's "Show evolved"
  // toggle (see parsePokemonFromRsc). Fall back to the SSR card markup (which
  // only renders the catchable forms) when the payload yields nothing.
  let unique = parsePokemonFromRsc(html);
  if (!unique) {
    const pokemon = [];
    $(POKEDEX_CARD_SELECTOR).each((_, el) => {
      const card = $(el);
      const pokedex_slug = (card.attr('href') || '').split('/').filter(Boolean).pop();

      // Normal sprite: the first go/pokemon img that is NOT the -shiny variant.
      // Its filename is "{dex}-{pokedexSlug}.png" (e.g. 386-deoxys-attack.png).
      const normalImg = card.find(POKEMON_IMG_SELECTOR)
        .filter((_, e) => !($(e).attr('src') || '').includes('-shiny'))
        .first();
      const imgSrc = normalImg.attr('src') || '';
      const imgFile = imgSrc.split('/').pop();
      const m = /^(\d+)-(.+)\.png$/.exec(imgFile);
      if (!m) {
        problems.push({ slug: pokedex_slug, reason: `unparseable pokemon image "${imgSrc}"` });
        return;
      }
      const dex = Number(m[1]);
      const imgSlug = m[2];
      if (imgSlug !== pokedex_slug) {
        problems.push({
          slug: pokedex_slug,
          reason: `image slug "${imgSlug}" != href slug "${pokedex_slug}"`,
        });
      }

      const name = card.find('p').first().text().trim();
      const types = card.find(TYPE_IMG_SELECTOR).map((_, e) => {
        const t = /\/go\/types\/([a-z]+)\.png$/.exec($(e).attr('src') || '');
        return t ? t[1] : null;
      }).get().filter(Boolean);
      const shiny_available = card.find(SHINY_MARKER_SELECTOR).length > 0;

      if (!name) problems.push({ slug: pokedex_slug, reason: 'empty name' });
      if (!types.length) problems.push({ slug: pokedex_slug, reason: 'no types found' });

      const entry = {
        dex,
        name,
        pokedex_slug,
        types,
        shiny_available,
        image_normal: `images/pokemon/${imgFile}`,
      };
      if (shiny_available) {
        entry.image_shiny = `images/pokemon/${dex}-${pokedex_slug}-shiny.png`;
      }
      pokemon.push(entry);
    });

    // Dedupe by (dex, pokedex_slug): dittobase repeats some pokemon across a
    // "featured" section AND the full list (Kyurem Black/White each twice,
    // Blanche Lapras twice, the Regis, ...). Keep the first occurrence and
    // record each dropped duplicate so run-all.js surfaces them in its WARN log.
    const seen = new Set();
    unique = [];
    for (const p of pokemon) {
      const key = `${p.dex}|${p.pokedex_slug}`;
      if (seen.has(key)) {
        problems.push({ slug: key, reason: 'duplicate card dropped (featured + full-list overlap)' });
        continue;
      }
      seen.add(key);
      unique.push(p);
    }
  }

  // Hero image: the /go/backgrounds/ img whose filename equals {slug}.{ext}.
  // The real asset is NOT always {slug}.png — 69 backgrounds live at .webp (and
  // two at .jpg) — so read the src from the page rather than assuming the name.
  // Match by basename rather than "first img in the document": some pages put a
  // related-background strip (other slugs) above the hero, which would make a
  // naive .first() pick the wrong image. Basename matching is order-independent
  // and covers all three extensions; falls back to the first /go/backgrounds/
  // img if no exact match exists (shouldn't happen). Kept out of the JSON: the
  // writers strip heroSrc (the spec has no hero field — the frontend builds
  // images/backgrounds/{slug}.png, which is exactly where downloadDetailImages
  // saves the real asset).
  const heroCandidates = $(HERO_IMG_SELECTOR);
  const heroImg = heroCandidates.filter((_, el) => {
    const base = ($(el).attr('src') || '').split('/').pop().replace(/\.\w+$/, '');
    return base === slug;
  }).first();
  const heroSrc = (heroImg.length ? heroImg : heroCandidates.first()).attr('src') || null;

  return {
    slug,
    type: slug.split('-')[0],
    title,
    release_date,
    description,
    event,
    pokemon: unique,
    heroSrc,
    problems,
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest) {
  if (fs.existsSync(dest)) return { skipped: true };
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return { size: fs.statSync(dest).size };
}

// Fetches + parses one background detail page. Throws on HTTP error so
// run-all.js can distinguish a hard failure (page gone, network) from a parse
// quirk (which shows up in data.problems instead).
async function fetchDetail(slug) {
  const url = `${SITE_BASE}/pokemon-go/backgrounds/${slug}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return parsePage(await res.text(), slug);
}

// Downloads the background hero + every pokemon's normal sprite for one parsed
// detail page, skipping files already on disk. Delays only after an actual
// download — a cached file makes no request, so re-runs are fast. Returns
// { downloaded: [{file, size}], skipped: [file], failed: ["file: error"] };
// a single 404 on one sprite doesn't fail the whole background.
async function downloadDetailImages(data, delayMs = IMAGE_DELAY_MS) {
  const downloaded = [];
  const skipped = [];
  const failed = [];

  const tryOne = async (url, dest, label) => {
    try {
      const r = await download(url, dest);
      if (r.skipped) skipped.push(label);
      else { downloaded.push({ file: label, size: r.size }); await delay(delayMs); }
    } catch (err) {
      failed.push(`${label}: ${err.message}`);
    }
  };

  // Real hero src from the page (parsePage's heroSrc); fall back to the
  // constructed {slug}.png only if the page had no /go/backgrounds/ img at all.
  await tryOne(
    data.heroSrc || `${ASSET_BASE}/go/backgrounds/${data.slug}.png`,
    path.join(IMAGES_DIR, 'backgrounds', `${data.slug}.png`),
    `backgrounds/${data.slug}.png`
  );

  // Event thumbnail -> images/events/{slug}.jpg. imageSrc only exists on
  // freshly-parsed pages; saved JSONs keep just the local path, so an
  // IMAGES_ONLY backfill cannot re-fetch it — a full re-scrape can. When the
  // page had no event image at all (event.image null), nothing to do.
  if (data.event && data.event.image && data.event.imageSrc) {
    const file = data.event.image.split('/').pop();
    await tryOne(
      data.event.imageSrc,
      path.join(IMAGES_DIR, 'events', file),
      `events/${file}`
    );
  }

  for (const p of data.pokemon) {
    const file = p.image_normal.split('/').pop();
    await tryOne(
      `${ASSET_BASE}/go/pokemon/${file}`,
      path.join(IMAGES_DIR, 'pokemon', file),
      `pokemon/${file}`
    );

    // Shiny variant — only where the JSON records one (shiny_available true).
    // The filename ({dex}-{pokedex_slug}-shiny.png) is built identically here
    // and in parsePage, so the downloaded file always matches the path the
    // frontend requests via image_shiny. Shadow-form sprites usually 403/404 on
    // the CDN; tryOne records the failure and keeps going (skip-existing means
    // a re-run won't retry what already landed).
    if (p.image_shiny) {
      const shinyFile = p.image_shiny.split('/').pop();
      await tryOne(
        `${ASSET_BASE}/go/pokemon/${shinyFile}`,
        path.join(IMAGES_DIR, 'pokemon', shinyFile),
        `pokemon/${shinyFile}`
      );
    }
  }

  return { downloaded, skipped, failed };
}

const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

async function main() {
  console.log(`Fetching ${DETAIL_URL} ...`);
  const slug = DETAIL_URL.split('/').filter(Boolean).pop();
  const data = await fetchDetail(slug);

  if (data.problems.length) {
    console.log(`\nWARNING: ${data.problems.length} parse problem(s):`);
    for (const p of data.problems) console.log(`  - ${p.slug}: ${p.reason}`);
  }

  console.log(`\n${data.title} (${data.slug}, type "${data.type}")`);
  console.log(`release_date: ${data.release_date}`);
  console.log(`description: ${data.description}`);
  if (data.event) {
    console.log(`event: ${data.event.name} | ${data.event.date_range}`);
    console.log(`  url:   ${data.event.url}`);
    console.log(`  image: ${data.event.image}`);
  }
  console.log(`pokemon: ${data.pokemon.length}`);

  const print = (label, list) => {
    console.log(`\n${label}:`);
    for (const p of list) console.log(`  ${JSON.stringify(p)}`);
  };
  print('First 3', data.pokemon.slice(0, 3));
  print('Last 3', data.pokemon.slice(-3));

  const { downloaded, skipped, failed } = await downloadDetailImages(data);

  console.log(`\nDownloads -> ${IMAGES_DIR}`);
  console.log(`  downloaded ${downloaded.length} file(s):`);
  for (const d of downloaded) console.log(`    ${d.file}  (${fmtBytes(d.size)})`);
  if (skipped.length) console.log(`  skipped ${skipped.length} already-cached file(s)`);
  if (failed.length) {
    console.log(`  FAILED ${failed.length}:`);
    for (const f of failed) console.log(`    - ${f}`);
  }

  const { heroSrc, ...clean } = data;
  const output = { ...clean, problems: undefined };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nSaved ${data.pokemon.length} pokemon -> ${OUTPUT_FILE}`);
}

module.exports = {
  SITE_BASE,
  ASSET_BASE,
  USER_AGENT,
  IMAGES_DIR,
  IMAGE_DELAY_MS,
  parsePage,
  fetchDetail,
  downloadDetailImages,
  download,
  delay,
  fmtBytes,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });
}
