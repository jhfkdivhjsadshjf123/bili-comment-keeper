/**
 * store.js —— 评论库（唯一权威数据源）
 *
 * 数据只有**一份**：chrome.storage.local 里的 `bc_library`。
 * 老的「收藏夹 + 索引 + 云同步」在 v1.7 已经拆掉了 —— 收藏夹只能存标题和 URL，
 * 几千条会把书签栏塞爆；备份改用导出 JSON（见 export.js）。
 *
 * 这一层只做数据：读写、准入、查询、状态。**不碰 DOM** ——
 * background 是 service worker，里面没有 document。
 * 展示相关的东西（URL 拼装、时间格式）在 urls.js，通用工具在 util.js。
 */

import { aicuCommentUrl, aicuPageUrl, fmtTime, sourceLabel } from './urls.js';

/* ------------------------------------------- aicu.cc 导入的历史评论清单
 * 本扩展只能记录「装好之后」发出的评论；装之前发的、在手机 App 上发的都抓不到。
 * aicu.cc 存着完整的历史评论（它只是索引，评论实体仍在 B 站），所以由
 * src/aicu-main.js 在页面上把列表读回来，这里负责去重落盘，
 * 最后交给清除面板走**同一套**删除流程。
 */

const AICU_MAX_ITEMS = 20000;   // 别把 storage.local 撑爆（上限 10MB，每条约 150 字节）

/** 规整一条 aicu 记录；缺关键字段（rpid / type / oid）就返回 null */
export function normalizeAicuItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rpid = String(raw.rpid === undefined || raw.rpid === null ? '' : raw.rpid);
  if (!/^\d+$/.test(rpid)) return null;

  const type = Number(raw.type);
  const oid = String(raw.oid === undefined || raw.oid === null ? '' : raw.oid);
  if (!Number.isFinite(type) || !/^\d+$/.test(oid)) return null;

  const root = String(raw.root === undefined || raw.root === null ? '0' : raw.root);

  const out = {
    rpid: rpid,
    type: type,
    oid: oid,
    root: /^\d+$/.test(root) ? root : '0',
    rank: Number(raw.rank) || 1,
    message: String(raw.message || '').slice(0, 200),
    ctime: Number(raw.ctime) || 0
  };

  // 存活探测的结果：true=还在 / false=已经没了 / 不带=还没探过
  if (raw.alive === true || raw.alive === false) out.alive = raw.alive;
  return out;
}

/* --------------------------------------------------- 评论库（权威数据源）
 *
 * 定位变了：这不再只是「批量删评论」，核心是**本地评论管理 + 备份**，删除只是库里
 * 众多操作之一。所以数据不能再寄居在收藏夹上 —— 那里只能存标题和 URL，字段贫瘠，
 * 几千条还会把书签栏塞爆。改为以 chrome.storage.local 里的一份「库」为权威：
 *
 *   { v, uid, total, updatedAt, probedAt,
 *     items:  { rpid: item },
 *     videos: { "type:oid": { title, bvid, owner, at } } }
 *
 * item = { rpid, type, oid, root, rank, message, ctime,
 *          state,            // live=还在 / gone=已经没了 / deleted=我们自己删的 / unknown=还没查过
 *          aliveCheckedAt,   // 上次检查存活的时间（毫秒）
 *          goneAt,           // 哪一刻发现它没了的
 *          firstSeen, lastSeen,
 *          bookmarkId }      // 同步到收藏夹时留下的书签 id
 *
 * 兼容：老数据存在 bc_aicu 里、只有 alive: true/false/undefined，
 * 第一次读库时自动迁移过来，不丢东西。
 */

export const K_LIBRARY = 'bc_library';

export const LIB_VERSION = 2;
const LIB_MAX_ITEMS = 20000;

export const LIB_STATES = ['live', 'gone', 'deleted', 'unknown', 'unreachable'];

