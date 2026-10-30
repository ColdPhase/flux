# #734 README and docs site: rendered captures

Captured on 2026-10-30 with Playwright 1.63.0 Chromium in Docker
(`mcr.microsoft.com/playwright:v1.63.0-noble`), desktop 1440×900 and phone 390×844 at 2× (stored
at half size), light and dark colour schemes.

- `readme-*`: `README.md` rendered by the GitHub Markdown API (`gh api markdown`, mode `markdown`)
  inside `github-markdown-css` 5.8.1, top of the page. The Kreska header switches with the colour
  scheme through `<picture>`; the badges are the live images.
- `site-*`: the built site from `./scripts/check_docs_site.sh --serve` on port 33800: the home page,
  Backup and restore, Connect your own agent and the search dialog (query "backup").

Screenshots show layout only; the links are checked by the build (starlight-links-validator).
