/**
 * URL 构造与解析（评论地址、页面地址、时间格式）
 *
 * 从 src/shared.js 拆出来的。background 与三个页面共用，所以这里
 * **不能碰任何 DOM** —— service worker 里没有 document。
 */

/** aicu 的 dyn.type -> 人能看懂的来源名 */
export function aicuTypeName(type) {
  const map = { 1: '视频', 11: '相册', 12: '专栏', 14: '音频', 17: '动态' };
  return map[Number(type)] || ('类型' + type);
}

/** 用 aicu 给的 dyn.type / dyn.oid 拼一个能点开核对的 B 站地址 */
export function aicuPageUrl(type, oid) {
  const id = String(oid || '');
  if (!id) return '';
  switch (Number(type)) {
    case 1: return 'https://www.bilibili.com/video/av' + id;
    case 12: return 'https://www.bilibili.com/read/cv' + id;
    default: return 'https://t.bilibili.com/' + id;
  }
}

/**
 * 用 aicu 记录的 type / oid / root / rank 拼一条**和扩展自己记录时完全同款**的评论地址。
 *
 * 这一点很关键：只要格式一致，parseCommentUrl 就能原样解析回来（含楼中楼），
 * 这些条目存进收藏夹之后，角标、归档、删除全都按同一套逻辑走，不用为它们开小灶。
 */
export function aicuCommentUrl(item) {
  if (!item) return '';
  const rpid = String(item.rpid || '');
  if (!/^\d+$/.test(rpid)) return '';

  const base = aicuPageUrl(item.type, item.oid);
  if (!base) return '';

  const root = String(item.root || '0');
  const isSecondary = Number(item.rank) === 2 || (root !== '0' && root !== rpid);

  let u;
  try { u = new URL(base); } catch (e) { return ''; }
  u.searchParams.set('comment_on', '1');
  // 一级评论：root 就是它自己；楼中楼：root 是所属会话的根，本人另写在 secondary 里
  u.searchParams.set('comment_root_id', root !== '0' ? root : rpid);
  if (isSecondary) u.searchParams.set('comment_secondary_id', rpid);
  u.searchParams.set('share_type', 's_i');

  return u.toString() + '#reply' + rpid;
}

/**
 * aicu 页面上每条评论右下角的「方式2」链接：B 站自己的楼中楼详情页。
 *
 * 点进去能直接看到这条会话，从而判断出「没有该评论 / UP主已关闭评论区 / 暂无评论」。
 * 注意 root 用的是**会话根**：一级评论就是它自己，楼中楼才是所属会话的根 ——
 * 这一点和 aicu 页面上的参数完全一致。
 */
export function aicuSubUrl(item) {
  if (!item) return '';
  const oid = String(item.oid || '');
  const rpid = String(item.rpid || '');
  const type = Number(item.type);
  if (!/^\d+$/.test(oid) || !/^\d+$/.test(rpid) || !Number.isFinite(type)) return '';

  const root = String(item.root || '0');
  let u;
  try { u = new URL('https://www.bilibili.com/h5/comment/sub'); } catch (e) { return ''; }
  u.searchParams.set('oid', oid);
  u.searchParams.set('pageType', String(type));
  u.searchParams.set('root', root !== '0' ? root : rpid);
  return u.toString();
}

/** 判断是不是 B 站域名 */
export function isBiliUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)bilibili\.com$/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * 解析「复制评论链接」格式的 URL：
 *   一级评论 https://www.bilibili.com/video/BVxxx?comment_on=1&comment_root_id=123456789012&share_tag=s_i#reply123456789012
 *   楼中楼   ...&comment_root_id=123456789013&comment_secondary_id=123456789014...#reply123456789014
 * 返回 null 表示这不是一条评论链接。
 */
export function parseCommentUrl(url) {
  if (!isBiliUrl(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }

  const rootId = u.searchParams.get('comment_root_id') || '';
  const secondaryId = u.searchParams.get('comment_secondary_id') || '';
  const hashMatch = /#reply(\d+)/.exec(u.hash || '');

  // 删除时用的 rpid：楼中楼就是二级评论自己的 id
  const rpid = secondaryId || (hashMatch ? hashMatch[1] : '') || rootId;
  if (!rpid) return null;

  const bvMatch = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname);

  return {
    url,
    rpid,
    rootId: rootId || rpid,
    secondaryId,
    isSecondary: !!secondaryId,
    bvid: bvMatch ? bvMatch[1] : '',
    pageUrl: u.origin + u.pathname.replace(/\/+$/, '')
  };
}

/** 书签标题里的来源标识，例如 BV1xx411c7mD / cv123456 / 动态789 */
export function sourceLabel(pageUrl) {
  try {
    const u = new URL(pageUrl);
    let m = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname);
    if (m) return m[1];
    m = /\/video\/av(\d+)/i.exec(u.pathname);
    if (m) return 'av' + m[1];
    m = /\/read\/cv(\d+)/i.exec(u.pathname);
    if (m) return 'cv' + m[1];
    m = /\/opus\/(\d+)/.exec(u.pathname);
    if (m) return '动态' + m[1];
    m = /\/bangumi\/play\/([A-Za-z]+[0-9]+)/.exec(u.pathname);
    if (m) return m[1];
    m = /\/audio\/au(\d+)/i.exec(u.pathname);
    if (m) return 'au' + m[1];
    return (u.hostname.replace(/^www\./, '') + u.pathname).slice(0, 24);
  } catch (e) {
    return 'B站';
  }
}

/** 统一格式：[2026-01-30 12:34] BV1xx411c7mD · 评论前20字 */
export function buildTitle(info) {
  const ts = info.ctime ? Number(info.ctime) * 1000 : Date.now();
  const label = sourceLabel(info.pageUrl || info.url || '');
  const text = String(info.message || '').replace(/\s+/g, ' ').trim();
  let excerpt;
  if (text) excerpt = text.length > 20 ? text.slice(0, 20) + '…' : text;
  else excerpt = info.isSecondary ? '楼中楼回复' : '评论';
  return `[${fmtTime(ts)}] ${label} · ${excerpt}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
