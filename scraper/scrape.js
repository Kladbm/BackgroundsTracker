// dittotracker scraper — step 1: index page only.
//
// Fetches https://www.dittobase.com/pokemon-go/backgrounds (the whole list is
// in one server-rendered response, no pagination) and parses every background
// card into { slug, type, title, release_date, pokemon_count }.
//
// Output: prints the first 5 and last 5 entries to the console and writes the
// full list to docs/sample-index.json (shape matches the spec's data/index.json).
//
// Selectors are structural (anchored on stable attributes like href/src/alt and
// the tooltip's data-part attribute) rather than Chakra's hashed emotion class
// names (css-1xticbh & co.), which can change between dittobase deploys.

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://www.dittobase.com/pokemon-go/backgrounds';
const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const OUTPUT_FILE = process.env.OUTPUT_FILE ||
  path.join(__dirname, '..', 'docs', 'sample-index.json');

// Card markup (per card): an <a> wrapping a Chakra card root div
//   <a href="/pokemon-go/backgrounds/{slug}">
//     <div>
//       <img alt="{title}" src="https://assets.dittobase.com/go/backgrounds/{slug}.png">
//       <div>                                  <- body
//         <p>{title}</p>                       <- title
//         <div>                                <- meta row
//           <p>{date}</p>                      <- optional; absent on older cards
//           <div data-part="trigger">          <- tooltip trigger
//             <p>{pokemon_count}</p>
//             <img src="/images/pokeball-hollow.svg">
const CARD_SELECTOR = 'a[href*="/pokemon-go/backgrounds/"]';
const IMG_SELECTOR = 'img[src*="assets.dittobase.com/go/backgrounds/"]';
const TRIGGER_SELECTOR = 'div[data-part="trigger"]';

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Converts "Aug 28, 2026" -> "2026-08-28". Returns null for empty input.
// Throws for present-but-unparseable text so we never silently invent data.
function parseReleaseDate(text) {
  if (!text) return null;
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(text.trim());
  if (!m || !MONTHS[m[1]]) {
    throw new Error(`Unparseable release date: "${text}"`);
  }
  const day = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${MONTHS[m[1]]}-${day}`;
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const backgrounds = [];
  const problems = [];

  $(CARD_SELECTOR).each((_, el) => {
    const card = $(el);
    const slug = (card.attr('href') || '').split('/').filter(Boolean).pop();

    const title =
      card.find(IMG_SELECTOR).first().attr('alt') ||
      card.find('p').first().text().trim();

    // The date <p> is the first direct <p> child of the trigger's parent (the
    // meta row). Older cards have no date <p> there at all -> null.
    const trigger = card.find(TRIGGER_SELECTOR).first();
    const dateText = trigger.length
      ? trigger.parent().children('p').first().text().trim()
      : '';
    const countText = trigger.length
      ? trigger.find('p').first().text().trim()
      : '';

    let release_date = null;
    try {
      release_date = parseReleaseDate(dateText);
    } catch (err) {
      problems.push({ slug, reason: err.message });
    }

    backgrounds.push({
      slug,
      type: slug.split('-')[0],
      title,
      release_date,
      pokemon_count: countText ? parseInt(countText, 10) : 0,
    });
  });

  return { backgrounds, problems };
}

async function fetchIndex(baseUrl = BASE_URL) {
  const res = await fetch(baseUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  return parseCards(html);
}

async function main() {
  console.log(`Fetching ${BASE_URL} ...`);
  const { backgrounds, problems } = await fetchIndex(BASE_URL);

  console.log(`Parsed ${backgrounds.length} background cards.`);

  if (problems.length) {
    console.log(`WARNING: ${problems.length} card(s) had unparseable dates:`);
    for (const p of problems) console.log(`  - ${p.slug}: ${p.reason}`);
  }

  const print = (label, list) => {
    console.log(`\n${label}:`);
    for (const b of list) {
      console.log(`  ${JSON.stringify(b)}`);
    }
  };
  print('First 5', backgrounds.slice(0, 5));
  print('Last 5', backgrounds.slice(-5));

  const output = {
    updated_at: new Date().toISOString(),
    backgrounds,
  };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nSaved ${backgrounds.length} entries -> ${OUTPUT_FILE}`);
}

module.exports = {
  BASE_URL,
  USER_AGENT,
  OUTPUT_FILE,
  parseReleaseDate,
  parseCards,
  fetchIndex,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });
}