/**
 * 这条评论还值得为它发一次删除请求吗？
 *
 *   live        值得 —— 确认还在
 *   unknown     值得 —— 还没查过，删一次正好当探测
 *   unreachable 值得 —— 查不到（视频不可访问之类），但**不能因为查不到就当它没了**
 *   gone        **不值得** —— 已经没了，再问一次只会拿到 12022
 *   deleted     **不值得** —— 我们自己已经删过了
 *
 * 这是 v1.3 做存活探测的初衷：别为早就没了的评论浪费请求。
 * 所以任何"进删除队列"的入口都必须过这一关。
 */
export function isDeletable(state) {
  return state === 'live' || state === 'unknown' || state === 'unreachable';
}

/** 规整库里的一条记录；缺 rpid / type / oid 就返回 null */
export function normalizeLibItem(raw) {
  const base = normalizeAicuItem(raw);
  if (!base) return null;

  let state = String((raw && raw.state) || '').trim();
  if (LIB_STATES.indexOf(state) < 0) state = 'unknown';

  const out = {
    rpid: base.rpid,
    type: base.type,
    oid: base.oid,
    root: base.root,
    rank: base.rank,
    message: base.message,
    ctime: base.ctime,
    // 这条是哪儿来的：record=扩展自动记录下来的（你刚发的），aicu=从 aicu 导入的历史评论
    source: (raw && raw.source === 'record') ? 'record' : 'aicu',
    // 这条评论属于哪个账号。库是绑定到单个账号的（见 upsertLibItems 的准入），
    // 记在条目上是为了万一混进来了也能查得出来。
    uid: String((raw && raw.uid) || '').slice(0, 20),
    state: state
  };

  const ts = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  if (ts(raw.aliveCheckedAt)) out.aliveCheckedAt = ts(raw.aliveCheckedAt);
  if (ts(raw.goneAt)) out.goneAt = ts(raw.goneAt);
  if (ts(raw.deletedAt)) out.deletedAt = ts(raw.deletedAt);
  if (ts(raw.firstSeen)) out.firstSeen = ts(raw.firstSeen);
  if (ts(raw.lastSeen)) out.lastSeen = ts(raw.lastSeen);
  if (raw.bookmarkId) out.bookmarkId = String(raw.bookmarkId);
  // 上次检查的结论说明 —— 为什么是"查不到"、为什么判它没了，都记在这里给人看
  if (raw.note) out.note = String(raw.note).slice(0, 120);

  return out;
}

function normalizeLib(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = {};
  const inItems = src.items && typeof src.items === 'object' ? src.items : {};
  let count = 0;

  const altUids = [];
  for (const u of (Array.isArray(src.altUids) ? src.altUids : [])) {
    const s = String(u).trim();
    if (/^\d+$/.test(s) && s !== String(src.uid || '') && altUids.indexOf(s) < 0) altUids.push(s);
  }

  for (const k of Object.keys(inItems)) {
    if (count >= LIB_MAX_ITEMS) break;
    const it = normalizeLibItem(inItems[k]);
    if (!it) continue;
    items[it.rpid] = it;
    count++;
  }

  const videos = {};
  const inVideos = src.videos && typeof src.videos === 'object' ? src.videos : {};
  for (const k of Object.keys(inVideos)) {
    const v = inVideos[k];
    if (!v || typeof v !== 'object') continue;
    videos[k] = {
      title: String(v.title || '').slice(0, 200),
      bvid: String(v.bvid || '').slice(0, 20),
      owner: String(v.owner || '').slice(0, 60),
      at: Number(v.at) || 0
    };
  }

  return {
    v: LIB_VERSION,
    uid: String(src.uid || ''),
    altUids: altUids,
    uidPinnedAt: Number(src.uidPinnedAt) || 0,
    total: Number(src.total) || 0,
    updatedAt: Number(src.updatedAt) || 0,
    probedAt: Number(src.probedAt) || 0,
    items: items,
    videos: videos
  };
}

function emptyLib() {
  return normalizeLib({});
}

/** 视频缓存的键 */
export function videoKey(type, oid) {
  return String(Number(type)) + ':' + String(oid);
}

