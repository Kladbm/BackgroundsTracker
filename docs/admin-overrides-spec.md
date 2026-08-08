# Custom Overrides Layer — Specification (addendum)

**Read `docs/pokemon-backgrounds-tracker-spec.md` first.** This document only
covers the new feature described below; all existing project conventions
apply unchanged: vanilla JS/no framework, no accounts/DB, real verification
(run things for real, show actual output, never invent data), plain
conventional-commit messages with no AI co-author trailer, git checkpoint
per completed task, .gitignore principles (regenerable output never
committed), and matching the existing visual style exactly — **never invent
a new style, layout, or design language; reuse the existing CSS/markup
conventions from `public/css/style.css` and the existing component patterns
in `public/js/grid.js` / `public/js/detail.js`** for any future UI work in
this feature (not relevant to Task 1 below, but binding for later tasks).

## 1. Why this exists

Kyrylo (the project owner) wants to patch, hide, or add pokemon/backgrounds
that the scraped source (dittobase.com) is missing or gets wrong, without
those manual edits being wiped by the daily scraper re-run, and without
creating duplicate entries once dittobase eventually adds the same thing
officially.

This is being built in stages:
- **Task 1 (this task):** the data layer only — the overrides file format,
  the merge logic inside the scraper pipeline, and custom image handling.
  Edited entirely by hand (directly editing JSON + dropping image files in
  a folder) — no UI yet.
- **Later tasks (not in scope now):** a local-only admin HTML page that
  edits `custom/overrides.json` and commits changes via the GitHub API.
  Do not build this yet. Do not scaffold, stub, or hint at it either —
  keep Task 1's deliverable strictly to the data layer.

## 2. File locations (new)

```
custom/
├── overrides.json          # hand-edited, committed to git (source of truth
│                            # for manual patches — NOT gitignored)
└── images/
    ├── backgrounds/{slug}.png              # hero for custom_backgrounds
    ├── pokemon/{dex}-{pokedex_slug}.png     # normal sprite for additions
    └── pokemon/{dex}-{pokedex_slug}-shiny.png  # shiny sprite (optional)
```

`custom/images/` is committed to git (unlike `public/images/`, which stays
gitignored and scraper-regenerated as today). This is necessary because
`public/images/` is wiped and rebuilt from scratch by the scraper on every
run — anything manually placed there would be lost the next day. Files in
`custom/` persist because they live in git.

## 3. `custom/overrides.json` schema

```json
{
  "background_patches": {
    "<slug>": {
      "title": "Optional override string",
      "description": "Optional override string"
    }
  },
  "pokemon_exclusions": {
    "<slug>": ["<pokedex_slug>", "<pokedex_slug>"]
  },
  "pokemon_additions": {
    "<slug>": [
      {
        "dex": 150,
        "name": "Mewtwo",
        "pokedex_slug": "mewtwo",
        "types": ["psychic"],
        "shiny_available": true
      }
    ]
  },
  "custom_backgrounds": [
    {
      "slug": "custom-my-fanmade-bg",
      "type": "custom",
      "title": "My Fanmade Background",
      "release_date": "2026-08-08",
      "description": "Free text.",
      "event": null,
      "pokemon": [
        {
          "dex": 1,
          "name": "Bulbasaur",
          "pokedex_slug": "bulbasaur",
          "types": ["grass", "poison"],
          "shiny_available": true
        }
      ]
    }
  ]
}
```

Notes:
- All four top-level keys are optional; an empty or partially-empty file
  (`{}`) must be handled gracefully (treated as no overrides at all), and
  the file may not exist at all on a fresh checkout — that must not crash
  the pipeline either.
- `pokedex_slug` is the same field already used throughout the project
  (see the existing spec, section 4) — it is the dedupe/exclusion key
  because it's already unique per form (handles `-shadow`, `-origin`,
  etc.), unlike bare `dex`.
- `pokemon_additions` and `custom_backgrounds[].pokemon[]` entries use the
  same shape as the existing `pokemon` array entries in
  `public/data/backgrounds/<slug>.json` (dex, name, pokedex_slug, types,
  shiny_available) — reuse the existing type, don't invent a new one.
  `image_normal` / `image_shiny` are NOT stored in overrides.json — they
  are derived at build time from `custom/images/pokemon/` the same way the
  official pipeline derives image paths, so overrides.json never hardcodes
  a `public/images/...` path.
- `custom_backgrounds[].slug` must not collide with any official dittobase
  slug — validate this at merge time and fail loudly (log an error and
  exit non-zero) if it does, rather than silently overwriting an official
  background.

## 4. Merge logic (runs inside the existing scraper pipeline)

Extend `scraper/run-all.js` (or a new small module it calls, e.g.
`scraper/overrides.js` — your call on the cleanest structure) to run this
merge step **after** the existing official scrape + parse, and **before**
`public/data/index.json` / `public/data/backgrounds/*.json` are written to
disk:

1. Load `custom/overrides.json`. Missing file or JSON parse error →
   log a warning and proceed as if it were `{}` (don't crash the whole
   scrape over a malformed overrides file — the official data must still
   deploy).
