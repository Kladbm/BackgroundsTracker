# Local Admin UI — Specification (addendum, Task 2)

**Read `docs/pokemon-backgrounds-tracker-spec.md` and
`docs/admin-overrides-spec.md` first.** This document only covers the
admin UI. All existing project conventions apply unchanged, including the
binding style rule: **reuse the existing visual language from
`public/css/style.css` and the existing component patterns in
`public/js/grid.js` / `public/js/detail.js` (card layout, colors, fonts,
dropdown/toggle styling) — do not invent a new design. This tool should
look like it belongs to the same project**, even though it's never
deployed publicly.

## 1. What this is

A **local-only** admin tool for editing `custom/overrides.json` and
`custom/images/` (the data layer built in Task 1) through a visual
interface instead of hand-editing JSON. It is opened locally (same way
the main site is tested locally — a static server on the repo), never
deployed to GitHub Pages, and never linked from the public site.

**File location:** `admin/index.html`, `admin/css/style.css`,
`admin/js/*.js` — a **new top-level folder**, sibling to `public/`, NOT
inside it. This matters: the existing GitHub Actions workflow only
uploads `public/` as the Pages artifact (`upload-pages-artifact` with
`path: public`), so anything in `admin/` is automatically never published
— verify this is still true before building, don't just assume.

## 2. How publishing works (no separate backend)

There is no server for this tool. Publishing changes means committing
directly to the GitHub repo via the **GitHub REST API**, called from
client-side JS using `fetch()`:

- `GET /repos/{owner}/{repo}/contents/{path}` — read a file's current
  content + `sha` (needed to update it)
- `PUT /repos/{owner}/{repo}/contents/{path}` — create or update a file
  (base64-encoded content, commit message, and `sha` if updating an
  existing file)

Repo: `Kladbm/BackgroundsTracker`, branch `main`.

**Auth:** a GitHub Personal Access Token (classic, `repo` scope — the
same kind already used earlier for the VPS git clone), entered once by
the user into a password-style input, stored in this admin page's own
`localStorage` (never sent anywhere except GitHub's API, never committed
to any file, never logged to console). Provide a visible "Forget token"
button that clears it.

**Commit granularity:** keep this simple — each file changed on
"Publish" (the updated `custom/overrides.json`, plus any new/changed
image files) is its own Contents-API call, meaning potentially several
small commits per publish action rather than one atomic commit. This is
an accepted simplicity trade-off for a low-frequency personal tool — note
it in the UI (e.g. "Publishing may create multiple commits") but don't
build the more complex Git Data API (blobs/tree/commit) atomic-commit
flow unless asked later.

**After publish:** committing to `main` already triggers the existing
`scrape-and-deploy.yml` workflow automatically (it has `on: push:
branches: main`) — no extra step needed here. Tell the user in the UI
that the live site will update in a few minutes and link to the repo's
Actions tab.

## 3. Data sources for the UI (read side)

- **Current live merged data** (what's actually on the deployed site
  right now, official + already-published overrides applied): fetch from
  the live GitHub Pages URLs,
  `https://kladbm.github.io/BackgroundsTracker/data/index.json` and
  `https://kladbm.github.io/BackgroundsTracker/data/backgrounds/{slug}.json`.
  This is what the browsing/grid view of the admin tool displays.
- **Current overrides source of truth** (what manual edits already
  exist, not yet necessarily reflected if a publish hasn't run/deployed
  yet): fetch `custom/overrides.json`'s raw content directly from GitHub
  via `https://raw.githubusercontent.com/Kladbm/BackgroundsTracker/main/custom/overrides.json`
  (public repo, no auth needed for reading). This is what the UI reads to
  pre-fill "already patched" / "already excluded" state and to know what
  to merge new edits into before publishing.
- **Pokemon metadata autofill**: PokeAPI, `https://pokeapi.co/api/v2/pokemon/{id_or_name}`
  (free, no key). Use it to autofill `name`, `types`, and confirm a valid
  `pokedex_slug` when the user types a dex number — but see section 5 on
  where the actual sprite image should come from (not PokeAPI).

