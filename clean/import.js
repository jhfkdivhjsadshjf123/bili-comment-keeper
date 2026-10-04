/**
 * aicu 历史评论的导入与自动翻页
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { start } from './delete.js';
import { $ } from './dom.js';
import { refreshLibrary, render } from './library.js';
import { probePlan } from './probe-plan.js';
import { state } from './state.js';
import { getLibrary, isDeletable, listLibItems, removeLibItems } from '../src/store.js';
import { aicuPageUrl, aicuTypeName, fmtTime } from '../src/urls.js';
import { sleep } from '../src/util.js';

export function setAicuHint(text, kind) {
  const el = $('aicu-hint');
  el.className = 'hint' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

/** 把一条 aicu 记录转成待删列表里的行 */
export function aicuRow(item) {
  const pageUrl = aicuPageUrl(item.type, item.oid);
  const text = String(item.message || '').replace(/\s+/g, ' ').trim();
  const when = item.ctime ? fmtTime(item.ctime * 1000) : '时间未知';
  const excerpt = text ? (text.length > 24 ? text.slice(0, 24) + '…' : text) : '评论';

  return {
    id: 'aicu:' + item.rpid,
    source: 'aicu',
    type: Number(item.type),
    oid: String(item.oid),
    title: `[${when}] ${aicuTypeName(item.type)} · ${excerpt}`,
    url: pageUrl,
    parsed: {
      url: pageUrl,
      rpid: item.rpid,
      rootId: item.root || item.rpid,
      secondaryId: '',
      isSecondary: Number(item.rank) !== 1,
      bvid: '',
      pageUrl: pageUrl
    },
    checked: true,
    status: 'idle',
    note: ''
  };
}

export async function loadAicu() {
  if (!state.settings) return;   // 初始化还没走完

  const store = await getLibrary();
  const list = await listLibItems();
  const merged = state.items.filter(i => i.source === 'aicu').length;

  $('aicu-count').textContent = String(list.length);

  $('aicu-uid').textContent = store.uid
    ? ('UID ' + store.uid + (store.total ? ' · 站上记着 ' + store.total + ' 条' : ''))
    : '';

  const notes = [];
  if (!list.length) {
    notes.push('还没有导入。打开 https://www.aicu.cc/reply?uid=你的UID 之后，' +
      '点「自动翻页抓取」让它替你翻，或者点「读当前页」只把眼前这页捞进来。');
  } else {
    const aliveN = list.filter(i => i.state === 'live').length;
    const goneN = list.filter(i => i.state === 'gone').length;
    const untestedN = list.length - aliveN - goneN;

    notes.push(`共 ${list.length} 条，其中 ${merged} 条已加入待删列表。`);
    if (aliveN || goneN) {
      notes.push(`存活探测：还在 ${aliveN} 条，已经没了 ${goneN} 条` +
        (untestedN ? `，还没探过 ${untestedN} 条。` : '。'));
    } else {
      notes.push(`${untestedN} 条都还没探测过存活 —— 点「探测存活」可以先筛掉早就删掉的那些，` +
        '不然要一条条去问 B 站，很慢。');
    }
    notes.push('提醒：aicu.cc 只是索引，删除发生在 B 站；已删评论也可能仍留在它的存档里。');
  }
  if (store.uid) {
    notes.push('这个库绑定的是 UID ' + store.uid + '（你自己的账号）。');
    if (Array.isArray(store.altUids) && store.altUids.length) {
      notes.push('另外认了 ' + store.altUids.length + ' 个小号：' + store.altUids.join('、') + '。');
    }
    notes.push('换成别的 UID 抓到的数据会先问你是不是小号 —— 答"不是"就一条都不导入。');
  } else {
    notes.push('还没认出你的 UID。最简单的办法：开着登录态去 bilibili.com 随便逛一下，' +
      '扩展会自动读出来（B 站的登录态里就带着 UID）。\n' +
      '实在读不到，就在下面手动填。为什么要认这个：aicu 的地址把 uid 一换读到的就是别人的评论。');
  }

  // 没设 UID 就把输入框亮出来
  $('uid-setup').classList.toggle('hide', !!store.uid);
  $('uid-setup-desc').classList.toggle('hide', !!store.uid);
  if (store.uid) $('uid-input').value = store.uid;

  setAicuHint(notes.join(' '), store.uid ? '' : 'warn');

  // 这个折叠区现在只管"抓取"，列表本身已经在上面那个库视图里了 ——
  // 两边都画一遍只会让人分不清哪个才是真的，所以这里只留一句指向。
  $('aicu-list').innerHTML = list.length
    ? `<div class="empty" style="padding:10px 13px">这 ${list.length} 条都在上面的评论库里，` +
      '用搜索和筛选看它们。这里只负责把它们抓下来。</div>'
    : '<div class="empty" style="padding:10px 13px">还没有从 aicu.cc 抓到任何评论。</div>';

  await refreshLibrary();
}

