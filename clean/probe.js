/**
 * 存活巡检：判定逻辑 + 取数据
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { acquireWorkerTab, mainWorldFetchReply, runInjected, withTimeout } from './delete.js';
import { $, log } from './dom.js';
import { loadAicu, setAicuHint, setAicuProbing } from './import.js';
import { refreshLibrary } from './library.js';
import { probePlan } from './probe-plan.js';
import { state } from './state.js';
import { listLibItems, setLibStates } from '../src/store.js';
import { sleep } from '../src/util.js';

/**
 * 只读地探测，把结论记下来。
 *
 * 这是这个功能最实用的一步：aicu 的清单里**绝大多数是早就删掉的评论**，
 * 全导进待删列表就要花几十分钟一条条去问 B 站。先探一遍，只剩真正要处理的。
 *
 * 全程只发 GET（`/x/v2/reply/reply`），不碰删除接口 —— 探测本身不会改变任何东西。
 */
export async function probeAicuAlive() {
  if (state.probing || state.autoRunning || state.running) return;

  const plan = probePlan();
  if (!plan.ok) { setAicuHint('没有可检查的条目。' + plan.why, 'warn'); return; }

  const all = await listLibItems();
  const todo = all.filter(i => plan.states.includes(i.state));
  if (!all.length) {
    setAicuHint('评论库是空的。先去「导入历史」抓一批，或者去 B 站发一条评论。', 'warn');
    return;
  }
  if (!todo.length) {
    setAicuHint('当前筛选下没有需要检查的条目。换个筛选（比如「未检查」「已检查」）再点。', '');
    return;
  }

  setAicuProbing(true);
  state.probeStop = false;

  // 不预先开标签页、也不做登录自检：
  // 探测的接口是公开只读的（不需要登录），而且优先让扩展自己直发 ——
  // 只有直发被反爬拦了才会去借 bilibili 标签页，那一步由取数据的地方按需触发。
  // 先单独试一条。
  //
  // **只有"链路本身不通"才中止整轮**。单条问不出结果是这一条的事 ——
  // 比如它的页面评论功能关了、视频不可访问，这些都是**合法的结论**，
  // 不该因此让整个按钮从此点不动。
  // （踩过的坑：待检查列表最前面几条恰好都是"评论功能已关闭"，于是每次点按钮
  //   都只跑完试运行就放弃，看起来就是"按键失效"。）
  const firstTry = await withTimeout(checkAliveOne(todo[0]), 20000,
    { state: 'unknown', alive: null, message: '第一条就超时（20 秒）', transport: true });

  const stateText0 = {
    live: '还在', gone: '已经没了', unreachable: '查不到', unknown: '没问出结果'
  }[firstTry.state] || '没问出结果';

  log(`探测试运行：第 1 条 rpid ${todo[0].rpid} → ${stateText0}` +
    (firstTry.message ? '（' + firstTry.message + '）' : ''));

  if (firstTry.transport) {
    setAicuProbing(false);
    setAicuHint('探测没有开始：取数据的链路不通。' + (firstTry.message || '') +
      '　把 bilibili 标签页刷新一下（F5）再试，或者先随便打开一个 bilibili 页面。', 'bad');
    return;
  }

  const estMin = Math.max(1, Math.round(todo.length * BC_PROBE_DELAY_MS / 60000));
  setAicuHint(`正在只读探测存活：本次 ${todo.length} 条，预计约 ${estMin} 分钟。` +
    '这不会删任何东西，只是问 B 站「这条还在不在」。中途可以点「停止」，测过的会记住。', '');

  let alive = 0, gone = 0, unknown = 0, unreachable = 0, errStreak = 0;
  const marks = {};

  const flush = async function () {
    if (!Object.keys(marks).length) return;
    await setLibStates(marks);
    for (const k of Object.keys(marks)) delete marks[k];
  };

  // 进度条 + 列表即时刷新：不这样，巡检时界面是死的，看不出在动
  const bar = $('probe-bar');
  const inner = $('probe-progress');
  if (bar) bar.classList.remove('hide');
  const setBar = (done, total) => {
    if (inner) inner.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  };
  setBar(0, todo.length);

  let lastPaint = 0;

  for (let i = 0; i < todo.length; i++) {
    if (state.probeStop) break;

    const it = todo[i];
    const startedAt = Date.now();

    // 每条都带上限。外层再兜一层，是为了"就算 checkAliveOne 本身出了意料之外的问题，
    // 循环也一定能往下走" —— 这个功能已经因为一处不 settle 的 await 卡死过一次了。
    let r = { state: 'unknown', alive: null, message: '内部超时' };
    try {
      r = await withTimeout(checkAliveOne(it), 40000,
        { state: 'unknown', alive: null, message: '这条探测超时（40 秒）' });
    } catch (e) {
      r = { state: 'unknown', alive: null, message: '探测出错：' + ((e && e.message) || e) };
    }

    const took = Date.now() - startedAt;
    const nextState = r.state || (r.alive === true ? 'live' : r.alive === false ? 'gone' : 'unknown');
    // 原因一律记下来 —— 光显示"未检查"，事后根本没法排查
    marks[it.rpid] = { state: nextState, note: r.message || '' };

    if (nextState === 'live') { alive++; errStreak = 0; }
    else if (nextState === 'gone') { gone++; errStreak = 0; }
    else if (nextState === 'unreachable') { unreachable++; errStreak = 0; }
    else {
      unknown++;
      log(`探测 ${i + 1}/${todo.length} rpid ${it.rpid}：没问出结果（${took} 毫秒，${r.message || '无说明'}）`);
      // 连续问不出结果，多半是触发风控了，歇一会儿
      if (++errStreak >= 3) {
        errStreak = 0;
        setAicuHint('连续几次没问出结果，歇 15 秒再继续（多半是触发了风控）…', 'warn');
        await sleep(15000);
      }
    }

    setBar(i + 1, todo.length);
    await flush();

    // 列表每 1.5 秒重画一次就够了 —— 每条都重画会把滚动位置晃得没法看
    if (Date.now() - lastPaint > 1500 || i === todo.length - 1) {
      lastPaint = Date.now();
      await refreshLibrary();
    }

    setAicuHint(`探测中 ${i + 1}/${todo.length}（${Math.round((i + 1) / todo.length * 100)}%，` +
      `上一条 ${took} 毫秒）—— 还在 ${alive}，已经没了 ${gone}，查不到 ${unreachable}，` +
      `没问出结果 ${unknown}。`, '');

    if (i < todo.length - 1) await sleep(BC_PROBE_DELAY_MS);
  }

  await flush();
  setAicuProbing(false);
  if (bar) bar.classList.add('hide');
  await loadAicu();

  const tail = state.probeStop ? '　（你让它停了，下次会接着探剩下的）' : '';
  setAicuHint(`探测结束：还在 ${alive} 条，已经没了 ${gone} 条，查不到 ${unreachable} 条，` +
    `没问出结果 ${unknown} 条。` +
    `「加入待删列表」只会收下还活着的那些。${tail}`, 'warn');
}

