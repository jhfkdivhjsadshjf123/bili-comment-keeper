/**
 * 删除引擎：注入、重试、主流程
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { $, log, logError, setHint } from './dom.js';
import { loadAicu } from './import.js';
import { loadArchive, renderRow, setEta, setUi, syncCounts, updateProgress } from './library.js';
import { state } from './state.js';
import { markLibDeleted } from '../src/store.js';
import { sourceLabel } from '../src/urls.js';
import { explainCode, randInt, sleep } from '../src/util.js';

/** 自检里等「注入」回应的时长；用 var 方便测试调小 */
var BC_PREFLIGHT_INJECT_MS = 8000;

/* 注入网页主世界执行，必须完全自包含（不能引用本文件任何变量） */
export async function mainWorldDelete(arg) {
  const done = out => {
    out.requestId = arg.requestId;

    // 回传通道 ①（主）：把结果挂在页面的 window 上，控制台自己回来取。
    // 这条不经过内容脚本，所以「标签页是装扩展之前打开的、内容脚本已失效」也不影响。
    try {
      if (!window.__bcDelResults) window.__bcDelResults = {};
      const keys = Object.keys(window.__bcDelResults);
      if (keys.length > 200) {            // 别在页面上越堆越多
        for (let i = 0; i < keys.length - 100; i++) delete window.__bcDelResults[keys[i]];
      }
      window.__bcDelResults[arg.requestId] = out;
    } catch (e) { /* 忽略 */ }

    // 回传通道 ②（兜底）：老路子的 postMessage，交给隔离世界的内容脚本转发
    try { window.postMessage({ __bcDeleterResult: out }, '*'); } catch (e) { /* 忽略 */ }

    return out;
  };

  const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(document.cookie || '');
  if (!m) return done({ ok: false, code: null, message: '页面里读不到 bili_jct，请确认浏览器已登录 bilibili' });

  // 用原生 fetch（recorder-main.js 在 document_start 抢存的那份）。
  // 直接用 window.fetch 的话，请求会穿过 B 站自己的 API 包装层，行为不可预期。
  const doFetch = (typeof window.__bcNativeFetch === 'function')
    ? window.__bcNativeFetch
    : window.fetch.bind(window);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await doFetch('https://api.bilibili.com/x/v2/reply/del', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        type: String(arg.type), oid: String(arg.oid), rpid: String(arg.rpid), csrf: m[1]
      }).toString(),
      signal: ctrl.signal
    });
    const json = await res.json().catch(() => null);
    if (!json) return done({ ok: false, code: null, message: '接口返回不是 JSON，可能被风控拦截了' });
    return done({ ok: json.code === 0, code: json.code, message: json.message || '' });
  } catch (err) {
    const msg = (err && err.name === 'AbortError') ? '请求超时（15 秒）' : '网络错误：' + ((err && err.message) || err);
    return done({ ok: false, code: null, message: msg });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注入网页主世界执行：**只把接口的原始返回搬回来**，不做任何判断。
 *
 * 为什么把判断挪走：判断逻辑（尤其是楼中楼的确认）放在这里的话，它就跑在页面里、
 * 依赖注入 + 序列化，既难测也难查。现在这里只负责"发一个 GET、把原文带回来"，
 * 判定统一由控制台那侧做 —— 那部分是纯函数，有测试盯着。
 *
 * 用的是**原生 fetch**（recorder-main.js 在 document_start 抢存的那份）。
 * 直接用 window.fetch 的话，请求会穿过 B 站自己的 API 包装层，行为不可预期。
 *
 * **不需要登录、不需要 cookie**：查询评论的接口是公开可读的，别人本来就能查你的评论，
 * 所以这里用 credentials: 'omit'，不带任何凭据。
 */
export async function mainWorldFetchReply(arg) {
  const done = out => {
    out.requestId = arg.requestId;
    try {
      if (!window.__bcDelResults) window.__bcDelResults = {};
      const keys = Object.keys(window.__bcDelResults);
      if (keys.length > 200) {
        for (let i = 0; i < keys.length - 100; i++) delete window.__bcDelResults[keys[i]];
      }
      window.__bcDelResults[arg.requestId] = out;
    } catch (e) { /* 忽略 */ }
    try { window.postMessage({ __bcDeleterResult: out }, '*'); } catch (e) { /* 忽略 */ }
    return out;
  };

  const url = String(arg.url || '');
  if (!url) return done({ ok: false, message: '没有给地址' });

  const doFetch = (typeof window.__bcNativeFetch === 'function')
    ? window.__bcNativeFetch
    : window.fetch.bind(window);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await doFetch(url, { credentials: 'omit', signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    // 只带原文回来，解析交给控制台
    return done({ ok: true, status: res.status, text: String(text).slice(0, 50000) });
  } catch (err) {
    const msg = (err && err.name === 'AbortError') ? '请求超时（15 秒）' : ('网络错误：' + ((err && err.message) || err));
    return done({ ok: false, message: msg });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给任何 await 套一个硬上限。
 *
 * 这一条是被真实事故逼出来的：探测功能上线后，有人点了「探测存活」，界面一动不动、
 * 风扇狂转、连「停止」都没反应。根因是某一步 await（最可能是 executeScript）
 * **永远不 settle** —— 于是 Promise.race 里的总超时压根执行不到，整个流程静默卡死。
 *
 * 教训：不能只在最后加一个 race 就以为万无一失，**每一个可能卡住的 await 都得自己带上限**。
 */
export function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    sleep(ms).then(function () { return fallback; })
  ]);
}

/** 索引里没有 oid 时，用 BV 号反查视频 aid（视频评论区的 oid 就是 aid） */
export async function resolveAid(bvid) {
  if (state.aidCache.has(bvid)) return state.aidCache.get(bvid);
  let aid = '';
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { credentials: 'omit' });
    const json = await res.json();
    if (json && json.code === 0 && json.data && json.data.aid) aid = String(json.data.aid);
  } catch (e) { /* 忽略 */ }
  state.aidCache.set(bvid, aid);
  return aid;
}

