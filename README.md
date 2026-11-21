# Discourse topic crawler

Export every post in a Discourse topic through an authenticated Chrome session. The crawler uses the topic's post stream and fetches posts in batches, so it does not depend on manually scrolling an infinite page.

This repository currently targets `www.uscardforum.com`. Change `ORIGIN` in `crawl.mjs` to use another Discourse host.

## Install

```bash
npm install
```

## Option 1: Browser-backed crawler

Open a dedicated Chrome profile and sign in:

```bash
npm run login -- 'https://www.uscardforum.com/t/example/123'
```

Then export the complete topic:

```bash
npm run crawl -- 'https://www.uscardforum.com/t/example/123'
```

Files are written to `output/`:

- `topic-<id>.jsonl`: one complete Discourse post object per line
- `topic-<id>.html`: a readable archive
- `topic-<id>-metadata.json`: topic metadata

Interrupted crawls resume from the existing JSONL file.

## Option 2: Existing signed-in Chrome tab

If Cloudflare challenges automated Chrome, open the topic in a normal signed-in Chrome tab. Open DevTools Console, paste the contents of `browser-console-export.js`, and press Enter. The browser downloads the same three output formats.

## Security

- Passwords are never collected or stored by these scripts.
- The browser session is stored locally under `.browser-profile/` and is excluded from Git.
- Exported topic contents are stored under `output/` and are excluded from Git.
- Do not commit browser profiles, cookies, downloaded private topics, or generated output files.