/** 拼出 /x/v2/reply/reply 的地址 */
export function buildReplyUrl(arg) {
  return 'https://api.bilibili.com/x/v2/reply/reply?type=' + encodeURIComponent(String(arg.type)) +
    '&oid=' + encodeURIComponent(String(arg.oid)) +
    '&root=' + encodeURIComponent(String(arg.root)) +
    '&pn=' + encodeURIComponent(String(arg.pn || 1)) +
    '&ps=' + encodeURIComponent(String(arg.ps || 1));
}

export function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

export function interpretReplyCheck(json) {
  if (!json || typeof json.code !== 'number') {
    return { alive: null, message: '接口返回的不是数据（多半被反爬拦了）' };
  }
  if (json.code === 12006) {
    return { alive: false, code: 12006, message: json.message || '没有该评论' };
  }
  // -404「啥都木有」：视频本身访问不到（被设成仅UP主可见、已下架之类）。
  // 这时候**查不到 ≠ 评论没了**，所以单独归一类，不能混进"未检查"里让人看不出原因。
  if (json.code === -404) {
    return {
      alive: null, unreachable: true, code: -404,
      message: '视频/评论区访问不到（' + (json.message || '啥都木有') + '），没法确认这条还在不在'
    };
  }
  // UP 主关掉了这个页面的评论区。评论可能还在，只是这个入口查不到 —— 同样不能当它没了。
  if (json.code === 12061 || COMMENT_CLOSED_RE.test(String(json.message || ''))) {
    return {
      alive: null, unreachable: true, code: json.code,
      message: '这个页面的评论功能已经关闭（' + (json.message || '') + '），没法确认这条还在不在'
    };
  }
  if (json.code !== 0) {
    return { alive: null, code: json.code, message: json.message || '' };
  }
  const root = json.data && json.data.root;
  if (!root) {
    return { alive: false, code: 0, message: '会话还在，但这条评论已经不在了' };
  }
  return { alive: true, code: 0, message: '', rootRpid: String(root.rpid) };
}