/** 读整库。库里没有就返回一个空库。 */
export async function getLibrary() {
  const o = await chrome.storage.local.get(K_LIBRARY);
  const lib = o[K_LIBRARY];
  if (lib && typeof lib === 'object' && lib.items) return normalizeLib(lib);
  return emptyLib();
}

/** 整个库清掉（数据页的「删除全部」用） */
export async function clearLibrary() {
  await chrome.storage.local.remove(K_LIBRARY);
}

/* -------------------------------------------------------- 库：账号绑定 */

/**
 * 设置主账号 UID（第一次使用时由用户自己填）。
 * 已经绑过就只允许改成同一个 —— 想换账号得先清库（数据页那个按钮）。
 */
export async function setOwnerUid(uid) {
  const lib = await getLibrary();
  const u = String(uid || '').trim();

  if (!u) return { ok: false, reason: 'UID 不能是空的' };
  if (!/^\d+$/.test(u)) return { ok: false, reason: 'UID 只能是数字' };
  if (lib.uid && lib.uid !== u) {
    return { ok: false, reason: `库已经绑定 UID ${lib.uid}。要换账号，先去「数据」页把评论库删掉。` };
  }

  lib.uid = u;
  if (!lib.uidPinnedAt) lib.uidPinnedAt = Date.now();
  await saveLibrary(lib);
  return { ok: true, uid: u };
}

/** 把一个 UID 记成"这是我的小号"，之后从它导入就不再多问 */
export async function allowAltUid(uid) {
  const lib = await getLibrary();
  const u = String(uid || '').trim();
  if (!/^\d+$/.test(u)) return { ok: false, reason: 'UID 只能是数字' };
  if (u === lib.uid) return { ok: true, uid: u, altUids: lib.altUids || [] };

  const alt = Array.isArray(lib.altUids) ? lib.altUids.slice() : [];
  if (alt.indexOf(u) < 0) alt.push(u);
  lib.altUids = alt;
  await saveLibrary(lib);
  return { ok: true, uid: u, altUids: alt };
}

/** 取消某个小号 */
export async function forgetAltUid(uid) {
  const lib = await getLibrary();
  const u = String(uid || '').trim();
  lib.altUids = (Array.isArray(lib.altUids) ? lib.altUids : []).filter(x => x !== u);
  await saveLibrary(lib);
  return { ok: true, altUids: lib.altUids };
}

export async function saveLibrary(lib) {
  const next = normalizeLib(lib);
  next.updatedAt = Date.now();
  await chrome.storage.local.set({ [K_LIBRARY]: next });
  return next;
}

/* ------------------------------------------------------------ 库：写操作 */

/**
 * 把一批评论并进库（已存在的不重复加，只补全缺失的字段）。
 * 这是导入 aicu 清单走的入口。
 *
 * **账号准入**（三道关，任何一道不过就一条都不写）：
 *   1. 还没设置过自己的 UID → 拒绝，让用户先去设置（code: 'no-owner'）
 *   2. UID 和主账号不一样、也不在"小号"列表里 → 拒绝并回问（code: 'not-owner'）
 *   3. 通过
 *
 * 为什么必须硬拦：aicu 的地址是 `aicu.cc/reply?uid=xxx` —— 把 uid 换成别人的，
 * 就能把**别人的评论**导进你的库。导进来之后「删除选中」会拿着别人的 rpid
 * 去发删除请求，库里的账也全乱了。
 * （早先只做了个 `mixed` 标记"警告不拦"，实测根本不够 —— 用户换个 uid 就中招。
 *  后来改成"认第一个见到的 UID"也不对：万一第一次打开的是别人的页面就绑错了。）
 */