export async function resolveTarget(it) {
  const p = it.parsed;

  // 库里的条目自带评论区 id 与类型，直接就用
  if (it.oid && it.type !== null && it.type !== undefined) {
    return { type: Number(it.type), oid: String(it.oid), rpid: p.rpid };
  }

  // 兜底：只拿到 BV 号时反查 aid
  let type = (it.type !== null && it.type !== undefined) ? Number(it.type) : null;
  let oid = it.oid ? String(it.oid) : '';

  if (!oid && p.bvid) {
    oid = await resolveAid(p.bvid);
    if (type === null) type = 1;
  }
  if (!oid) return { error: '这条记录里没有评论区 oid，也没能用 BV 号反查出 aid' };

  if (type === null || Number.isNaN(type)) {
    if (!p.bvid) return { error: '缺少评论区类型 type，无法定位这条评论' };
    type = 1;
  }
  return { type: type, oid: oid, rpid: p.rpid };
}

/** 等目标标签页加载完（读不到 status 就稍等片刻直接开工） */
/** 等标签页加载完；超时也会 resolve（调用方自己决定要不要继续） */
export function waitTabComplete(tabId, timeout) {
  return new Promise(function (resolve) {
    const onUp = function (id, info) {
      if (id === tabId && info && info.status === 'complete') finish();
    };
    const finish = function () {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUp);
      resolve();
    };
    const timer = setTimeout(finish, timeout);

    chrome.tabs.onUpdated.addListener(onUp);
    chrome.tabs.get(tabId).then(function (tab) {
      if (!tab || tab.status === 'complete') return finish();
      if (typeof tab.status !== 'string') setTimeout(finish, 1200);
    }).catch(finish);
  });
}

/**
 * 找一个（或开一个）bilibili 标签页当同站请求通道。
 *
 * **优先挑已经加载完的**：往一个还在加载的页面注入脚本，chrome 会一直等到它
 * 可用为止 —— 表现出来就是"注入卡住 8 秒"。所以这里把 status === 'complete'
 * 的排前面（Array.sort 是稳定的，同类保持原来的顺序）。
 */
export async function getWorkerTab() {
  if (state.workerTabId !== null) {
    try { await chrome.tabs.get(state.workerTabId); return state.workerTabId; } catch (e) { state.workerTabId = null; }
  }

  const tabs = await withTimeout(chrome.tabs.query({ url: 'https://*.bilibili.com/*' }), 8000, []);
  const usable = (tabs || [])
    .filter(t => t.id !== undefined && t.id !== null && !t.discarded)
    .sort((a, b) => (b.status === 'complete' ? 1 : 0) - (a.status === 'complete' ? 1 : 0))[0];

  if (usable) { state.workerTabId = usable.id; state.workerCreated = false; return state.workerTabId; }

  return await openWorkerTab();
}