/**
 * 拿一个 B 站接口的原始返回。两条路：
 *
 *   ① **扩展自己直发**：查询评论的接口是公开只读的，不需要登录、不需要 cookie，
 *      所以理论上扩展自己就能问，而且快得多、不用开标签页。
 *   ② **借一个 bilibili 标签页发**：实测扩展发的请求会带上
 *      `Origin: chrome-extension://…`，B 站反爬这种情况下会回 HTML 而不是 JSON；
 *      从 B 站页面里发（同站、不带 Origin）才是稳定可用的那条。
 *
 * 先试 ①，被拦了就永久切到 ② —— 不会比只有 ② 更差，而 ① 通的话会快很多。
 */
export async function fetchBiliJson(url) {
  if (state.probeDirectWorks !== false) {
    try {
      const res = await withTimeout(fetch(url, { credentials: 'omit' }), 12000, null);
      if (res) {
        const text = await res.text().catch(() => '');
        const json = safeJson(text);
        if (json && typeof json.code === 'number') {
          if (state.probeDirectWorks === null) {
            state.probeDirectWorks = true;
            log('取数通道：扩展直接发就行（更快，也不用开标签页）');
          }
          return { json: json };
        }
        state.probeDirectWorks = false;
        log('取数通道：扩展直接发被拦了（HTTP ' + res.status + '），改用 bilibili 标签页。');
      } else {
        state.probeDirectWorks = false;
        log('取数通道：扩展直接发超时，改用 bilibili 标签页。');
      }
    } catch (e) {
      state.probeDirectWorks = false;
      log('取数通道：扩展直接发失败（' + ((e && e.message) || e) + '），改用 bilibili 标签页。');
    }
  }

  // 路 ②：借 bilibili 标签页发
  let tabId = null;
  try {
    tabId = await withTimeout(acquireWorkerTab(), 20000, null);
  } catch (e) { tabId = null; }
  if (!tabId) return { error: '打不开 bilibili 标签页' };

  const r = await runInjected(tabId, mainWorldFetchReply, { url: url }, 12000, 'MAIN');

  if (r.tabGone) {
    state.workerTabId = null;
    state.workerCreated = false;
    return { error: r.message || 'bilibili 标签页失效' };
  }
  if (!r.ok) return { error: r.message || '页面里没取到数据' };

  const json = safeJson(r.text);
  if (!json) {
    return { error: '页面取回的是网页而不是数据（HTTP ' + r.status + '），可能被反爬拦了' };
  }
  return { json: json };
}

/** 按 /x/v2/reply/reply 的参数取一次 */
export async function fetchReplyRaw(arg) {
  return await fetchBiliJson(buildReplyUrl(arg));
}

/** 取会话的一页；返回 { list, count } 或 { error } */
export async function fetchThreadPage(item, rootId, pn) {
  const r = await fetchReplyRaw({
    type: item.type, oid: item.oid, root: rootId, pn: pn, ps: THREAD_PAGE_SIZE
  });
  if (r.error) return { error: r.error };

  const j = r.json;
  if (!j || j.code !== 0) {
    return { error: (j && j.message) || '会话没返回数据', code: j && j.code };
  }
  return {
    list: (j.data && j.data.replies) || [],
    count: (j.data && j.data.page && j.data.page.count) || 0
  };
}

/**
 * 在一条会话里找出"本人"。
 *
 * 会话列表**按时间升序**（实测过），而我们手上有这条评论的 ctime ——
 * 所以不需要一页页翻，**按时间二分定位到具体哪一页**就行：
 * 一千条的会话也只要约 6 次请求，而不是 50 次。
 *
 * 以前这里写 `ps=49` 并且用 `pn*49 >= count` 判断"翻完了"，是错的 ——
 * B 站默默只给 20 条，所以实际只翻了 60 条就以为翻完了整条会话，
 * 长会话里的楼中楼于是全被误判成"未检查"。
 */
