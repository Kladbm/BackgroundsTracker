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
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 150);

// Stable structural selectors (see comment at top).
const POKEDEX_CARD_SELECTOR = 'a[href*="/pokemon-go/pokedex/"]';
const EVENT_LINK_SELECTOR = 'a[href*="/pokemon-go/events/"]';
const POKEMON_IMG_SELECTOR = 'img[src*="assets.dittobase.com/go/pokemon/"]';
const TYPE_IMG_SELECTOR = 'img[src*="assets.dittobase.com/go/types/"]';
const SHINY_MARKER_SELECTOR = 'img[src="/images/shiny.png"]';

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

function parsePage(html) {
  const $ = cheerio.load(html);
  const problems = [];

  const slug = DETAIL_URL.split('/').filter(Boolean).pop();
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

  return {
    slug,
    type: slug.split('-')[0],
    title,
    release_date,
    description,
    event,
    pokemon,
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

const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

async function main() {
  console.log(`Fetching ${DETAIL_URL} ...`);
  const res = await fetch(DETAIL_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  console.log(`Fetched ${(html.length / 1024).toFixed(0)} KB, parsing ...`);

  const data = parsePage(html);

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

  // Downloads: background hero + every pokemon normal sprite. Files already
  // on disk are skipped. Shiny variants are left for a later step.
  const downloaded = [];
  const skipped = [];
  const failed = [];

  const bgFile = `${data.slug}.png`;
  const bgDest = path.join(IMAGES_DIR, 'backgrounds', bgFile);
  try {
    const r = await download(`${ASSET_BASE}/go/backgrounds/${bgFile}`, bgDest);
    r.skipped ? skipped.push(`backgrounds/${bgFile}`) : downloaded.push({ file: `backgrounds/${bgFile}`, size: r.size });
  } catch (err) {
    failed.push(`backgrounds/${bgFile}: ${err.message}`);
  }
  await delay(REQUEST_DELAY_MS);

  for (const p of data.pokemon) {
    const file = p.image_normal.split('/').pop();
    const dest = path.join(IMAGES_DIR, 'pokemon', file);
    try {
      const r = await download(`${ASSET_BASE}/go/pokemon/${file}`, dest);
      r.skipped ? skipped.push(`pokemon/${file}`) : downloaded.push({ file: `pokemon/${file}`, size: r.size });
    } catch (err) {
      failed.push(`pokemon/${file}: ${err.message}`);
    }
    await delay(REQUEST_DELAY_MS);
  }

  console.log(`\nDownloads -> ${IMAGES_DIR}`);
  console.log(`  downloaded ${downloaded.length} file(s):`);
  for (const d of downloaded) console.log(`    ${d.file}  (${fmtBytes(d.size)})`);
  if (skipped.length) console.log(`  skipped ${skipped.length} already-cached file(s)`);
  if (failed.length) {
    console.log(`  FAILED ${failed.length}:`);
    for (const f of failed) console.log(`    - ${f}`);
  }

  const output = { ...data, problems: undefined };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nSaved ${data.pokemon.length} pokemon -> ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