/**
 * 丢掉手上的通道标签页，重新开一个干净的。
 * 自检发现注入不进去时用它自愈 —— 比让用户自己去刷新页面靠谱。
 */
export async function openWorkerTab() {
  if (state.workerCreated && state.workerTabId !== null) {
    try { await chrome.tabs.remove(state.workerTabId); } catch (e) { /* 早就没了 */ }
  }
  state.workerTabId = null;
  state.workerCreated = false;

  const tab = await withTimeout(chrome.tabs.create({ url: 'https://www.bilibili.com/', active: false }), 8000, null);
  if (!tab) throw new Error('打开 bilibili 标签页时卡住了');
  state.workerTabId = tab.id;
  state.workerCreated = true;
  await waitTabComplete(tab.id, 25000);
  return tab.id;
}

/** 确保手上有一个还活着的通道标签页；被关掉就重新找一个 */
export async function acquireWorkerTab() {
  if (state.workerTabId !== null) {
    try {
      await withTimeout(chrome.tabs.get(state.workerTabId), 5000, null);
      return state.workerTabId;
    } catch (e) {
      state.workerTabId = null;      // 用户把它关了
      state.workerCreated = false;
    }
  }
  return await getWorkerTab();
}

/**
 * 把一个函数注入 bilibili 页面跑，然后等它回话。删除和存活探测都走这里。
 *
 * 结果有两条回传通道，谁先到用谁：
 *   ① **控制台自己去页面取**（主）：注入的脚本把结果挂在 `window.__bcDelResults` 上，
 *      我们隔一会儿用 executeScript 回去读一次。**完全不经过内容脚本**。
 *   ② 老路子：页面 postMessage → 隔离世界的内容脚本转发（兜底）。
 *
 * 为什么要把 ① 做成主通道：② 依赖「那个 bilibili 标签页里跑着当前版本的内容脚本」。
 * 如果标签页是装/更新扩展之前就开着的，内容脚本已经失效 —— 于是每条都静静地等满
 * 超时，一千多条就是八个多小时，而且看不出哪里坏了。① 没有这个依赖。
 *
 * **world 很重要，别随手改**：
 *   - `'MAIN'`（默认）：主世界。删除必须在这里 —— `recorder-main.js` 要在这一层
 *     挂钩删除请求，手动删除的评论才能被记进账本。
 *   - `'ISOLATED'`：内容脚本所在的世界。**它的 fetch 是干净的**，没有被我们自己的
 *     钩子包过，也没有被 B 站自己的 fetch 包装改写。存活探测是只读的、不需要谁记账，
 *     所以放这里 —— 之前放主世界，探测请求会走进 B 站的包装层，一条都问不出来。
 *
 * 返回注入脚本写下的那个结果对象（原样，含 ok/code/message 以及各自的业务字段）。
 */