export async function upsertLibItems(payload) {
  const list = Array.isArray(payload) ? payload : ((payload && payload.items) || []);
  const lib = await getLibrary();
  const now = Date.now();

  const incoming = String((payload && payload.uid) || '').trim();
  const current = Object.keys(lib.items).length;
  const altUids = Array.isArray(lib.altUids) ? lib.altUids : [];

  const bail = function (code, reason) {
    return {
      refused: true, code: code, reason: reason,
      owner: lib.uid || '', incoming: incoming, altUids: altUids,
      added: 0, enriched: 0, total: current, store: lib
    };
  };

  if (incoming) {
    if (!lib.uid) {
      return bail('no-owner',
        '还没设置你自己的 UID。先在导入页填上，再来抓 —— 不然分不清这些评论是谁的。');
    }
    if (incoming !== lib.uid && altUids.indexOf(incoming) < 0) {
      return bail('not-owner',
        `这批数据属于 UID ${incoming}，你的账号是 ${lib.uid}。` +
        '如果不是你的小号，什么都不要导入。');
    }
  }

  let added = 0;
  let enriched = 0;
  let count = current;

  for (const raw of list) {
    const it = normalizeLibItem(raw);
    if (!it) continue;
    if (incoming && !it.uid) it.uid = incoming;

    const prev = lib.items[it.rpid];
    if (prev) {
      const patch = {};
      if (!prev.message && it.message) patch.message = it.message;
      if (!prev.ctime && it.ctime) patch.ctime = it.ctime;
      if (!prev.type && it.type) patch.type = it.type;
      if (!prev.oid && it.oid) patch.oid = it.oid;
      if ((!prev.root || prev.root === '0') && it.root && it.root !== '0') patch.root = it.root;
      // 自己记录下来的条目比"从 aicu 导入的"更可信，优先级更高
      if (it.source === 'record' && prev.source !== 'record') patch.source = 'record';
      // 已经查过存活结论的，不要被一次重新导入冲掉
      patch.lastSeen = now;
      if (Object.keys(patch).length > 1) {
        lib.items[it.rpid] = Object.assign({}, prev, patch);
        enriched++;
      } else {
        lib.items[it.rpid] = Object.assign({}, prev, { lastSeen: now });
      }
      continue;
    }

    if (count >= LIB_MAX_ITEMS) break;
    it.firstSeen = it.firstSeen || now;
    it.lastSeen = now;
    lib.items[it.rpid] = it;
    count++;
    added++;
  }

  if (payload && Number(payload.total)) lib.total = Number(payload.total);

  if (added || enriched || incoming) await saveLibrary(lib);
  return { added: added, enriched: enriched, total: count, store: lib };
}

const STATE_SET = { live: 1, gone: 1, deleted: 1, unknown: 1, unreachable: 1 };

/**
 * 记下一批存活结论。marks 形如
 *   { rpid: 'live' | 'gone' | 'unknown' | 'unreachable' }
 * 也接受 `{ rpid: { state, note } }` 和老的 true/false 写法。
 *
 * 会顺手记下检查时间；**第一次发现它没了的时候**记下 goneAt。
 * `note` 是"为什么得出这个结论"，会存下来给人看 —— 光显示"查不到"没法排查。
 */
export async function setLibStates(marks) {
  const lib = await getLibrary();
  const now = Date.now();
  let changed = 0;   // 结论真的变了的
  let touched = 0;   // 结论没变、只是刷新了"上次检查时间"的

  for (const rpid of Object.keys(marks || {})) {
    const it = lib.items[rpid];
    if (!it) continue;

    const raw = marks[rpid];
    const spec = (raw && typeof raw === 'object') ? raw : { state: raw };
    if (!STATE_SET[spec.state]) continue;          // 状态不认识就跳过，别瞎记
    const state = spec.state;
    const note = spec.note ? String(spec.note).slice(0, 120) : '';

    it.note = note;
    it.aliveCheckedAt = now;

    if (it.state === state) { touched++; continue; }

    if (state === 'live') {
      // 又活了（或者之前判错了），把"没了"的痕迹清掉
      delete it.goneAt;
    } else if (state === 'gone' && !it.goneAt) {
      it.goneAt = now;
    }
    it.state = state;
    changed++;
  }

  if (changed || touched) {
    lib.probedAt = now;
    await saveLibrary(lib);
  }
  return { changed: changed, touched: touched, probedAt: lib.probedAt };
}