/** 库里已经删过的 rpid —— 别再浪费一次接口调用 */
export async function archivedRpids() {
  const set = new Set();
  const lib = await getLibrary();
  for (const k of Object.keys(lib.items)) {
    if (lib.items[k].state === 'deleted') set.add(k);
  }
  return set;
}

/** 把整个导入清单并进待删列表（按 rpid 去重，已删过的不再放回） */
export async function mergeAicu() {
  const list = await listLibItems();
  if (!list.length) {
    setAicuHint('清单是空的。先去 aicu.cc 打开你自己的评论页翻几页，再回来。', 'warn');
    return;
  }
  if (state.running) return;

  const known = new Set();
  for (const i of state.items) if (i.parsed && i.parsed.rpid) known.add(i.parsed.rpid);

  const archived = await archivedRpids();
  let added = 0, skipped = 0, alreadyGone = 0, probedGone = 0, probedDeleted = 0, untested = 0;

  for (const item of list) {
    if (known.has(item.rpid)) { skipped++; continue; }
    // 已经没了的 / 我们自己删过的，都不该再进队列 —— 为它们发请求只会白拿一个 12022。
    // 这里必须看 state 而不是老的 alive：alive 对 deleted 是 undefined，会漏网。
    if (item.state === 'gone') { probedGone++; continue; }
    if (item.state === 'deleted') { probedDeleted++; continue; }
    if (!isDeletable(item.state)) { probedGone++; continue; }
    if (archived.has(item.rpid)) { alreadyGone++; continue; }
    if (item.state === 'unknown') untested++;
    state.items.push(aicuRow(item));
    known.add(item.rpid);
    added++;
  }

  render();
  const parts = [];
  if (skipped) parts.push(`${skipped} 条已在列表里`);
  if (probedGone) parts.push(`${probedGone} 条探测过、确认已经没了，跳过`);
  if (probedDeleted) parts.push(`${probedDeleted} 条是之前删过的，跳过`);
  if (alreadyGone) parts.push(`${alreadyGone} 条已在「已删除记录」里，跳过`);
  const tail = parts.length ? `（${parts.join('，')}）` : '';
  const warn = untested ? `　注意：其中 ${untested} 条还没探测过存活，` +
    '想先筛掉已经删掉的，点「巡检存活」。' : '';
  setAicuHint(`已加入 ${added} 条${tail}。${warn}后点「开始删除」即可。`, added ? '' : 'warn');
  await loadAicu();
}

export function scheduleAicuRender() {
  if (state.aicuRenderTimer) return;
  state.aicuRenderTimer = setTimeout(function () {
    state.aicuRenderTimer = null;
    loadAicu().catch(function () {});
  }, 1500);
}

export function setAicuAuto(on) {
  state.autoRunning = !!on;
  refreshAicuButtons();
}

export function setAicuProbing(on) {
  state.probing = !!on;
  refreshAicuButtons();
}

/**
 * 抓取/探测期间，这几个按钮统一收起或禁用，避免两件事互相干扰。
 *
 * 巡检按钮还要看**当前选中的筛选**：范围由 probePlan() 决定，
 * 和真正开跑时用的是同一条规则（见 probe.js），不会各说各话。
 */
export function refreshAicuButtons() {
  const busy = state.autoRunning || state.probing || state.running;
  const plan = probePlan();

  $('btn-aicu-auto').classList.toggle('hide', state.autoRunning || state.probing);
  $('btn-aicu-probe').classList.toggle('hide', state.autoRunning || state.probing);
  $('btn-aicu-autostop').classList.toggle('hide', !(state.autoRunning || state.probing));

  const probe = $('btn-aicu-probe');
  if (probe) {
    // 「已没了」「已删除」的结论是确定的，没什么可再查的 —— 灰掉并说明原因
    probe.disabled = busy || !plan.ok;
    probe.textContent = plan.label;
    probe.title = plan.ok
      ? `检查当前筛选下可查的 ${plan.states.length} 类条目`
      : '当前筛选的结论已经确定，没有再查的必要';
  }

  for (const id of ['btn-aicu-read', 'btn-aicu-merge', 'btn-aicu-clear', 'btn-aicu-prune']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
}

/** 把「已确认没了」的条目从库里删掉，只留活着的 */
export async function pruneDeadAicu() {
  if (state.running || state.probing || state.autoRunning) return;

  const list = await listLibItems();
  const dead = list.filter(i => i.state === 'gone');
  if (!dead.length) {
    setAicuHint('没有「已确认没了」的条目要清。先点「巡检存活」筛一遍。', 'warn');
    return;
  }

  await removeLibItems(dead.map(i => i.rpid));
  await loadAicu();
  setAicuHint(`已经清掉 ${dead.length} 条确认没了的，清单里只剩 ${list.length - dead.length} 条。`, '');
}

/** 找一个已打开的 aicu.cc 标签页；没有就按已知 UID 开一个后台标签页 */
export async function findAicuTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.aicu.cc/*', 'https://aicu.cc/*'] });
  const usable = tabs.find(t => t.id !== undefined && t.id !== null && !t.discarded);
  if (usable) return usable;

  const store = await getLibrary();
  if (!store.uid) return null;

  const tab = await chrome.tabs.create({
    url: 'https://www.aicu.cc/reply?uid=' + encodeURIComponent(store.uid),
    active: false
  });
  await waitTabComplete(tab.id, 25000);
  return tab;
}

/** 内容脚本可能还没注入（刚打开的页面），重试几次再放弃 */
export async function sendToAicuTab(tabId, payload) {
  for (let i = 0; i < 6; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'AICU_AUTOPAGE_CMD', payload: payload });
      return true;
    } catch (e) {
      await sleep(700);
    }
  }
  return false;
}