export async function runInjected(tabId, fn, arg, timeoutMs, world) {
  const requestId = 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const OVERALL_MS = Number(timeoutMs || BC_DELETE_TIMEOUT_MS) || 23000;
  const payload = Object.assign({}, arg, { requestId: requestId });
  const useWorld = world || 'MAIN';

  // 通道 ①：轮询页面上的结果（超时不 resolve，交给总超时收尾）
  const viaPoll = (async function () {
    const deadline = Date.now() + OVERALL_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      let out;
      try {
        // 每一次轮询也带上限：某一次 executeScript 卡住不能把整条流程拖死
        out = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: useWorld,          // 必须和被探测/删除的脚本在同一个世界，否则读不到那个结果槽
            func: function (id) {
              return (window.__bcDelResults && window.__bcDelResults[id]) || null;
            },
            args: [requestId]
          }),
          4000,
          null
        );
      } catch (e) {
        // 页面被关了 / 被导航走了
        return { ok: false, tabGone: true, message: '读取页面结果失败：' + ((e && e.message) || e) };
      }
      const r = out && out[0] && out[0].result;
      if (r && r.requestId === requestId) return r;
    }
    return new Promise(function () { /* 永不 resolve */ });
  })();

  // 通道 ②：页面 postMessage → 内容脚本转发（同样超时不 resolve）
  const viaMessage = new Promise(function (resolve) {
    state.pending.set(requestId, resolve);
    setTimeout(function () { state.pending.delete(requestId); }, OVERALL_MS);
  });

  const overallTimeout = sleep(OVERALL_MS + 1500).then(function () {
    return { ok: false, message: '等待页面响应超时（' + Math.round(OVERALL_MS / 1000) + ' 秒）' };
  });

  // 注入本身也必须有上限 —— 这一步不 settle 的话，下面的 race 根本执行不到
  let injectedOut = null;
  let injectFailed = null;
  try {
    injectedOut = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: useWorld,
        func: fn,
        args: [payload]
      }),
      OVERALL_MS,
      null                    // null = 注入本身就超时了
    );
  } catch (e) {
    injectFailed = e;
  }

  if (injectFailed) {
    state.pending.delete(requestId);
    // 最常见的原因是通道标签页被关掉了，标记出来交给调用方换一个重试
    return { ok: false, tabGone: true, message: '注入网页失败：' + ((injectFailed && injectFailed.message) || injectFailed) };
  }

  if (injectedOut) {
    // 同步返回（没走 async）时这里就能直接拿到结果
    const r = injectedOut[0] && injectedOut[0].result;
    if (r && r.requestId === requestId) {
      state.pending.delete(requestId);
      return r;
    }
  }

  const r = await Promise.race([viaPoll, viaMessage, overallTimeout]);
  state.pending.delete(requestId);
  return r;
}

/** 删一条。返回 { ok, code, message, tabGone? } */
export async function deleteOne(tabId, target) {
  const r = await runInjected(tabId, mainWorldDelete,
    { type: target.type, oid: target.oid, rpid: target.rpid });
  if (r.tabGone) return { ok: false, code: null, tabGone: true, message: r.message };
  return { ok: !!r.ok, code: r.code, message: r.message || '' };
}

/**
 * 删除一条；通道标签页中途没了就自动换一个再试一次。
 * v1.0.0 只在开跑前取一次通道，用户中途手一滑关掉那个标签页，
 * 后面每一条都会失败——这里补上恢复能力。
 */
export async function deleteWithRecovery(target) {
  let tabId = await acquireWorkerTab();
  let r = await deleteOne(tabId, target);

  if (r.tabGone) {
    log('  ↻ 请求通道标签页已失效，正在换一个…');

    // 注入失败不一定是因为标签页被关了（也可能是那个页面被导航去了别的站点），
    // 所以别急着丢掉记录：如果当前用的正是我们自己开的临时标签页，先把它收掉，
    // 否则重新 acquire 之后就再也认不出它，会白白留在后台。
    if (state.workerCreated && state.workerTabId !== null) {
      try { await chrome.tabs.remove(state.workerTabId); } catch (e) { /* 早就没了 */ }
    }
    state.workerTabId = null;
    state.workerCreated = false;

    tabId = await acquireWorkerTab();
    r = await deleteOne(tabId, target);
  }
  return r;
}

/**
 * 开工前自检：确认「注入 bilibili 页面 → 页面 postMessage → 内容脚本转发 → 控制台收到」
 * 这条链路是通的。
 *
 * 为什么要专门做这件事：链上任何一环断了（最常见的是**这个 bilibili 标签页是在装/更新
 * 扩展之前打开的，里面的内容脚本已经失效**），外在表现都是「点了删除之后一片安静」，
 * 然后每条各自等 25 秒超时 —— 一千多条就是八个多小时，而且完全看不出哪里坏了。
 * 先拿一条假消息跑一遍，几秒钟就能给出可操作的结论。
 */