export async function findInThread(item, rootId) {
  const first = await fetchThreadPage(item, rootId, 1);
  if (first.error) return { alive: null, message: first.error };

  const has = list => list.some(x => String(x.rpid) === String(item.rpid));
  const pages = Math.max(1, Math.ceil(first.count / THREAD_PAGE_SIZE));

  if (has(first.list)) return { alive: true, message: '' };
  if (pages === 1) {
    return { alive: false, message: '整条会话只有这一页，里面没有它' };
  }

  const target = Number(item.ctime) || 0;
  if (!target) {
    return { alive: null, message: '这条没有时间，没法在长会话里定位它' };
  }

  const seen = { 1: first };
  const take = async pn => {
    if (seen[pn]) return seen[pn];
    const r = await fetchThreadPage(item, rootId, pn);
    if (!r.error) seen[pn] = r;
    return r;
  };

  let lo = 1, hi = pages, landed = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const page = await take(mid);
    if (page.error) return { alive: null, message: page.error };
    if (has(page.list)) return { alive: true, message: '' };

    const times = page.list.map(x => Number(x.ctime) || 0).filter(Boolean);
    if (!times.length) break;

    const t0 = times[0], t1 = times[times.length - 1];
    if (target < t0) hi = mid - 1;
    else if (target > t1) lo = mid + 1;
    else { landed = mid; break; }
  }

  // 时间正好落在两页之间（比如这条已经被删、时间戳留下了空档），
  // 就用二分收敛出的插入位置当落点，再看一眼左右邻居。
  if (landed === null) {
    landed = Math.min(Math.max(lo, 1), pages);
    for (const pn of [landed - 1, landed]) {
      if (pn < 1 || pn > pages) continue;
      const page = await take(pn);
      if (page.error) return { alive: null, message: page.error };
      if (has(page.list)) return { alive: true, message: '' };
    }
    return { alive: null, message: '按时间没能定位到它（时间可能有偏差），没敢下结论' };
  }

  for (const pn of [landed - 1, landed + 1]) {
    if (pn < 1 || pn > pages) continue;
    const page = await take(pn);
    if (page.error) return { alive: null, message: page.error };
    if (has(page.list)) return { alive: true, message: '' };
  }

  return { alive: false, message: '会话里已经没有它了（按时间定位到第 ' + landed + ' 页，那一带没有）' };
}

/**
 * 判断一条评论还在不在。
 *
 * 返回 { state, alive, message, transport }：
 *   state     四态里的一种（含查不到）
 *   alive     给老调用方的兼容字段
 *   transport **是不是"链路本身不通"**（取数失败/被拦/超时），
 *             而不是"接口答了但答不出结论"。这两者要分开：
 *             单条问不出结果是这一条的事，链路不通才是整轮该停的理由。
 */
export async function checkAliveOne(item) {
  const done = a => ({
    state: a.unreachable ? 'unreachable'
      : a.alive === true ? 'live'
        : a.alive === false ? 'gone' : 'unknown',
    alive: a.alive === undefined ? null : a.alive,
    message: a.message || ''
  });

  const first = await fetchReplyRaw({ type: item.type, oid: item.oid, root: item.rpid, pn: 1, ps: 1 });
  if (first.error) {
    return Object.assign(done({ alive: null, message: first.error }), { transport: true });
  }

  const a = interpretReplyCheck(first.json);
  if (a.alive !== true) return done(a);

  // 一级评论：B 站返回的 root 就是它自己
  if (a.rootRpid === String(item.rpid)) return done({ alive: true, message: '' });

  // 楼中楼：B 站把我们解析到了所属的根评论，得去会话里把本人找出来
  return done(await findInThread(item, a.rootRpid));
}

/* ----------------------------------------------------- 本模块的常量 */

/**
 * 存活探测每条之间的间隔。
 * 比删除的 1.5~4 秒短得多 —— 因为探测是**只读 GET**，不是写操作，
 * 对风控的压力小一个量级。（真被限流了会自动歇 15 秒再继续。）
 */
const BC_PROBE_DELAY_MS = 350;

/**
 * 解读 /x/v2/reply/reply 的返回。
 *
 * 用真实数据实测过（含用户提供的两个样本）：
 *   还在       → code 0，data.root 有值
 *   已经没了   → code 12006「没有该评论」
 *   风控/其它  → 一律"不确定"，绝不误判成已删除
 *
 * 返回 { alive: true|false|null, code, message, rootRpid }
 * 注意 alive=true 时还要看 rootRpid 是不是等于被查的那条 —— 不等于说明这是
 * **楼中楼**，B 站把我们解析到了所属的根评论，还得再去会话里确认本人。
 */
/** 「这个页面的评论功能已经关了」的各种说法 —— 按 code 按文案都认一下 */
const COMMENT_CLOSED_RE = /评论功能已关闭|评论区已关闭|评论已关闭|comment.{0,4}clos/i;

/**
 * 判断一条评论还在不在。返回 { alive: true|false|null, message }
 *
 * 楼中楼那一步是重点：把二级评论的 rpid 当 root 去查时，B 站会把它解析到所属的
 * 根评论、照样返回 code 0 —— 光看 code 会把已删的楼中楼误判成还在。
 * 所以这种情况必须再去那条会话的回复列表里把**它本人**找出来，找到才算活着。
 */
/** B 站把楼中楼每页硬限制在 20 条 —— 写 ps=49 它也只给 20，别被这个骗了 */
const THREAD_PAGE_SIZE = 20;