/**
 * 只让 aicu 页面把**当前这一页**已经渲染出来的评论读一遍，不翻页。
 *
 * 这是导入失灵时最重要的逃生口：它走的是「直接读渲染结果」那条路，
 * 完全不依赖「挂钩页面请求」——所以页面明明有评论、导入却一直是 0 的时候，
 * 点它基本都能立刻把数据捞回来。
 */
export async function readCurrentAicuPage() {
  let tab = null;
  try { tab = await findAicuTab(); } catch (e) { /* 下面统一报 */ }

  if (!tab) {
    setAicuHint('没找到已打开的 aicu.cc 页面。先打开你自己的评论页（网址里带 uid=），再点这个按钮。', 'warn');
    return;
  }

  const ok = await sendToAicuTab(tab.id, { action: 'harvest-once' });
  if (!ok) {
    setAicuHint('联系不上 aicu 页面里的脚本。把那个页面刷新一下（F5）再点 —— ' +
      '最常见的原因是这个标签页在装/更新扩展之前就开着。', 'bad');
    return;
  }
  setAicuHint('已经让 aicu 页面把当前这页的评论读一遍了，稍等一下…', '');
}

export async function startAutoPage() {  if (state.autoRunning) return;
  if (state.running) { setAicuHint('正在删评论，等这一轮结束再抓取。', 'warn'); return; }

  let tab = null;
  try {
    tab = await findAicuTab();
  } catch (e) {
    setAicuHint('打开 aicu.cc 页面失败：' + ((e && e.message) || e), 'bad');
    return;
  }

  if (!tab) {
    setAicuHint('没找到已打开的 aicu.cc 页面，也还不知道你的 UID。' +
      '请先手动打开 https://www.aicu.cc/reply?uid=你的UID 并翻一下，再回来点这个按钮。', 'warn');
    return;
  }

  setAicuAuto(true);
  setAicuHint('正在让 aicu.cc 页面自动翻页……（就是替你点页面上的「下一页」，不会多发任何请求）', '');

  const ok = await sendToAicuTab(tab.id, { action: 'autopage-start', maxPages: 300, gapMs: 1200 });
  if (!ok) {
    setAicuAuto(false);
    setAicuHint('联系不上 aicu 页面里的脚本。把那个页面刷新一下（F5）再试。', 'bad');
  }
}

export function stopAutoPage() {
  // 探测是本地循环，置个标志就行
  if (state.probing) {
    state.probeStop = true;
    setAicuHint('正在停止探测……当前这一条问完就停。已经探过的都记住了。', 'warn');
    return;
  }
  if (!state.autoRunning) return;
  setAicuHint('正在停止……当前这一页处理完就停。', 'warn');

  chrome.tabs.query({ url: ['https://*.aicu.cc/*', 'https://aicu.cc/*'] }).then(function (tabs) {
    for (const t of tabs) {
      if (t.id === undefined || t.id === null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'AICU_AUTOPAGE_CMD', payload: { action: 'autopage-stop' } })
        .catch(function () { /* 页面没了就算了 */ });
    }
  }).catch(function () { /* 忽略 */ });

  // 万一页面已经关了、回话回不来，别让按钮永远卡在「停止抓取」
  setTimeout(function () {
    if (state.autoRunning) {
      setAicuAuto(false);
      setAicuHint('已停止（没等到页面回话，直接放开了）。导入到的东西都已经存下来了。', 'warn');
      loadAicu().catch(function () {});
    }
  }, 8000);
}

/* ----------------------------------------------------- 本模块的常量 */

export const AICU_RENDER_LIMIT = 200;
