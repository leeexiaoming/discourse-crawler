import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ORIGIN = 'https://www.uscardforum.com';
const PROFILE_DIR = path.resolve('.browser-profile');
const OUTPUT_DIR = path.resolve('output');

function usage() {
  console.log(`Usage:
  npm run login -- <topic URL>
  npm run crawl -- <topic URL>

The login window closes automatically after the forum reports that you are signed in.`);
}

async function launch(headless) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: { width: 1400, height: 1000 },
    locale: 'en-US',
  });
}

async function currentUser(page) {
  return page.evaluate(async () => {
    const response = await fetch('/session/current.json', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.current_user ?? null;
  }).catch(() => null);
}

async function login(topicUrl) {
  const context = await launch(false);
  const page = context.pages()[0] ?? await context.newPage();
  parseTopicId(topicUrl);
  await page.goto(topicUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  console.log('Chrome is open. Complete the forum login there; this process will detect it.');
  for (;;) {
    const user = await currentUser(page);
    if (user?.username) {
      console.log(`Login detected for ${user.username}. Session saved in ${PROFILE_DIR}`);
      await context.close();
      return;
    }
    await page.waitForTimeout(2_000);
  }
}

async function apiJson(page, url, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await page.evaluate(async (requestUrl) => {
      const response = await fetch(requestUrl, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    }, url);

    if (result.ok) {
      try {
        return JSON.parse(result.text);
      } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}`);
      }
    }

    lastError = new Error(`HTTP ${result.status} from ${url}: ${result.text.slice(0, 300)}`);
    if (![429, 500, 502, 503, 504].includes(result.status)) break;
    await page.waitForTimeout(Math.min(30_000, attempt * 3_000));
  }
  throw lastError;
}

function parseTopicId(topicUrl) {
  const url = new URL(topicUrl);
  if (url.origin !== ORIGIN) throw new Error(`Expected a URL on ${ORIGIN}`);
  const match = url.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)/);
  if (!match) throw new Error(`Could not find a topic ID in ${topicUrl}`);
  return Number(match[1]);
}

function batches(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function crawl(topicUrl) {
  const topicId = parseTopicId(topicUrl);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const context = await launch(true);
  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto(topicUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const user = await currentUser(page);
    if (!user?.username) throw new Error('Not logged in. Run `npm run login` first.');
    console.log(`Authenticated as ${user.username}`);

    const topic = await apiJson(page, `/t/${topicId}.json`);
    const postIds = topic.post_stream?.stream;
    if (!Array.isArray(postIds) || postIds.length === 0) {
      throw new Error('The topic API did not return a post stream.');
    }
    console.log(`Topic: ${topic.title} (${postIds.length} posts)`);

    const jsonlPath = path.join(OUTPUT_DIR, `topic-${topicId}.jsonl`);
    const metadataPath = path.join(OUTPUT_DIR, `topic-${topicId}-metadata.json`);
    const htmlPath = path.join(OUTPUT_DIR, `topic-${topicId}.html`);
    const existing = new Map();

    try {
      const lines = (await fs.readFile(jsonlPath, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        const post = JSON.parse(line);
        existing.set(post.id, post);
      }
      console.log(`Resuming with ${existing.size} posts already saved`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const missingIds = postIds.filter((id) => !existing.has(id));
    const groups = batches(missingIds, 20);
    for (let index = 0; index < groups.length; index += 1) {
      const query = groups[index].map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
      const payload = await apiJson(page, `/t/${topicId}/posts.json?${query}`);
      const posts = payload.post_stream?.posts ?? [];
      if (!posts.length) throw new Error(`No posts returned for batch ${index + 1}`);
      await fs.appendFile(jsonlPath, posts.map((post) => JSON.stringify(post)).join('\n') + '\n');
      for (const post of posts) existing.set(post.id, post);
      console.log(`Saved ${existing.size}/${postIds.length} posts`);
      await page.waitForTimeout(250);
    }

    const ordered = postIds.map((id) => existing.get(id)).filter(Boolean);
    if (ordered.length !== postIds.length) {
      throw new Error(`Archive is incomplete: ${ordered.length}/${postIds.length} posts`);
    }

    const metadata = {
      source_url: topicUrl,
      topic_id: topicId,
      title: topic.title,
      fancy_title: topic.fancy_title,
      post_count: ordered.length,
      crawled_at: new Date().toISOString(),
      authenticated_username: user.username,
      topic: { ...topic, post_stream: undefined },
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');

    const articles = ordered.map((post) => `
      <article id="post-${post.post_number}">
        <header>
          <a href="${htmlEscape(`${ORIGIN}/t/${topicId}/${post.post_number}`)}">#${post.post_number}</a>
          <strong>${htmlEscape(post.name || post.username)}</strong>
          <span>@${htmlEscape(post.username)}</span>
          <time datetime="${htmlEscape(post.created_at)}">${htmlEscape(post.created_at)}</time>
        </header>
        <div class="post-body">${post.cooked ?? ''}</div>
      </article>`).join('\n');

    const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(topic.title)}</title>
<style>
body{font:16px/1.55 system-ui,sans-serif;max-width:900px;margin:auto;padding:2rem;color:#222}
article{border-top:1px solid #ddd;padding:1.5rem 0}.post-body img{max-width:100%;height:auto}
header{display:flex;gap:.7rem;flex-wrap:wrap;color:#666}header a{font-weight:700}pre{overflow:auto}
</style></head><body>
<h1>${htmlEscape(topic.title)}</h1>
<p>Archived from <a href="${htmlEscape(topicUrl)}">${htmlEscape(topicUrl)}</a>. ${ordered.length} posts.</p>
${articles}
</body></html>`;
    await fs.writeFile(htmlPath, document);
    console.log(`Complete. Wrote:\n${jsonlPath}\n${metadataPath}\n${htmlPath}`);
  } finally {
    await context.close();
  }
}

const command = process.argv[2];
if (command === 'login') {
  if (!process.argv[3]) {
    usage();
    process.exitCode = 1;
  } else {
    await login(process.argv[3]);
  }
} else if (command === 'crawl') {
  if (!process.argv[3]) {
    usage();
    process.exitCode = 1;
  } else {
    await crawl(process.argv[3]);
  }
} else {
  usage();
  process.exitCode = 1;
}