/** 我们自己把它删掉了 */
export async function markLibDeleted(rpids) {
  const list = (Array.isArray(rpids) ? rpids : []).map(String);
  if (!list.length) return 0;

  const lib = await getLibrary();
  const now = Date.now();
  let changed = 0;
  for (const rpid of list) {
    const it = lib.items[rpid];
    if (!it) continue;
    it.state = 'deleted';
    it.deletedAt = now;
    it.aliveCheckedAt = now;
    changed++;
  }
  if (changed) await saveLibrary(lib);
  return changed;
}

export async function removeLibItems(rpids) {
  const list = (Array.isArray(rpids) ? rpids : []).map(String);
  if (!list.length) return 0;

  const lib = await getLibrary();
  let removed = 0;
  for (const rpid of list) {
    if (lib.items[rpid]) { delete lib.items[rpid]; removed++; }
  }
  if (removed) await saveLibrary(lib);
  return removed;
}

/** 按 rpid 精确取几条（勾选的条目往往不在当前页，不能靠翻页去找） */
export async function getLibItems(rpids) {
  const list = (Array.isArray(rpids) ? rpids : []).map(String);
  if (!list.length) return [];

  const lib = await getLibrary();
  const out = [];
  for (const rpid of list) {
    const it = lib.items[rpid];
    if (it) out.push(it);
  }
  return out;
}

/** 视频标题缓存 */
export async function saveVideoTitles(map) {
  const keys = Object.keys(map || {});
  if (!keys.length) return 0;

  const lib = await getLibrary();
  const now = Date.now();
  let n = 0;
  for (const k of keys) {
    const v = map[k];
    if (!v || !v.title) continue;
    lib.videos[k] = {
      title: String(v.title).slice(0, 200),
      bvid: String(v.bvid || '').slice(0, 20),
      owner: String(v.owner || '').slice(0, 60),
      at: now
    };
    n++;
  }
  if (n) await saveLibrary(lib);
  return n;
}

/* ------------------------------------------------------------ 库：读操作 */

/** 按时间倒序列出全部条目 */
export async function listLibItems() {
  const lib = await getLibrary();
  return Object.values(lib.items).sort((a, b) => (b.ctime - a.ctime) || (String(b.rpid) > String(a.rpid) ? 1 : -1));
}

export async function libraryStats() {
  const lib = await getLibrary();
  const s = { total: 0, live: 0, gone: 0, deleted: 0, unknown: 0, unreachable: 0,
              recorded: 0, imported: 0, videos: 0, titled: 0 };
  const seenVideos = {};
  for (const k of Object.keys(lib.items)) {
    const it = lib.items[k];
    const st = it.state;
    s.total++;
    if (s[st] === undefined) s.unknown++; else s[st]++;
    if (it.source === 'record') s.recorded++; else s.imported++;
    seenVideos[videoKey(it.type, it.oid)] = 1;
  }
  s.videos = Object.keys(seenVideos).length;   // 库里涉及多少个视频
  s.titled = Object.keys(lib.videos).length;   // 其中多少个已经有标题
  s.uid = lib.uid;
  s.uidPinnedAt = lib.uidPinnedAt || 0;
  s.totalOnSite = lib.total;
  s.probedAt = lib.probedAt;
  s.updatedAt = lib.updatedAt;
  return s;
}

/**
 * 查库：搜索 / 筛选 / 排序 / 分页。
 * 分页是必须的 —— 库里几千条，不可能一次塞进 DOM。
 */