2. For each official background already parsed in this run:
   a. **Patches**: if `background_patches[slug]` exists, override
      `title`/`description` on that background's in-memory object with
      whichever of those two fields are present in the patch.
   b. **Exclusions**: if `pokemon_exclusions[slug]` exists, filter that
      background's `pokemon` array, removing any entry whose
      `pokedex_slug` is in the exclusion list.
   c. **Additions**: if `pokemon_additions[slug]` exists, for each
      addition entry: only append it if no entry with the same
      `pokedex_slug` already exists in that background's (post-exclusion)
      `pokemon` array. This is the core anti-duplicate rule — if
      dittobase has since added the same pokemon officially, the manual
      addition is silently skipped (never appended twice, never
      conflicts). Log a one-line note when a skip happens (e.g.
      `"skipped addition <slug>/<pokedex_slug>: already present
      officially"`) so it's visible in the run log, not silent.
3. For each entry in `custom_backgrounds`: build a background object with
   the same shape as the official pipeline produces (see existing spec
   section 4's JSON shape), add a `"custom": true` field (official
   backgrounds implicitly have `"custom": false` or the field omitted —
   your call, just be consistent), and add it to both the in-memory index
   list and the set of per-background JSON files to write. Validate the
   slug doesn't collide with an official one (point 3 in section 3 above)
   before adding.
4. Recompute `pokemon_count`/`pokemon.length`-derived numbers as normal —
   no special-casing needed here since the existing counters already
   derive from `pokemon.length` at read time on the frontend (per the
   existing spec's step 9 discussion of the catchable-vs-evolvable
   count gap) — just make sure the merged `pokemon` array is what actually
   gets written to the JSON file.

## 5. Image handling

Extend the existing image-download step so that, for every background
being written (official + patched + custom), any pokemon or hero image
that isn't already present in `public/images/` (from the normal official
download) gets copied from `custom/images/` into the matching
`public/images/...` path, using the exact same target filename convention
the official pipeline already uses (see existing spec section 4: hero at
`images/backgrounds/{slug}.png`, pokemon at
`images/pokemon/{dex}-{pokedex_slug}.png` /
`images/pokemon/{dex}-{pokedex_slug}-shiny.png`).

Rules:
- Official scraped images always take precedence — never overwrite an
  already-downloaded official image with a custom one of the same
  filename. If a custom image would collide with an official filename,
  log a warning and skip the copy (keep the official one).
- If a referenced custom image file (e.g. a `custom_backgrounds` hero, or
  a `pokemon_additions` sprite) is missing from `custom/images/` when
  needed, log a clear warning identifying which slug/dex is affected and
  continue the run — don't crash the whole scrape over one missing image
  file. The frontend already handles a missing/broken image gracefully
  (existing `onerror` fallback patterns in `detail.js`), so a missing
  custom image degrades visually rather than breaking the page.

## 6. Verification plan for this task (no UI yet — hand-edit and check)

Kyrylo will manually test all four mechanisms after this is built, by
hand-editing `custom/overrides.json` and dropping test image files into
`custom/images/`, then running the scraper and inspecting the actual
output JSON/images — real verification, not assumed. Whoever implements
this must run through the same steps themselves before calling it done:

1. **Patch test**: add a `background_patches` entry for a real existing
   slug (e.g. override its `description`), run
   `node scraper/run-all.js`, confirm the written
   `public/data/backgrounds/<slug>.json` has the overridden description
   and NOT the original scraped one.
2. **Exclusion test**: add a `pokemon_exclusions` entry removing a real
   pokemon from a real background, re-run, confirm that pokemon is absent
   from the written JSON's `pokemon` array and the array length dropped
   by exactly one.
3. **Addition test, no conflict**: add a `pokemon_additions` entry for a
   pokemon that is genuinely not on that background's real page, with a
   test image dropped in `custom/images/pokemon/`, re-run, confirm it
   appears in the output JSON and its image was copied into
   `public/images/pokemon/`.
4. **Addition test, WITH conflict**: add a `pokemon_additions` entry for a
   pokemon that IS already legitimately on that background's real page
   (same `pokedex_slug`), re-run, confirm it does NOT get duplicated —
   the pokemon appears exactly once in the output, and the run log shows
   the "skipped addition... already present officially" line from
   section 4.2.c.
5. **Custom background test**: add a full `custom_backgrounds` entry with
   its own hero image and at least one pokemon (with its own test image),
   re-run, confirm a new `public/data/backgrounds/<new-slug>.json` was
   written, it appears in `public/data/index.json`, and both images landed
   correctly in `public/images/`.
6. **Missing-file resilience test**: reference a custom image that does
   NOT exist in `custom/images/`, re-run, confirm the scrape completes
   successfully (233/233 official backgrounds still succeed) with only a
   logged warning for the missing file — not a crash.
7. **Empty/absent overrides.json test**: temporarily rename or empty the
   overrides file, re-run, confirm the scrape behaves exactly as it did
   before this feature existed (no errors, no missing data).

Report the actual results of all seven checks (real command output, real
file contents inspected) before considering Task 1 done. Commit as its own
checkpoint once verified.
