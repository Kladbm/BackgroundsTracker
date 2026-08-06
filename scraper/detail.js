// dittotracker scraper — step 2: one background detail page.
//
// Fetches a single background detail page and parses it into the
// data/backgrounds/<slug>.json shape (spec section 4): title, release_date,
// description, event {name, date_range, url, image}, and the pokemon list
// (dex, name, pokedex_slug, types, shiny_available, image paths).
//
// Also downloads the background hero image and every pokemon's NORMAL image
// into public/images/{backgrounds,pokemon}/, skipping files that already
// exist locally. Shiny pokemon images are referenced in the JSON but not
// downloaded yet (that's a later step).
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
    const hasEventImage = $('img').filter((_, el) => $(el).attr('alt') === name).length > 0;
    event = {
      name,
      date_range,
      url,
      // Spec convention: event image is cached locally as {slug}.jpg. Source
      // on the page is the Sanity CDN; the download happens in a later step.
      image: hasEventImage ? `images/events/${slug}.jpg` : null,
    };
  }

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
  // Blanche Lapras twice, the Regis, ...). Keep the first occurrence and record
  // each dropped duplicate so run-all.js surfaces them in its WARN log.
  const seen = new Set();
  const unique = [];
  for (const p of pokemon) {
    const key = `${p.dex}|${p.pokedex_slug}`;
    if (seen.has(key)) {
      problems.push({ slug: key, reason: 'duplicate card dropped (featured + full-list overlap)' });
      continue;
    }
    seen.add(key);
    unique.push(p);
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

  for (const p of data.pokemon) {
    const file = p.image_normal.split('/').pop();
    await tryOne(
      `${ASSET_BASE}/go/pokemon/${file}`,
      path.join(IMAGES_DIR, 'pokemon', file),
      `pokemon/${file}`
    );
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
