(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const topicMatch = location.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)/);
  if (!topicMatch) throw new Error('请先打开需要导出的主题页面。');

  const topicId = Number(topicMatch[1]);
  const getJson = async (url, attempts = 6) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) return response.json();
      lastError = new Error(`${url} 返回 HTTP ${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
      await sleep(Math.min(30_000, attempt * 3_000));
    }
    throw lastError;
  };

  const download = (name, contents, type) => {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  console.log(`[导出器] 正在读取主题 ${topicId}…`);
  const topic = await getJson(`/t/${topicId}.json`);
  const postIds = topic.post_stream?.stream;
  if (!Array.isArray(postIds) || postIds.length === 0) {
    throw new Error('主题接口没有返回帖子列表，请确认当前账号有权查看完整主题。');
  }

  console.log(`[导出器] ${topic.title}，共 ${postIds.length} 帖。`);
  const postsById = new Map();
  for (let offset = 0; offset < postIds.length; offset += 20) {
    const ids = postIds.slice(offset, offset + 20);
    const query = ids.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
    const payload = await getJson(`/t/${topicId}/posts.json?${query}`);
    for (const post of payload.post_stream?.posts ?? []) postsById.set(post.id, post);
    console.log(`[导出器] 已读取 ${Math.min(offset + ids.length, postIds.length)}/${postIds.length}`);
    await sleep(300);
  }

  const posts = postIds.map((id) => postsById.get(id)).filter(Boolean);
  if (posts.length !== postIds.length) {
    throw new Error(`导出不完整：只获取到 ${posts.length}/${postIds.length} 帖。请重新运行。`);
  }

  const prefix = `topic-${topicId}`;
  const jsonl = posts.map((post) => JSON.stringify(post)).join('\n') + '\n';
  const metadata = JSON.stringify({
    source_url: location.href,
    topic_id: topicId,
    title: topic.title,
    post_count: posts.length,
    exported_at: new Date().toISOString(),
    topic: { ...topic, post_stream: undefined },
  }, null, 2) + '\n';

  const articles = posts.map((post) => `
    <article id="post-${post.post_number}">
      <header>
        <a href="${escapeHtml(`${location.origin}/t/${topicId}/${post.post_number}`)}">#${post.post_number}</a>
        <strong>${escapeHtml(post.name || post.username)}</strong>
        <span>@${escapeHtml(post.username)}</span>
        <time datetime="${escapeHtml(post.created_at)}">${escapeHtml(post.created_at)}</time>
      </header>
      <div class="post-body">${post.cooked ?? ''}</div>
    </article>`).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(topic.title)}</title>
<style>
body{font:16px/1.55 system-ui,sans-serif;max-width:900px;margin:auto;padding:2rem;color:#222}
article{border-top:1px solid #ddd;padding:1.5rem 0}.post-body img{max-width:100%;height:auto}
header{display:flex;gap:.7rem;flex-wrap:wrap;color:#666}header a{font-weight:700}pre{overflow:auto}
</style></head><body>
<h1>${escapeHtml(topic.title)}</h1>
<p>来源：<a href="${escapeHtml(location.href)}">${escapeHtml(location.href)}</a>，共 ${posts.length} 帖。</p>
${articles}
</body></html>`;

  download(`${prefix}.jsonl`, jsonl, 'application/x-ndjson;charset=utf-8');
  await sleep(500);
  download(`${prefix}-metadata.json`, metadata, 'application/json;charset=utf-8');
  await sleep(500);
  download(`${prefix}.html`, html, 'text/html;charset=utf-8');
  console.log(`[导出器] 完成：已下载 ${posts.length} 帖的 JSONL、metadata JSON 和 HTML 文件。`);
})().catch((error) => {
  console.error('[导出器] 失败：', error);
  alert(`导出失败：${error.message}`);
});
