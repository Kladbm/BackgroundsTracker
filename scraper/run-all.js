// dittotracker scraper — step 3: every background in the index.
//
// Drives the step-2 detail logic (scraper/detail.js) across all 233
// backgrounds from docs/sample-index.json. For each one:
//   - fetches + parses the detail page (reusing detail.js's fetchDetail)
//   - downloads the hero + pokemon normal sprites, skip-existing (reusing
//     detail.js's downloadDetailImages)
//   - writes public/data/backgrounds/{slug}.json (the real data folder per
//     spec section 6)
//
// Finally writes public/data/index.json — the same 233-entry index, now in
// its final location, with a fresh updated_at.
//
// Politeness (spec section 3): 500ms between page requests, 150ms between
// image downloads. All env-overridable: REQUEST_DELAY_MS, IMAGE_DELAY_MS.
//
// Idempotent: cached images are skipped (no request, no delay), detail JSONs
// are overwritten in place — a re-run only fetches what's new.
//
// Progress is logged as "N/233 done" per background. Parse quirks and image
// failures are logged inline and tallied in the summary; they're reported,
// not guessed at — some very old backgrounds have slightly different markup.

const fs = require('fs');
const path = require('path');
const {
  fetchDetail,
  downloadDetailImages,
  delay,
  IMAGES_DIR,
  IMAGE_DELAY_MS,
} = require('./detail');

const INDEX_SOURCE = process.env.INDEX_SOURCE ||
  path.join(__dirname, '..', 'docs', 'sample-index.json');
const DATA_DIR = process.env.DATA_DIR ||
  path.join(__dirname, '..', 'public', 'data');
const PAGE_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);

// Re-run just a subset of backgrounds (comma-separated slugs, no spaces). Used
// to re-process only the 6 duplicate-card backgrounds or only the 69 with hero
// 403s without touching the other ~227 cached detail JSONs. The index.json
// written at the end still contains the FULL list either way.
const ONLY_SLUGS = process.env.ONLY_SLUGS
  ? new Set(process.env.ONLY_SLUGS.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

async function main() {
  const index = JSON.parse(fs.readFileSync(INDEX_SOURCE, 'utf8'));
  const allBackgrounds = index.backgrounds;
  const backgrounds = ONLY_SLUGS
    ? allBackgrounds.filter((b) => ONLY_SLUGS.has(b.slug))
    : allBackgrounds;
  const total = backgrounds.length;

  console.log(`Processing ${total} backgrounds` +
    (ONLY_SLUGS ? ` (ONLY_SLUGS: ${total} of ${allBackgrounds.length})` : ''));
  console.log(`  page delay   : ${PAGE_DELAY_MS}ms  (REQUEST_DELAY_MS)`);
  console.log(`  image delay  : ${IMAGE_DELAY_MS}ms  (IMAGE_DELAY_MS)`);
  console.log(`  detail JSON  -> ${DATA_DIR}/backgrounds/`);
  console.log(`  images       -> ${IMAGES_DIR}`);
  console.log('');

  const results = [];
  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalBytes = 0;

  for (let i = 0; i < total; i++) {
    const bg = backgrounds[i];
    const slug = bg.slug;

    try {
      const data = await fetchDetail(slug);

      const parseProblems = data.problems.length;
      for (const p of data.problems) {
        console.log(`    WARN ${slug}: ${p.slug}: ${p.reason}`);
      }

      const countMismatch = data.pokemon.length !== bg.pokemon_count;
      if (countMismatch) {
        console.log(
          `    WARN ${slug}: pokemon_count mismatch — index says ${bg.pokemon_count}, parsed ${data.pokemon.length}`
        );
      }

      const { downloaded, skipped, failed } = await downloadDetailImages(data);
      totalDownloaded += downloaded.length;
      totalSkipped += skipped.length;
      for (const d of downloaded) totalBytes += d.size;
      for (const f of failed) console.log(`    image fail: ${f}`);

      const outDir = path.join(DATA_DIR, 'backgrounds');
      fs.mkdirSync(outDir, { recursive: true });
      const { heroSrc, ...clean } = data;
      fs.writeFileSync(
        path.join(outDir, `${slug}.json`),
        JSON.stringify({ ...clean, problems: undefined }, null, 2) + '\n'
      );

      results.push({
        slug,
        ok: true,
        pokemon: data.pokemon.length,
        imageFailures: failed.length,
        parseProblems,
        countMismatch,
      });
      console.log(`${i + 1}/${total} done: ${slug} (${data.pokemon.length} pokemon)`);
    } catch (err) {
      results.push({ slug, ok: false, error: err.message });
      console.log(`${i + 1}/${total} FAILED: ${slug} — ${err.message}`);
    }

    await delay(PAGE_DELAY_MS);
  }

  // ---- summary ----
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const withImageFails = ok.filter((r) => r.imageFailures > 0);
  const withParseProblems = ok.filter((r) => r.parseProblems > 0);
  const withCountMismatch = ok.filter((r) => r.countMismatch);

  console.log('');
  console.log('='.repeat(64));
  console.log(`Succeeded:                  ${ok.length}/${total}`);
  console.log(`Failed:                     ${bad.length}/${total}`);
  console.log(`Files downloaded:           ${totalDownloaded}  (${fmtBytes(totalBytes)})`);
  console.log(`Files already cached:       ${totalSkipped}`);
  console.log(`Backgrounds w/ image fails: ${withImageFails.length}`);
  console.log(`Backgrounds w/ parse warns: ${withParseProblems.length}`);
  console.log(`Pokemon-count mismatches:   ${withCountMismatch.length}`);

  if (bad.length) {
    console.log('');
    console.log('FAILURES:');
    for (const r of bad) console.log(`  - ${r.slug}: ${r.error}`);
  }
  if (withImageFails.length) {
    console.log('');
    console.log('IMAGE DOWNLOAD FAILURES (detail JSON still written):');
    for (const r of withImageFails) console.log(`  - ${r.slug}: ${r.imageFailures} file(s)`);
  }
  if (withCountMismatch.length) {
    console.log('');
    console.log('POKEMON-COUNT MISMATCHES (index vs parsed):');
    for (const r of withCountMismatch) console.log(`  - ${r.slug}: ${r.pokemon}`);
  }

  // ---- index -> final location ----
  const outIndex = { updated_at: new Date().toISOString(), backgrounds: allBackgrounds };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(outIndex, null, 2) + '\n');
  console.log(`\nWrote ${DATA_DIR}/index.json (${backgrounds.length} entries)`);
}

main().catch((err) => {
  console.error('Run failed:', err.message);
  process.exit(1);
});
