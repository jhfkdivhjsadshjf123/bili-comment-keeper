/**
 * 备份：导出 JSON / HTML / Markdown，以及导入
 *
 * 从 src/shared.js 拆出来的。background 与三个页面共用，所以这里
 * **不能碰任何 DOM** —— service worker 里没有 document。
 */

import { LIB_VERSION, esc, getLibrary, saveVideoTitles, setLibStates, sortedForExport, stateText, upsertLibItems, videoOf } from './store.js';
import { aicuCommentUrl, aicuSubUrl, aicuTypeName, fmtTime } from './urls.js';

/**
 * 导出成 JSON —— 完整、无损、能再导回来。
 * 故意把 videos 也带上：不然导出的库再导入就只剩 av 号了。
 */
export async function exportLibraryJSON() {
  const lib = await getLibrary();
  const items = Object.keys(lib.items).map(k => lib.items[k]);
  return JSON.stringify({
    format: 'bili-comment-keeper/library',
    version: LIB_VERSION,
    exportedAt: new Date().toISOString(),
    uid: lib.uid,
    totalOnSite: lib.total,
    probedAt: lib.probedAt,
    count: items.length,
    videos: lib.videos,
    items: items
  }, null, 2);
}

/**
 * 导出成一份**能离线打开看**的 HTML。
 * 这是"定期查看"用的：双击就能在浏览器里翻，不依赖扩展、不联网。
 */
export async function exportLibraryHTML(title) {
  const lib = await getLibrary();
  const items = sortedForExport(lib);
  const heading = String(title || ('B 站评论备份 · UID ' + (lib.uid || '未知')));

  const counts = { live: 0, gone: 0, deleted: 0, unknown: 0, unreachable: 0 };
  for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;

  const rows = items.map(it => {
    const v = videoOf(lib, it);
    const label = v && v.title ? v.title : (String(it.type) === '1' ? 'av' + it.oid : it.oid);
    const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
    const url = aicuCommentUrl(it);
    const sub = aicuSubUrl(it);
    return `<li class="s-${esc(it.state)}">
      <div class="meta"><span class="when">${esc(when)}</span>
        <span class="tag t-${esc(it.state)}">${esc(stateText(it.state))}</span>
        <span class="kind">${esc(aicuTypeName(it.type))}</span>
        ${it.rank === 2 ? '<span class="kind">楼中楼</span>' : ''}</div>
      <div class="body">${esc(it.message || '（没有正文）')}</div>
      <div class="meta"><span class="vid">${esc(label)}</span>
        ${v && v.owner ? `<span class="owner">UP：${esc(v.owner)}</span>` : ''}
        <span class="rid">rpid ${esc(it.rpid)}</span></div>
      <div class="links">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">方式0</a>` : ''}
        ${sub ? `<a href="${esc(sub)}" target="_blank" rel="noreferrer">方式2</a>` : ''}
      </div>
    </li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:24px; font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         background:#faf9fb; color:#1c1c22; }
  @media (prefers-color-scheme: dark) { body { background:#16161a; color:#e6e6ea; } }
  h1 { font-size:20px; margin:0 0 6px; }
  .sum { color:#7a7a88; font-size:13px; margin-bottom:18px; }
  ul { list-style:none; margin:0; padding:0; }
  li { border:1px solid rgba(128,128,128,.24); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  li.s-gone, li.s-deleted { opacity:.55; }
  .meta { display:flex; flex-wrap:wrap; gap:10px; align-items:center; font-size:12.5px; color:#7a7a88; }
  .body { margin:6px 0; white-space:pre-wrap; word-break:break-word; }
  .tag { padding:0 6px; border-radius:4px; font-size:11.5px; border:1px solid currentColor; }
  .t-live { color:#1a9560; } .t-gone { color:#8a8a96; }
  .t-deleted { color:#c0392b; } .t-unknown { color:#b8860b; }
  .links a { margin-right:12px; font-size:13px; }
  footer { color:#7a7a88; font-size:12px; margin-top:22px; }
</style>
</head>
<body>
<h1>${esc(heading)}</h1>
<div class="sum">
  共 ${items.length} 条　·　还在 ${counts.live || 0}　·　已没了 ${counts.gone || 0}　·　
  已删除 ${counts.deleted || 0}　·　未检查 ${counts.unknown || 0}　·　
  查不到 ${counts.unreachable || 0}<br>
  导出时间 ${esc(fmtTime(Date.now()))}
</div>
<ul>
${rows}
</ul>
<footer>由 B站评论管家 导出。这份文件是自包含的，不联网也能看。</footer>
</body>
</html>`;
}

/** 导出成 Markdown —— 便于丢进笔记软件、或者拿去 diff */
export async function exportLibraryMarkdown(title) {
  const lib = await getLibrary();
  const items = sortedForExport(lib);
  const heading = String(title || ('B 站评论备份 · UID ' + (lib.uid || '未知')));

  const counts = { live: 0, gone: 0, deleted: 0, unknown: 0, unreachable: 0 };
  for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;

  const lines = [
    '# ' + heading,
    '',
    `共 ${items.length} 条　·　还在 ${counts.live || 0}　·　已没了 ${counts.gone || 0}　·　` +
      `已删除 ${counts.deleted || 0}　·　未检查 ${counts.unknown || 0}　·　查不到 ${counts.unreachable || 0}`,
    '',
    `导出时间：${fmtTime(Date.now())}`,
    ''
  ];

  for (const it of items) {
    const v = videoOf(lib, it);
    const label = v && v.title ? v.title : (String(it.type) === '1' ? 'av' + it.oid : it.oid);
    const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
    const url = aicuCommentUrl(it);
    const sub = aicuSubUrl(it);

    lines.push('## ' + when + '　' + stateText(it.state));
    lines.push('');
    lines.push('> ' + String(it.message || '（没有正文）').replace(/\n/g, '\n> '));
    lines.push('');
    lines.push(`- ${aicuTypeName(it.type)}${it.rank === 2 ? '（楼中楼）' : ''}：${label}` +
      (v && v.owner ? `　UP：${v.owner}` : ''));
    lines.push(`- rpid \`${it.rpid}\``);
    if (url) lines.push(`- [方式0](${url})`);
    if (sub) lines.push(`- [方式2](${sub})`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 把导出的 JSON 读回库。
 * 只认识我们自己导出的格式；条目走和导入一样的合并逻辑（不覆盖已有的存活结论）。
 */
export async function importLibraryJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, reason: '不是合法的 JSON' }; }
  if (!data || !Array.isArray(data.items)) return { ok: false, reason: '这不是评论库的备份文件（缺少 items）' };

  const r = await upsertLibItems({ uid: data.uid, total: data.totalOnSite, items: data.items });

  let videos = 0;
  if (data.videos && typeof data.videos === 'object') {
    videos = await saveVideoTitles(data.videos);
  }
  // 备份里的存活结论也要认，否则导回来全变成"未检查"
  const marks = {};
  for (const it of data.items) {
    if (it && it.rpid && it.state) marks[it.rpid] = it.state;
  }
  if (Object.keys(marks).length) await setLibStates(marks);

  return { ok: true, added: r.added, enriched: r.enriched, total: r.total, videos: videos };
}
