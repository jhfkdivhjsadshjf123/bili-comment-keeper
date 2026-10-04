/**
 * background.js —— 扩展后台（MV3 service worker）
 *
 * v1.7 起数据只有**一份**：chrome.storage.local 里的评论库（bc_library）。
 * 老的「收藏夹 + 索引 + 云同步」三件套已经拆掉了 —— 收藏夹只是个可选的镜像
 * （设置里的「同时写入浏览器收藏夹」，默认关）。
 *
 * 职责：
 *   1) 收到网页转发来的「我刚发了一条评论」→ 写进评论库；
 *   2) 你在 B 站网页上自己删了评论时，把库里那条标成已删除；
 *   3) aicu.cc 页面上读到的历史评论 → 并进库里；
 *   4) 给 B 站消息页注入的「我的评论」栏供数据；
 *   5) 维护工具栏角标。
 */

import { K_SETTINGS, getSettings } from './settings.js';
import { allowAltUid, getLibrary, libraryStats, liveComments, markLibDeleted, setOwnerUid, upsertLibItems } from './store.js';
import { fmtTime } from './urls.js';
import { ensureFolder } from './util.js';
import { fillVideoTitles } from './video-info.js';

/* ------------------------------------------------------------------ 记录 */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'RECORD_COMMENT') {
    withLibLock(function () { return handleRecord(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true; // 异步回复
  }
  if (msg && msg.type === 'COMMENT_DELETED') {
    withLibLock(function () { return handleDeleted(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  if (msg && msg.type === 'REFRESH_BADGE') {
    updateBadge().then(function () { sendResponse({ ok: true }); });
    return true;
  }
  // 清除面板删完成功后，把对应的条目交回后台标成"已删除"。
  // 面板不能自己整库写回：它在启动时读了一份快照，删除期间后台可能又记了
  // 新评论，整库写回会把那些新的覆盖掉。
  if (msg && msg.type === 'FORGET_RPIDS') {
    withLibLock(function () { return handleForget(msg.rpids); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // aicu.cc 页面上顺手读到的历史评论清单
  if (msg && msg.type === 'AICU_REPLIES') {
    handleAicuImport(msg.payload)
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // 第一次使用：用户自己填 UID
  if (msg && msg.type === 'SET_OWNER_UID') {
    withLibLock(function () { return handleSetOwner(msg.uid); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // 「这是我小号」→ 把这个 UID 记进白名单，并把刚才拒掉的那批补进来
  if (msg && msg.type === 'CONFIRM_ALT_UID') {
    withLibLock(function () { return handleConfirmAlt(msg.uid); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // 「不是我的」→ 把暂存的那批丢掉，什么都不做
  if (msg && msg.type === 'REJECT_ALT_UID') {
    pendingImport = null;
    sendResponse({ ok: true, discarded: true });
    return true;
  }
  // B 站页面顺手上报的登录 UID（/x/web-interface/nav 里的 mid）
  if (msg && msg.type === 'BILI_UID') {
    withLibLock(function () { return handleBiliUid(msg.payload); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // B 站消息页注入的「我的评论」栏来要数据。
  // 数据整形在 store.js 的 liveComments() 里 —— 那里 Node 能加载，测得到。
  if (msg && msg.type === 'GET_LIVE_COMMENTS') {
    liveComments(msg.limit)
      .then(function (r) { sendResponse(Object.assign({ ok: true }, r)); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // 那一栏要显示视频标题 —— 按需抓，抓到就进库缓存，下次不再请求
  if (msg && msg.type === 'FETCH_VIDEO_TITLES') {
    fillVideoTitles(msg.items, msg.limit)
      .then(function (map) { sendResponse({ ok: true, titles: map }); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  // 那一栏上单条删除（不走控制台的批量流程）
  if (msg && msg.type === 'DELETE_ONE_COMMENT') {
    withLibLock(function () { return handleDeleteOne(msg.payload, sender); })
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, reason: String((e && e.message) || e) }); });
    return true;
  }
  return false;
});

/**
 * 单条删除，供 B 站消息页那一栏用 —— **不走控制台那套批量流程**。
 *
 * 借的是发起消息那个标签页自己（消息页就在 bilibili.com 上，登录态现成）。
 * 删除请求必须从 bilibili 页面里发：扩展自己的 origin 是 chrome-extension://，
 * 对 bilibili.com 算跨站，SESSDATA 会被 SameSite 拦掉。
 *
 * 用 `world: 'MAIN'` 是为了让 recorder-main.js 的钩子也能看到这次删除，
 * 这样"在网页上自己删了评论"的同步逻辑照常生效；不过账还是这里自己记，
 * 不依赖那个钩子。
 */
async function handleDeleteOne(payload, sender) {
  const rpid = digits(payload && payload.rpid);
  const oid = digits(payload && payload.oid);
  const type = digits(payload && payload.type);

  if (!rpid) return { ok: false, reason: '这条记录没有 rpid，删不了' };
  if (!oid || !type) {
    return { ok: false, reason: '这条记录缺视频信息（type / oid），删不了 —— 它可能不是从评论区抓来的' };
  }

  // 优先用发消息那个标签页（用户此刻就在上面），否则找一个 bilibili 标签页
  let tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId === null || tabId === undefined) {
    const tabs = await chrome.tabs.query({ url: 'https://*.bilibili.com/*' }).catch(function () { return []; });
    const usable = (tabs || []).find(function (t) { return t.id !== undefined && !t.discarded; });
    tabId = usable ? usable.id : null;
  }
  if (tabId === null || tabId === undefined) {
    return { ok: false, reason: '没有可用的 bilibili 标签页。随便打开一个 bilibili 页面再试。' };
  }

  let out;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: injectedDelete,
      args: [{ type: Number(type), oid: String(oid), rpid: String(rpid) }]
    });
    out = res && res[0] && res[0].result;
  } catch (e) {
    return { ok: false, reason: '往页面注入删除脚本失败：' + ((e && e.message) || e) };
  }

  if (!out) return { ok: false, reason: '页面没有回话（那个标签页可能卡住了，刷新一下再试）' };

  // 0 = 删掉了；12022 = 本来就已经没了 —— 两种都算这条不用再管了
  if (out.ok || out.code === 12022) {
    await markLibDeleted([rpid]);
    await updateBadge();
    broadcast({ type: 'SYNC_ARCHIVED', rpid: rpid });
    return { ok: true, already: out.code === 12022 };
  }

  return { ok: false, code: out.code, reason: explainCode(out.code, out.message) };
}

/**
 * 注入到 bilibili 页面里跑的删除脚本。
 *
 * **必须完全自包含** —— chrome.scripting 是把函数转成字符串丢进页面重新求值的，
 * 引用本文件里任何别的变量都会变成 undefined。
 */
function injectedDelete(arg) {
  var m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(document.cookie || '');
  if (!m) {
    return Promise.resolve({ ok: false, code: null, message: '页面里读不到 bili_jct，请确认浏览器已登录 B 站' });
  }

  // 用 recorder-main.js 在 document_start 抢存的那份原生 fetch：
  // 直接用 window.fetch 会穿过 B 站自己的 API 包装层，行为不可预期。
  var f = (typeof window.__bcNativeFetch === 'function') ? window.__bcNativeFetch : window.fetch;

  var body = new URLSearchParams();
  body.set('type', String(arg.type));
  body.set('oid', String(arg.oid));
  body.set('rpid', String(arg.rpid));
  body.set('csrf', m[1]);

  return f('https://api.bilibili.com/x/v2/reply/del', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }).then(function (res) {
    return res.json();
  }).then(function (j) {
    return { ok: !!(j && j.code === 0), code: (j && j.code), message: (j && j.message) || '' };
  }).catch(function (e) {
    return { ok: false, code: null, message: String((e && e.message) || e) };
  });
}

/**
 * 收到 B 站页面上报的登录 UID。
 *
 * 只在**还没设置过**的时候自动填上 —— 已经绑定了就不动它（那可能是小号，
 * 或者用户就是想管另一个账号）。这样用户第一次用扩展时什么都不用填：
 * 只要访问过一次 B 站，UID 就自己就位了。
 */
async function handleBiliUid(payload) {
  const uid = String((payload && payload.uid) || '').trim();
  if (!/^\d+$/.test(uid)) return { ok: false, reason: 'UID 无效' };

  const lib = await getLibrary();
  if (lib.uid) {
    // 已经绑过了。如果不是小号列表里的，只提醒一句、不做任何改动。
    if (lib.uid !== uid && (lib.altUids || []).indexOf(uid) < 0) {
      broadcast({ type: 'UID_SEEN', uid: uid, owner: lib.uid });
    }
    return { ok: true, already: true, uid: lib.uid };
  }

  const r = await setOwnerUid(uid);
  if (r.ok) {
    broadcast({ type: 'UID_SET', uid: uid, uname: String((payload && payload.uname) || ''), auto: true });
  }
  return r;
}

/**
 * 被账号准入拒掉的那一批，暂存在这里。
 *
 * 为什么暂存：用户答"是小号"之后，那批数据不该白抓 —— 直接从这儿补进去，
 * 不用让他回 aicu 页面再点一次。只活在内存里，service worker 睡了就没了，
 * 所以面板在补录失败时会提示"重新抓一次"。
 */
let pendingImport = null;

async function handleSetOwner(uid) {
  const r = await setOwnerUid(uid);
  if (r.ok) {
    // 设好了就顺手把之前因为"还没设 UID"被拒的那批补进来
    if (pendingImport) {
      const p = pendingImport;
      pendingImport = null;
      await handleAicuImport(p);
    }
    broadcast({ type: 'UID_SET', uid: r.uid });
    await updateBadge();
  }
  return r;
}

async function handleConfirmAlt(uid) {
  const r = await allowAltUid(uid);
  if (!r.ok) return r;

  if (pendingImport && String(pendingImport.uid) === String(uid)) {
    const p = pendingImport;
    pendingImport = null;
    const back = await handleAicuImport(p);
    broadcast({ type: 'UID_SET', uid: r.uid });
    return { ok: true, uid: uid, altUids: r.altUids, replayed: back };
  }
  broadcast({ type: 'UID_SET', uid: r.uid });
  return { ok: true, uid: uid, altUids: r.altUids, replayed: null };
}

/**
 * 库的写锁：「读-改-写」必须串行。
 *
 * getLibrary() 每次都从 storage 反序列化出一份独立副本，所以两个并发的 handler
 * 各自加完自己的条目、再各自整份写回时，后写的会把先写的覆盖掉，那条评论就静默丢了。
 * 一秒内连发两条评论、或者面板收尾时正好在另一个标签页发评论，都会撞上。
 */
let libLock = Promise.resolve();

function withLibLock(task) {
  const next = libLock.then(task, task);
  // 无论成功还是抛错都把锁解开，别让一次异常卡死后面所有写入
  libLock = next.then(function () {}, function () {});
  return next;
}

/** 把一批 rpid 标成「我们自己删掉的」 */
async function handleForget(rpids) {
  const list = Array.isArray(rpids)
    ? rpids.map(function (r) { return String(r); }).filter(function (r) { return /^\d+$/.test(r); })
    : [];
  if (!list.length) return { ok: true, removed: 0 };

  const n = await markLibDeleted(list);
  await updateBadge();
  return { ok: true, removed: n };
}

/**
 * aicu 导入：并进库，不碰别的。
 * 真正的删除仍然走控制台里那套（注入 B 站页面调 /x/v2/reply/del）。
 *
 * 账号对不上时这里会拿到 refused —— 那是**故意的**：
 * aicu 的地址是 `aicu.cc/reply?uid=xxx`，把 uid 换成别人的就能把别人的评论
 * 导进你的库。所以要么拒绝（还没设 UID），要么回问一句"这是你小号吗"。
 */
async function handleAicuImport(payload) {
  const r = await upsertLibItems(payload);

  if (r.refused) {
    // 暂存起来，用户答"是小号"之后直接补进去
    pendingImport = { uid: r.incoming, payload: payload };
    broadcast({
      type: r.code === 'no-owner' ? 'AICU_NEED_UID' : 'AICU_ASK_UID',
      owner: r.owner, incoming: r.incoming
    });
    return { ok: false, refused: true, code: r.code, reason: r.reason,
             owner: r.owner, incoming: r.incoming };
  }

  if (r.added || r.enriched) {
    broadcast({ type: 'AICU_UPDATED', added: r.added, enriched: r.enriched, total: r.total });
  }
  await updateBadge();
  return { ok: true, added: r.added, enriched: r.enriched, total: r.total };
}

/** 只接受纯数字字符串，其余一律返回 null */
function digits(v) {
  if (v === undefined || v === null || v === '') return null;
  return /^\d+$/.test(String(v)) ? String(v) : null;
}

/**
 * 被账号准入拒掉的那一批，暂存在这里。
 *
 * 为什么暂存：用户答"是小号"之后，那批数据不该白抓 —— 直接从这儿补进去，
 * 不用让他回 aicu 页面再点一次。只活在内存里，service worker 睡了就没了，
 * 所以面板在补录失败时会提示"重新抓一次"。
 */

/** 校验并规整网页传来的数据，防止页面脚本伪造垃圾 */
function normalize(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const rpid = digits(payload.rpid);
  if (!rpid) return null;

  const type = digits(payload.type);
  const oid = digits(payload.oid);

  return {
    rpid: rpid,
    root: digits(payload.root) || '0',
    parent: digits(payload.parent) || '0',
    type: type === null ? null : Number(type),
    oid: oid,
    url: String(payload.url || '').slice(0, 2000),
    message: String(payload.message || '').slice(0, 300),
    ctime: Number(payload.ctime) || Math.floor(Date.now() / 1000),
    isSecondary: !!payload.isSecondary,
    source: String(payload.source || 'network').slice(0, 20)
  };
}

/**
 * 记下一条「你刚发出去的评论」。
 *
 * **数据以本地库为准**：直接写进评论库，source='record'、state='live'，
 * 首页的「所有历史评论」立刻就能看到它。
 *
 * 收藏夹只剩一个可选动作（设置里的「同时写入浏览器收藏夹」，默认关）。
 */
async function handleRecord(payload) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: '自动记录已关闭' };

  const info = normalize(payload);
  if (!info) return { ok: false, reason: '无效的评论数据' };

  // 剪贴板兜底会把「别人评论的链接」也一起记下来（你复制别人评论分享时），
  // 所以默认关闭，需要时在设置里打开。
  if (info.source === 'clipboard' && !settings.clipboardFallback) {
    return { ok: false, reason: '剪贴板兜底记录未开启' };
  }

  if (!info.oid || info.type === null) {
    // 没有 oid / type 就没法删它，但仍然值得存下来（至少能看、能导出）
    broadcast({ type: 'RECORD_INCOMPLETE', rpid: info.rpid });
  }

  const before = await getLibrary();
  const existed = !!before.items[info.rpid];

  await upsertLibItems({
    items: [{
      rpid: info.rpid,
      type: info.type,
      oid: info.oid,
      root: info.root,
      rank: info.isSecondary ? 2 : 1,
      message: info.message,
      ctime: info.ctime,
      state: 'live',        // 刚发出去的，肯定是活的
      source: 'record'
    }]
  });

  let bookmarkId = null;
  if (settings.useBookmarks && info.url) {
    bookmarkId = await mirrorToBookmarks(settings, info);
  }

  await updateBadge();
  return { ok: true, duplicated: existed, url: info.url, bookmarkId: bookmarkId };
}

/** 可选的收藏夹镜像；失败不影响记录本身 */
async function mirrorToBookmarks(settings, info) {
  try {
    const parentId = await ensureFolder(settings.folderActive);
    const same = await chrome.bookmarks.search({ url: info.url }).catch(function () { return []; });
    if (same.length) return same[0].id;

    const title = `[${fmtTime(info.ctime * 1000)}] ` +
      (info.message ? String(info.message).replace(/\s+/g, ' ').slice(0, 20) : '评论');
    const node = await chrome.bookmarks.create({ parentId: parentId, title: title, url: info.url });
    return node.id;
  } catch (e) {
    return null;
  }
}

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* 没有页面在监听时会抛错，忽略 */ }
}

/* -------------------------------------------------- 手动删除的同步归档
 * 你在 B 站网页上自己点了某条评论的「删除」时，网页会请求 /x/v2/reply/del，
 * 我们把这条消息接住，把库里那条标成「已删除」。
 * 这样不管从哪儿删的，账都是平的。
 */

async function handleDeleted(payload) {
  const rpid = String((payload && payload.rpid) || '');
  if (!/^\d+$/.test(rpid)) return { ok: false, reason: 'rpid 无效' };

  const lib = await getLibrary();
  const it = lib.items[rpid];

  if (it && it.state === 'deleted') return { ok: true, already: true };

  const n = await markLibDeleted([rpid]);
  await updateBadge();
  broadcast({ type: 'SYNC_ARCHIVED', rpid: rpid });

  if (!n) return { ok: true, already: true, note: '库里本来就没有这条' };
  return { ok: true };
}

/* ------------------------------------------------------------------ 角标 */

/**
 * 角标。显示什么由设置里的 badgeMode 决定：
 *
 *   off     不显示（**默认**）
 *   live    显示库里"还在"的条数
 *   pending 显示还没处理的条数（库里除"已删除"之外的全部）
 *
 * 为什么默认不显示：产品定位是"本地评论管理器 + 备份"，角标不再是任务提醒 ——
 * 一个档案柜不需要在图标上顶一个数字催你。想留着的在设置里打开即可。
 */
async function updateBadge() {
  try {
    const settings = await getSettings();
    const mode = String(settings.badgeMode || 'off');
    const s = await libraryStats();

    if (mode === 'off') {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({
        title: `B站评论管家 · 库里 ${s.total} 条` +
          (s.live ? `，还在 ${s.live} 条` : '') +
          (s.probedAt ? `（上次巡检 ${fmtTime(s.probedAt)}）` : '')
      });
      return;
    }

    let count = 0;
    let tip = '';
    if (mode === 'live') {
      count = s.live;
      tip = `还在 ${s.live} 条（库里共 ${s.total} 条）`;
    } else {
      count = s.total - s.deleted;
      tip = `还没处理 ${count} 条（库里共 ${s.total} 条）`;
    }

    await chrome.action.setBadgeBackgroundColor({ color: '#fb7299' });
    await chrome.action.setBadgeText({
      text: count > 0 ? (count > 999 ? '999+' : String(count)) : ''
    });
    await chrome.action.setTitle({ title: `B站评论管家 · ${tip}` });
  } catch (e) {
    // 角标失败不影响主流程
  }
}

/** 书签被创建/删除/移动/改名时（打开收藏夹镜像时才有意义），稍后重算一次角标 */
let badgeTimer = null;
function scheduleBadgeUpdate() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(function () {
    badgeTimer = null;
    updateBadge();
  }, 800);
}

chrome.bookmarks.onCreated.addListener(scheduleBadgeUpdate);
chrome.bookmarks.onRemoved.addListener(scheduleBadgeUpdate);
chrome.bookmarks.onMoved.addListener(scheduleBadgeUpdate);
chrome.bookmarks.onChanged.addListener(scheduleBadgeUpdate);

/* -------------------------------------------------------------- 生命周期 */

chrome.runtime.onInstalled.addListener(async function () {
  const settings = await getSettings();
  await chrome.storage.local.set({ [K_SETTINGS]: Object.assign({}, settings) });
  if (settings.useBookmarks) await ensureFolder(settings.folderActive);
  await updateBadge();
});

chrome.runtime.onStartup.addListener(function () {
  updateBadge();
});