## 4. Screens / features (build in this order, one checkpoint each)

### Step A — Browse (read-only)
- Grid of all backgrounds, reusing the existing site's card visual style,
  fetched from the live site's `data/index.json`.
- Click a background → detail view showing its title, description, hero
  image, and pokemon list (fetched from its live `data/backgrounds/
  {slug}.json`) — reuse the existing detail-page visual style.
- No editing yet in this step — just confirm the data loads and renders
  correctly, matching what's live.

### Step B — Edit existing background (staged locally, not yet published)
- On a background's detail view: editable `title`/`description` fields
  (prefilled with current values; if `custom/overrides.json` already has
  a `background_patches` entry for this slug, prefill with the override
  instead and indicate it's already-patched).
- Per-pokemon "remove" button (adds to `pokemon_exclusions` for this
  slug) and, for already-excluded pokemon (compare against
  `pokemon_exclusions` in the loaded overrides file), a "restore" button
  instead.
- Changes are staged in memory/local state only at this point — do not
  call the GitHub API yet from this step. A visible "pending changes"
  indicator (e.g. a badge or list) should show what's staged.

### Step C — Add pokemon / add custom background
- "Add pokemon" on an existing background: user enters a dex number.
  On blur/enter, autofill name + types from PokeAPI, including all
  species varieties/forms when the dex number has more than one. After
  the user chooses a form, **try fetching the sprite from
  `https://assets.dittobase.com/go/pokemon/{dex}-{pokedex_slug}.png`
  first** (same host/pattern the main scraper already uses) — dittobase
  hosts most real pokemon already, even ones not on this specific
  background. Show a live preview only when the normal Dittobase sprite
  exists; if that fetch fails, show that the pokemon is unavailable and
  do not allow it to be staged. Same for the shiny variant (try
  `{dex}-{pokedex_slug}-shiny.png` from the same host; optional field,
  can be left unset when it 404s).
- "Add new custom background": form for title, release date,
  description, hero image (try nothing automatic here — always manual
  upload, since it's a background dittobase doesn't have by definition),
  plus a pokemon list built using the same "add pokemon" flow above.
- All of this stages into the in-memory pending-changes state from
  Step B, same as edits/exclusions — still no API calls yet.

### Step D — Publish
- A summary view of everything staged this session (patches, exclusions,
  additions, new custom backgrounds, images to upload) before committing
  anything, so the user can review before publishing.
- "Publish" button: prompts for the GitHub token if not already stored,
  then:
  1. Fetches the current `custom/overrides.json` + its `sha` from the
     repo (in case it changed since this session started — avoid
     clobbering concurrent edits).
  2. Merges the staged changes into it in memory, using the same merge
     shape/rules as `docs/admin-overrides-spec.md` section 3 (don't
     invent a different JSON shape).
  3. PUTs the updated `custom/overrides.json`.
  4. PUTs any new/changed image files under `custom/images/...` (base64
     encode file content for the API).
  5. Shows success/failure per file, and on full success, clears the
     staged-changes state and links to the repo's Actions tab.
- Handle API errors gracefully (bad token, network failure, 409 sha
  conflict) with a clear message — don't silently fail.

## 5. Important clarifications

- PokeAPI is for **metadata only** (name, types, confirming the
  official Pokédex slug spelling) — never use its sprite images as the
  final image; they don't match dittobase's art style. Always prefer the
  `assets.dittobase.com` sprite (section 4, Step C) when it exists.
- This tool assumes exactly one user (Kyrylo) editing at a time — no
  need for multi-user conflict handling beyond the basic sha-mismatch
  check in Step D.
- No build step, same as the main site — plain HTML/CSS/JS, no framework,
  opened via a local static server exactly like `public/` already is.

## 6. Verification expectations

Same discipline as everywhere else in this project: run it for real
against a local server, actually click through each step, actually call
the real GitHub API with a real (test) token when verifying Step D
(revert the test commit afterward if it was just a smoke test), and
report real results — don't assume the GitHub API calls work without
having actually made one successfully.