export async function queryLib(opts) {
  const o = opts || {};
  const lib = await getLibrary();

  const q = String(o.q || '').trim().toLowerCase();
  const states = Array.isArray(o.states) && o.states.length ? o.states : null;
  const oid = o.oid ? String(o.oid) : '';
  const sort = o.sort || 'time-desc';

  let list = Object.values(lib.items);

  if (states) list = list.filter(it => states.indexOf(it.state) >= 0);
  if (oid) list = list.filter(it => String(it.oid) === oid);
  if (o.source === 'record' || o.source === 'aicu') {
    list = list.filter(it => it.source === o.source);
  }
  if (q) {
    list = list.filter(it =>
      String(it.message || '').toLowerCase().indexOf(q) >= 0 ||
      String(it.rpid).indexOf(q) >= 0 ||
      String(it.oid).indexOf(q) >= 0);
  }

  const cmp = {
    'time-desc': (a, b) => (b.ctime - a.ctime),
    'time-asc': (a, b) => (a.ctime - b.ctime),
    'video': (a, b) => (String(a.oid) === String(b.oid)
      ? (b.ctime - a.ctime)
      : (String(a.oid) < String(b.oid) ? -1 : 1))
  }[sort];
  if (cmp) list.sort(cmp);

  const total = list.length;
  const offset = Math.max(0, Number(o.offset) || 0);
  const limit = Math.max(1, Math.min(500, Number(o.limit) || 50));
  const page = list.slice(offset, offset + limit);

  // 顺手把视频标题带上，省得调用方再查一次
  const withVideo = page.map(it => Object.assign({}, it, {
    video: lib.videos[videoKey(it.type, it.oid)] || null
  }));

  return { total: total, offset: offset, limit: limit, items: withVideo, videos: lib.videos };
}

/* -------------------------------------------- 给 B 站消息页那一栏用的数据 */

/**
 * 「我的评论」栏要的那份数据：**只包含还在的**。
 *
 * 放在这一层（而不是在 background.js 里现写）有两个原因：
 *   · background.js 顶层就碰 chrome.*，Node 里根本加载不了 —— 写在那里等于测不到
 *   · 数据整形本来就属于数据层的事
 *
 * 返回的是给页面直接渲染用的扁平结构，字段名都是为显示准备的。
 */
export async function liveComments(limit) {
  // 正数就夹到 1~500；没给 / 0 / 负数 / 不是数字，一律当"没给"，用默认 100。
  // 写这么细是因为 `Number(limit) || 100` 那种写法对 0 和负数会给出两种不同结果，
  // 调用方猜不出来。
  const want = Number(limit);
  const n = Math.max(1, Math.min(500, want > 0 ? want : 100));

  const st = await libraryStats();
  const r = await queryLib({ states: ['live'], sort: 'time-desc', offset: 0, limit: n });

  return {
    total: st.live,            // 还在的总数（可能比这次返回的多）
    shown: r.items.length,
    uid: st.uid || '',
    items: r.items.map(function (it) {
      const pageUrl = aicuPageUrl(it.type, it.oid);
      return {
        rpid: String(it.rpid),
        message: String(it.message || '').slice(0, 300),
        when: it.ctime ? fmtTime(it.ctime * 1000) : '',
        kind: Number(it.rank) === 2 ? '楼中楼' : '一级评论',
        // 跳到那条评论本身
        url: aicuCommentUrl(it) || '',
        // 它出自哪个视频/专栏/动态 —— 显示用短标签（av… / cv… / t.bilibili.com/…），
        // 有缓存标题的时候用标题
        page: pageUrl ? sourceLabel(pageUrl) : '',
        pageUrl: pageUrl,
        video: (it.video && it.video.title) ? String(it.video.title) : ''
      };
    })
  };
}

/* ------------------------------------------------------------------ 导出 */

export const esc = s => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STATE_TEXT = { live: '还在', gone: '已没了', deleted: '已删除', unknown: '未检查', unreachable: '查不到' };

export function stateText(state) {
  return STATE_TEXT[state] || STATE_TEXT.unknown;
}

/** 导出的条目按时间倒序，读起来顺一点 */
export function sortedForExport(lib) {
  return Object.keys(lib.items)
    .map(k => lib.items[k])
    .sort((a, b) => (b.ctime - a.ctime));
}

export function videoOf(lib, it) {
  return lib.videos[videoKey(it.type, it.oid)] || null;
}

/* ------------------------------------------------------------------ 杂项 */

