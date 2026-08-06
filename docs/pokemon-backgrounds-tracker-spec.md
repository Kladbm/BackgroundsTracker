# Pokémon GO Backgrounds Tracker — Specification

## 1. Idea

A personal site for you and your friends: a visual copy of dittobase.com/pokemon-go/backgrounds (grid of backgrounds + detail page with pokemon), but with the ability to mark pokemon as "collected" per background. Each person's progress is their own, no accounts — stored in browser localStorage.

Data (backgrounds, pokemon, images) syncs with dittobase once a day via a cron scraper.

## 2. Key decisions (and why)

| Question | Decision | Why |
|---|---|---|
| Accounts | None. localStorage per browser | You asked for this — zero backend logic for users |
| Database | None, flat JSON | Data is read-only from the frontend's perspective (only the scraper writes it, once a day), so no DB is needed |
| Frontend stack | Vanilla HTML/CSS/JS, no framework | No accounts and no DB → Next.js/Prisma would be overkill. Saves Claude Code tokens and loads faster |
| Images | Cached on the VPS, hotlink as fallback | Site doesn't depend on dittobase's uptime/hotlink protection, loads fast from your own server. *(This is my default choice — if you want pure hotlinking instead, say so and we'll simplify further)* |

## 3. Architecture

Three independent pieces, no build step:

```
┌─────────────┐   once a day    ┌──────────────┐
│  scraper.js │ ───────────────▶│ data/*.json  │
│  (Node,     │                 │ images/*     │
│   cron)     │                 └──────┬───────┘
└─────────────┘                        │
                                        ▼
                              ┌──────────────────┐
                              │ nginx (static)    │
                              │ index.html        │
                              │ background.html   │
                              │ app.js (grid,     │
                              │  localStorage)     │
                              └──────────────────┘
```

- **scraper.js** — a Node script, run via cron once a day. The site is fully server-rendered (verified — the full list of 233 backgrounds and all pokemon on detail pages are already in the raw HTML, no pagination, no JS rendering needed), so plain `fetch` + `cheerio` is enough — no headless browser required. Fetches dittobase.com/pokemon-go/backgrounds (one request — the entire list), then the detail page for each background. The background image doesn't need to be scraped separately — its URL is predictable from the slug (see section 4). Downloads images (skips ones already cached, keyed by filename from the URL), writes JSON. Idempotent: re-running just updates what changed. Delay between requests (e.g. 1 req/sec) — being respectful of someone else's server, since this is a private, non-commercial tracker for a friend group.
- **data/** — static JSON files, the "database".
- **public/** — static HTML/CSS/JS + cached images, served by nginx.
- **app.js** — renders the grid/detail page from JSON, reads/writes localStorage on pokemon click.

## 4. Data model

Real slugs (verified by fetch) look like `lc-wcs-2026-san-francisco` (location card) or `sb-gofest2026-global` (special background) — the prefix is worth storing as a separate `type` field, useful for the "All" filter on the homepage (as seen in the screenshot).

The background image is not scraped separately — its URL is built from the slug: `https://assets.dittobase.com/go/backgrounds/{slug}.png`. Pokemon image: `https://assets.dittobase.com/go/pokemon/{dex}-{pokedex-slug}.png`, where `pokedex-slug` comes from the `/pokemon-go/pokedex/{slug}` link on the detail page (handles forms like `deoxys-attack`, `giratina-origin`). Shiny availability — determined by the presence of a neighboring `shiny.png` icon in the markup next to that specific pokemon (not all have it, e.g. Yveltal has none in GO Fest 2026 Global).

`data/index.json` — list for the homepage:

```json
{
  "updated_at": "2026-08-05T03:00:00Z",
  "backgrounds": [
    {
      "slug": "lc-wcs-2026-san-francisco",
      "type": "lc",
      "title": "WCS 2026 San Francisco",
      "release_date": "2026-08-28",
      "pokemon_count": 0
    },
    {
      "slug": "sb-gofest2026-global",
      "type": "sb",
      "title": "GO Fest 2026 Global",
      "release_date": "2026-07-11",
      "pokemon_count": 91
    }
  ]
}
```

`data/backgrounds/<slug>.json` — detail page:

```json
{
  "slug": "sb-gofest2026-global",
  "type": "sb",
  "title": "GO Fest 2026 Global",
  "release_date": "2026-07-11",
  "description": "...",
  "event": {
    "name": "Pokémon GO Fest 2026: Global",
    "date_range": "Jul 11 – Jul 12, 2026",
    "url": "https://www.dittobase.com/pokemon-go/events/pokemon-go-fest-2026-global",
    "image": "images/events/sb-gofest2026-global.jpg"
  },
  "pokemon": [
    {
      "dex": 144,
      "name": "Articuno",
      "pokedex_slug": "articuno",
      "types": ["ice", "flying"],
      "shiny_available": true,
      "image_normal": "images/pokemon/144-articuno.png",
      "image_shiny": "images/pokemon/144-articuno-shiny.png"
    }
  ]
}
```

## 5. localStorage (client)

One key `collected`, JSON:

```json
{
  "sb-gofest2026-global": {
    "144": { "normal": true, "shiny": false }
  }
}
```

On the homepage, each background card shows `X/pokemon_count collected`, computed on the fly from this object + `pokemon_count` from index.json.

Export/import progress (a "copy JSON" / "paste JSON" button) should be added right away, since without accounts it's the only way not to lose progress when switching browsers/reinstalling.

## 6. Repo structure

```
dittotracker/
├── scraper/
│   ├── scrape.js
│   ├── package.json
│   └── .env            # BASE_URL, USER_AGENT, REQUEST_DELAY_MS
├── public/
│   ├── index.html
│   ├── background.html
│   ├── css/style.css
│   ├── js/
│   │   ├── grid.js
│   │   ├── detail.js
│   │   └── storage.js  # shared localStorage module
│   ├── data/
│   │   ├── index.json
│   │   └── backgrounds/<slug>.json
│   └── images/
│       ├── backgrounds/
│       ├── events/
│       └── pokemon/
├── docker-compose.yml   # nginx + cron container running the scraper
└── nginx.conf
```

## 7. VPS deployment

Since you already run Docker on your VPS (same pattern as the Valheim server), do it the same way here:

- `nginx:alpine` container — serves `public/` as-is (static files + images), gzip on.
- A separate lightweight container (or just cron on the host) with Node — once a day (`0 3 * * *`) runs `scraper/scrape.js`, writing straight into a volume mounted into the nginx container as `public/data` and `public/images`.
- No DB, no migrations, no secret `.env` — not needed (no accounts, no API keys).
- SSL — Caddy or nginx + certbot, if you want HTTPS on a subdomain.
- Scraper logs — just to a file, rotated the same way as the Valheim server.

## 8. Data volume estimate

- 233 backgrounds × ~1 hero image (~200–500 KB) ≈ 50–120 MB.
- Pokemon icons are reused across backgrounds (the same Articuno can appear on several backgrounds) → cached once per dex+shiny, not duplicated. Another +20–50 MB.
- Total: at most a couple hundred MB on the VPS disk. Not a problem.

## 9. Development plan via Claude Code (staged, with checkpoints)

To avoid burning tokens on a first attempt at "build everything at once":

1. **Scraper, step 1**: a single `fetch` of the homepage + `cheerio` parsing of all 233 cards (title/slug/date/count) → console output, verify by hand. No pagination, the whole list is in one response. Git checkpoint.
2. **Scraper, step 2**: detail page for one background (e.g. `sb-gofest2026-global`) → JSON + image download via predictable URLs (`assets.dittobase.com/go/backgrounds/{slug}.png`, `assets.dittobase.com/go/pokemon/{dex}-{pokedex-slug}.png`) + shiny detection via the neighboring icon. Verify by hand. Checkpoint.
3. **Scraper, step 3**: run against all 233 backgrounds, with a delay between requests. Check logs for errors/404s. Checkpoint.
4. **Frontend, homepage**: index.html + grid.js against 2–3 real JSON files (no need to wait for the full scrape). Search/sort — matching dittobase's layout.
5. **Frontend, detail page**: background.html + detail.js, clicking a pokemon → localStorage, "X/Y" counter. Shiny toggle.
6. **Styling**: only connect your interface-design skill (github.com/dammyjay93/interface-design) at this step, to precisely match the dark theme to the reference — not earlier, to avoid re-styling blind.
7. **Deploy**: docker-compose + nginx.conf + cron, run a full scrape in production, manual check.

Each step — a separate git commit/checkpoint before moving on (same discipline as agreed for energy-drinks-site).

## 10. Open assumptions — confirm or correct

- Images are cached locally with hotlink fallback (my own choice, see table in section 2).
- Stack: vanilla JS, no Next.js/React (Tailwind can still be added as a plain CSS file via CDN for faster styling — no build step required).
- Export/import progress as JSON — added by default so progress isn't lost.
- Sort/filters on the homepage — copied 1:1 from the screenshots (Newest/Oldest, All/type, pokemon search).