export async function preflight(tabId, opts) {
  const requireLogin = !(opts && opts.requireLogin === false);
  // 第一关：能不能注入、页面里读不读得到登录态
  //
  // 注意这一关**完全不经过内容脚本** —— 它注入的是一个自包含函数，只用 chrome
  // 自己的注入能力。所以这里失败时，"把页面刷新一下"是**错的建议**（刷新解决的是
  // 内容脚本失效，那是第二关的事）。注入卡住通常是那个标签页本身有问题：
  // 后台标签页被冻结、或者页面一直没加载完。对策是换一个标签页，不是让用户刷新。
  let probe;
  try {
    probe = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: function () {
          const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(document.cookie || '');
          return { hasJct: !!m, href: location.href, ready: document.readyState };
        }
      }),
      Number(BC_PREFLIGHT_INJECT_MS) || 8000,
      null
    );
  } catch (e) {
    return {
      ok: false, code: 'inject-failed',
      reason: '往那个 bilibili 标签页注入脚本失败：' + ((e && e.message) || e)
    };
  }

  if (!probe) {
    return {
      ok: false, code: 'inject-timeout',
      reason: '往 bilibili 标签页注入脚本时卡住了（8 秒没回应）—— ' +
        '那个标签页多半是卡住了（后台标签页被冻结、或者一直没加载完）。'
    };
  }

  const info = probe && probe[0] && probe[0].result;
  if (!info) {
    return { ok: false, code: 'no-result', reason: '脚本注入进去了但没拿到返回值，那个标签页可能还没加载完。' };
  }
  if (requireLogin && !info.hasJct) {
    return {
      ok: false, code: 'no-login',
      reason: '在那个 bilibili 页面里读不到 bili_jct。请确认浏览器已登录 B 站，并把那个页面刷新一下再试。'
    };
  }
  log('自检 1/2：注入正常' + (requireLogin ? '，登录态正常' : '（探测不需要登录，跳过登录检查）') +
    '（' + String(info.href).slice(0, 70) + '）');

  // 第二关：消息回传链路
  const requestId = 'pre-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const arrived = await new Promise(function (resolve) {
    state.pending.set(requestId, function () { resolve(true); });
    setTimeout(function () {
      if (state.pending.has(requestId)) { state.pending.delete(requestId); resolve(false); }
    }, Number(BC_PREFLIGHT_MS) || 6000);

    withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: function (id) {
          window.postMessage({ __bcDeleterResult: { requestId: id, ok: true, code: 0, message: '自检' } }, '*');
        },
        args: [requestId]
      }),
      4000,
      null
    ).catch(function () { /* 下面按超时处理 */ });
  });

  if (!arrived) {
    // 主通道（控制台自己去页面取结果）不走这里，所以只提示、不拦。
    log('自检 2/2：内容脚本那条兜底通道没回应。不影响删除（主通道不走它），' +
      '但如果这个 bilibili 标签页是装/更新扩展之前就开着的，建议刷新一下。');
  } else {
    log('自检 2/2：兜底通道也正常');
  }

  return { ok: true };
}

/** 把库里这条标成「已删除」；返回空串表示成功，否则返回错误说明 */
export async function archive(it) {
  // 没有 oid/type 的条目（比如剪贴板兜底记下来的）删掉就删掉了，库里也不留账
  if (!it.parsed || !it.parsed.rpid) return '';

  try {
    await markLibDeleted([it.parsed.rpid]);
    return '';
  } catch (e) {
    const m = '删除成功，但本地记录没能更新：' + ((e && e.message) || e);
    logError('  ！' + m);
    return m;
  }
}

export async function refreshBadge() {
  try { await chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }); } catch (e) { /* 后台可能刚好休眠 */ }
}

/**
 * 把已删除的 rpid 交回后台清索引。
 * 面板**刻意不做整体写回**：那会用打开面板时的旧快照，覆盖掉删除期间后台
 * 新记进来的条目，正是这一版要修掉的问题。所以这里只会重试消息，
 * 绝不能退化成整库覆盖写。
 */
export async function forgetRpids(rpids) {
  if (!rpids.length) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.runtime.sendMessage({ type: 'FORGET_RPIDS', rpids: rpids });
      return;
    } catch (e) {
      if (attempt < 2) await sleep(300 * (attempt + 1));
    }
  }

  // 实在联系不上就放弃。残留的索引项无害：删除时会按 rpid 扫书签目录，
  // 而且真删过的话接口会返回 12022，一样能归档。
  log('  ！后台没应答，索引里会留下几条失效记录（无副作用，可忽略）');
}

