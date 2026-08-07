# VPS deploy

This project is deployed as:

- `caddy`: serves the static frontend from `public/` over HTTP/HTTPS
- `scraper`: a one-shot Node container that runs `node scraper/run-all.js`
  and fetches the live dittobase homepage on every run to discover the
  current background slug list
- shared Docker volumes:
  - `public_data` -> generated JSON (`/public/data`)
  - `public_images` -> generated images (`/public/images`)

The daily scrape is intentionally scheduled from the VPS host cron, not from
inside a long-running container. That keeps the scraper stateless and makes
manual re-runs identical to the scheduled job.

## Domain

This repo is configured for:

- `background.mooo.com`

If you want a different hostname later, update `Caddyfile`.

## First deploy

1. Clone the repo onto the VPS.
2. Start Caddy with `docker compose up -d caddy`.
3. Run one initial scrape with `docker compose run --rm scraper`.
4. Install the daily cron entry:

   `0 3 * * * cd /opt/dittotracker && /usr/bin/docker compose run --rm scraper >> /var/log/dittotracker-scrape.log 2>&1`

## Manual scrape

From the project directory on the VPS:

```bash
docker compose run --rm scraper
```

## Logs

Web server:

```bash
docker compose logs -f caddy
```

Manual or cron scraper run:

```bash
docker compose run --rm scraper
tail -f /var/log/dittotracker-scrape.log
```

## Verification

HTTP:

```bash
curl -I http://background.mooo.com
```

HTTPS:

```bash
curl -I https://background.mooo.com
```

Generated data:

```bash
curl -I https://background.mooo.com/data/index.json
curl -I https://background.mooo.com/images/icons/shadow.png
```

Certificate details:

```bash
echo | openssl s_client -connect background.mooo.com:443 -servername background.mooo.com 2>/dev/null | openssl x509 -noout -issuer -subject -dates
```
