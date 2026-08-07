# GitHub Pages deploy

This project is deployed with GitHub Actions and GitHub Pages.

The frontend is static. The scraper runs fresh in GitHub Actions, writes
generated JSON and images into `public/data/` and `public/images/`, then the
entire `public/` folder is uploaded as the GitHub Pages artifact.

Generated data and images are not committed to git history. `public/data/` and
`public/images/` stay gitignored.

## One-time GitHub settings

These repository settings must be enabled once:

- Repository visibility: public
- Settings -> Pages -> Build and deployment -> Source: GitHub Actions

## Workflow

Workflow file:

```text
.github/workflows/scrape-and-deploy.yml
```

Triggers:

- Push to `main`: redeploys immediately with a fresh scrape.
- Manual run: Actions tab -> Scrape and deploy -> Run workflow.
- Schedule: `0 3 * * *`, which is 03:00 UTC daily.

The workflow:

1. Checks out the repository.
2. Installs scraper dependencies with Node 22.
3. Runs `node scraper/run-all.js`.
4. Uploads `public/` as the Pages artifact.
5. Deploys that artifact to GitHub Pages.

## Manual scrape and deploy

Use the GitHub web UI:

1. Open the repository on GitHub.
2. Go to Actions.
3. Select `Scrape and deploy`.
4. Click `Run workflow`.
5. Choose branch `main`.
6. Click `Run workflow`.

## Logs

Scraper and deploy logs are in the workflow run:

1. Open GitHub -> repository -> Actions.
2. Select `Scrape and deploy`.
3. Open the latest run.
4. Open the `scrape-and-deploy` job.
5. Expand `Run scraper` for scraper output.
6. Expand `Deploy to GitHub Pages` for the final Pages URL.

## Verification

After a successful run, the site should be available at:

```text
https://kladbm.github.io/BackgroundsTracker/
```

Check generated files in the deployed site:

```text
https://kladbm.github.io/BackgroundsTracker/data/index.json
https://kladbm.github.io/BackgroundsTracker/images/icons/shadow.png
```

A successful run shows:

- green checkmark on the workflow run
- `Run scraper` completed without a non-zero exit
- `Upload Pages artifact` completed
- `Deploy to GitHub Pages` completed
- deployment URL shown in the job summary