export async function start() {
  if (state.running) return;

  const targets = state.items.filter(i => i.checked && i.status !== 'done');
  if (!targets.length) { setHint('没有勾选任何可删除的评论。', 'warn'); return; }

  state.running = true;
  state.stopRequested = false;
  state.stats = { ok: 0, fail: 0, gone: 0 };
  setUi(true);
  syncCounts();
  updateProgress(0, targets.length);
  $('log').textContent = '';
  setHint('正在删除…这个面板别关。删除期间会复用一个 bilibili 标签页发请求。', '');
  setEta('');

  let tabId;
  try {
    tabId = await acquireWorkerTab();
    log('请求通道：标签页 #' + tabId);
    // 把那个标签页的地址和加载状态也记下来：万一自检还是过不去，
    // 有这两行就能判断是"挑错了标签页"还是"那个页面真的卡住了"
    try {
      const t = await withTimeout(chrome.tabs.get(tabId), 3000, null);
      if (t) log('  ' + (t.status || '?') + '　' + String(t.url || '').slice(0, 90));
    } catch (e) { /* 拿不到就算了 */ }
  } catch (e) {
    log('准备 bilibili 标签页失败：' + ((e && e.message) || e));
    setHint('打不开 bilibili 页面，删除已中止。请确认网络能访问 bilibili.com 后重试。', 'bad');
    state.running = false;
    setUi(false);
    return;
  }

  // 开工前自检：不然链子断了会演变成「一千多条各等 23 秒」，还看不出哪里坏了
  setHint('正在自检：确认能注入 bilibili 页面、能读到登录态…', '');
  let check = await preflight(tabId);

  // 注入不进去，多半是**那个标签页本身**有问题（后台标签页被冻结、一直没加载完）。
  // 与其让用户自己去刷新、再回来点一遍，不如自己换一个干净的标签页重试一次。
  if (!check.ok && (check.code === 'inject-timeout' || check.code === 'inject-failed')) {
    log('↻ ' + check.reason);
    log('  正在换一个干净的 bilibili 标签页重试…');
    try {
      tabId = await openWorkerTab();
      log('请求通道：标签页 #' + tabId);
      check = await preflight(tabId);
    } catch (e) {
      log('  换标签页也没成：' + ((e && e.message) || e));
    }
  }

  if (!check.ok) {
    logError('✗ 自检没通过：' + check.reason);
    setHint('删除没有开始。' + check.reason, 'bad');
    state.running = false;
    setUi(false);
    setEta('');
    return;
  }

  let aborted = false;
  let timeoutFails = 0;            // 连续「等不到页面回话」的条数
  const deletedRpids = [];         // 删成功的 rpid，交回后台标成"已删除"

  // 每条都要真调一次接口（删除接口本身就是"这条还在不在"的判据），
  // 所以先把预计耗时说清楚，别让人以为卡住了。
  const avgDelay = (Number(state.settings.minDelay) + Number(state.settings.maxDelay)) / 2;
  const estMin = Math.max(1, Math.round(targets.length * avgDelay / 60000));
  setEta(`预计约 ${estMin} 分钟`);
  log(`本次 ${targets.length} 条，每条之间等 ${state.settings.minDelay}~${state.settings.maxDelay} 毫秒，预计约 ${estMin} 分钟。`);
  log('中途可以点「停止」：已经处理过的会记账，下次不会重复处理。');

  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    if (state.stopRequested) { aborted = true; break; }

    it.status = 'working';
    it.note = '';
    renderRow(it);

    const t = await withTimeout(resolveTarget(it), 20000, { error: '定位这条评论超时（20 秒）' });
    let r = null;

    if (t.error) {
      it.status = 'failed';
      it.note = t.error;
      state.stats.fail++;
      logError('✗ ' + label(it) + ' → ' + t.error);
    } else {
      // 每条删除也带上限：一处 await 不 settle 不能把整轮拖死（这个坑真踩过）
      r = await withTimeout(attemptDelete(t), 30000,
        { ok: false, code: null, message: '这条处理超时（30 秒）' });

      if (r.code === -509) {
        log('  ↻ 触发风控限流（-509），等 15 秒后重试一次…');
        await sleep(15000);
        r = await withTimeout(attemptDelete(t), 30000,
          { ok: false, code: null, message: '这条重试也超时了（30 秒）' });
      }

      if (r.ok || r.code === 12022) {
        const moveErr = await archive(it);
        it.status = 'done';
        if (r.ok) {
          it.note = moveErr || '已删除';
        } else {
          state.stats.gone++;
          it.note = it.source === 'aicu'
            ? 'B 站上已经没有这条了'
            : (moveErr || '本来就不存在（已归档）');
        }
        state.stats.ok++;
        deletedRpids.push(t.rpid);
        log('✓ ' + label(it) + (r.ok ? ' 已删除' : ' 早就被删了'));
      } else {
        it.status = 'failed';
        it.note = explainCode(r.code, r.message);
        state.stats.fail++;
        logError('✗ ' + label(it) + ' 删除失败：code=' + r.code + ' ' + (r.message || ''));

        // 连续几条都等不到页面回话 —— 链路断了，别再一条条空等 23 秒
        if (/等待页面响应超时/.test(r.message || '')) {
          if (++timeoutFails >= 3) {
            setHint('连续 3 条都等不到 bilibili 页面回话。已中止 —— ' +
              '把那个 bilibili 标签页刷新一下（或关掉让扩展自己开一个）再重试。', 'bad');
            aborted = true;
            break;
          }
        } else {
          timeoutFails = 0;
        }
      }
    }

    renderRow(it);
    syncCounts();
    updateProgress(i + 1, targets.length);

    if (r && (r.code === -101 || r.code === -111)) {
      setHint('登录态异常（' + explainCode(r.code) + '），已自动停止。请重新登录 B 站后再来一次。', 'bad');
      aborted = true;
      break;
    }
    if (i % 10 === 0) {
      const leftMin = Math.round((targets.length - i - 1) * avgDelay / 60000);
      setEta(leftMin > 0
        ? `还剩约 ${leftMin} 分钟（${i + 1}/${targets.length}）`
        : `${i + 1}/${targets.length}`);
    }
    if (!state.stopRequested && i < targets.length - 1) await sleep(randInt(state.settings.minDelay, state.settings.maxDelay));
  }

  await forgetRpids(deletedRpids);

  // 注意：**不要**把删掉的条目从库里移除。
  // 收藏夹时代，"归档"是那条书签挪到「已删除评论」目录，所以导入清单可以清掉；
  // 现在书签没了，archive() 把条目留成 state='deleted' 就是那份账本 —— 清掉就等于账本丢了。
  await refreshBadge();

  if (state.workerCreated && state.workerTabId !== null) {
    try { await chrome.tabs.remove(state.workerTabId); } catch (e) { /* 忽略 */ }
    state.workerTabId = null;
    state.workerCreated = false;
    log('已关闭临时打开的后台标签页');
  }

  state.running = false;
  setUi(false);
  syncCounts();
  setEta('');
  await loadArchive();
  await loadAicu();

  const left = state.items.filter(i => i.status !== 'done').length;
  const goneText = state.stats.gone ? `，其中 ${state.stats.gone} 条 B 站上早就没有了` : '';
  if (state.stats.fail === 0 && !aborted) {
    setHint(`全部搞定：本次处理 ${state.stats.ok} 条${goneText}。删掉的条目留在库里，标成「已删除」当账本。队列里还剩 ${left} 条。`, '');
  } else {
    setHint(`本次成功 ${state.stats.ok} 条${goneText}，失败 ${state.stats.fail} 条。失败的条目仍然在库里里，日志里有原因，修好后可点「重试失败项」。`, 'warn');
  }
  log(`—— 结束：成功 ${state.stats.ok}（其中早就没有的 ${state.stats.gone} 条），失败 ${state.stats.fail}，列表剩余 ${left} ——`);
}

/** 删一条，并把「连标签页都拿不到」这种情况收敛成一条失败原因，不让它掀翻整个循环 */
export async function attemptDelete(target) {
  try {
    return await deleteWithRecovery(target);
  } catch (e) {
    return { ok: false, code: null, message: '打不开 bilibili 标签页：' + ((e && e.message) || e) };
  }
}

/* ----------------------------------------------------- 本模块的常量 */

/**
 * 单条删除的总超时（毫秒）。
 * 用 `var` 是故意的：它会挂到全局对象上，测试里可以调小它来验证「超时后给出可读原因」，
 * 否则那一条用例要真等 23 秒。生产代码只读不写。
 */
var BC_DELETE_TIMEOUT_MS = 23000;

/** 自检里等「兜底通道回话」的时长；同样用 var 方便测试调小。 */
var BC_PREFLIGHT_MS = 6000;

export const label = it => sourceLabel(it.parsed.pageUrl) + '#reply' + it.parsed.rpid;
