/**
 * 评论库视图与删除队列
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { refreshBadge, start } from './delete.js';
import { $, log, setHint } from './dom.js';
import { aicuRow, refreshAicuButtons } from './import.js';
import { state } from './state.js';
import { getLibItems, getLibrary, isDeletable, libraryStats, queryLib, removeLibItems } from '../src/store.js';
import { aicuCommentUrl, aicuSubUrl, aicuTypeName, fmtTime, sourceLabel } from '../src/urls.js';
import { escapeHtml } from '../src/util.js';

/**
 * 「已删除记录」现在直接读库里 state === 'deleted' 的条目。
 * 以前这里是浏览器收藏夹里那个「B站已删除评论」目录 —— 收藏夹已经淘汰了，
 * 数据只有库这一份。
 */
export async function loadArchive() {
  const lib = await getLibrary();
  const list = Object.keys(lib.items)
    .map(k => lib.items[k])
    .filter(it => it.state === 'deleted')
    .sort((a, b) => (b.deletedAt || b.ctime) - (a.deletedAt || a.ctime));

  $('arc-count').textContent = String(list.length);
  $('arc-path').textContent = '这些是已经删掉的评论，记录留在本地库里，方便你事后核对。';

  $('arc-list').innerHTML = list.length
    ? list.map(function (it) {
        const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
        const text = String(it.message || '').replace(/\s+/g, ' ').trim() || '（没有正文）';
        const url = aicuCommentUrl(it);
        return `<div class="arc-item" title="${escapeHtml(text)}">• ` +
          `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">[${escapeHtml(when)}] ` +
          `${escapeHtml(text.slice(0, 40))}</a></div>`;
      }).join('')
    : '<div class="empty" style="padding:10px 13px">还没有删除记录。删掉的评论会在这里留一条账。</div>';
}

export function setPurgeConfirm(on) {
  if (state.purgeTimer) { clearTimeout(state.purgeTimer); state.purgeTimer = null; }
  $('purge-confirm').classList.toggle('hide', !on);
  $('btn-purge').classList.toggle('hide', on);
  if (on) state.purgeTimer = setTimeout(function () { setPurgeConfirm(false); }, 8000);
}

/** 把「已删除记录」清掉 —— 也就是把库里那些标成 deleted 的条目真正删掉 */
export async function purgeArchive() {
  setPurgeConfirm(false);

  const lib = await getLibrary();
  const dead = Object.keys(lib.items).filter(k => lib.items[k].state === 'deleted');
  if (!dead.length) { setHint('「已删除记录」本来就是空的。', 'warn'); return; }

  $('btn-purge').disabled = true;
  await removeLibItems(dead);
  await loadArchive();
  await refreshLibrary();
  await refreshBadge();
  $('btn-purge').disabled = false;

  log(`已清空「已删除记录」，共移除 ${dead.length} 条`);
  setHint(`已清空「已删除记录」，移除 ${dead.length} 条。此操作不可恢复。`, '');
}

/**
 * 刷新删除队列。
 *
 * 队列现在是**显式**的：从库里勾选之后点「删除选中」才会进来，
 * 不再像以前那样开机就自动把书签目录里的东西全灌进来。
 * 这个按钮的作用是「把已经处理完的从队列里摘掉」，并且把入口指清楚。
 */
export async function reload() {
  const before = state.items.length;
  state.items = state.items.filter(i => i.status !== 'done');
  state.stats = { ok: 0, fail: 0, gone: 0 };
  render();
  setHint(before === state.items.length
    ? '队列没有变化。要删什么，在上面评论库里勾选后点「删除选中」。'
    : `已从队列里移走 ${before - state.items.length} 条处理完的。`, '');
}

export function stText(it) {
  if (it.status === 'done') return it.note || '已删除';
  if (it.status === 'failed') return it.note || '失败';
  return it.status === 'working' ? '删除中…' : '';
}

/** 当前来源筛选下应该显示的条目 */
export function visibleItems() {
  if (state.sourceFilter === 'all') return state.items;
  const wantAicu = state.sourceFilter === 'aicu';
  return state.items.filter(i => (i.source === 'aicu') === wantAicu);
}

/** 筛选栏只在初始化时建一次，之后只更新数字，避免每删一条都重建 DOM */
export function buildFilters() {
  $('filters').innerHTML = ['all', 'bookmark', 'aicu'].map(k =>
    `<button class="chip" data-src="${k}">${FILTER_LABEL[k]} <b>0</b></button>`
  ).join('');
}

export function renderFilters() {
  const counts = { all: 0, bookmark: 0, aicu: 0 };
  for (const i of state.items) {
    if (i.status === 'done') continue;
    counts.all++;
    counts[i.source === 'aicu' ? 'aicu' : 'bookmark']++;
  }
  for (const btn of $('filters').querySelectorAll('.chip')) {
    const k = btn.dataset.src;
    btn.querySelector('b').textContent = counts[k];
    btn.classList.toggle('on', k === state.sourceFilter);
  }
}

export function rowHtml(it) {
  const cls = STATE_CLS[it.status] || '';
  const kind = it.parsed.isSecondary ? '楼中楼' : '一级评论';
  const tag = it.source === 'aicu'
    ? '<i class="tag aicu">aicu</i>'
    : '<i class="tag">书签</i>';
  return `<div class="row ${it.status}" data-id="${it.id}">
    <input type="checkbox" class="ck" ${it.checked && it.status !== 'done' ? 'checked' : ''} ${it.status === 'done' ? 'disabled' : ''}>
    <div class="row-main">
      <div class="row-title" title="${escapeHtml(it.title)}">${tag}${escapeHtml(it.title)}</div>
      <div class="row-sub">rpid ${escapeHtml(it.parsed.rpid)} · ${escapeHtml(sourceLabel(it.parsed.pageUrl))} · ${kind}</div>
    </div>
    <div class="row-state ${cls}">${escapeHtml(stText(it))}</div>
  </div>`;
}

export function emptyText() {
  if (state.items.length && !visibleItems().length) return '这个来源下没有条目。';
  if (state.items.length) return '队列里的都处理完了。';
  return '队列是空的。在上面评论库里勾选后点「删除选中」，或者在 B 站发一条评论试试。';
}

/** 这条是哪来的：自己刚发的，还是从 aicu 导入的历史评论 */
export function libSourceTag(it) {
  return it.source === 'record'
    ? '<i class="tag rec">记录</i>'
    : '<i class="tag aicu">导入</i>';
}

/** 库列表里的一行 */
export function libRowHtml(it) {
  const when = it.ctime ? fmtTime(it.ctime * 1000) : '时间未知';
  const text = String(it.message || '').replace(/\s+/g, ' ').trim() || '（没有正文）';
  const v = it.video;
  const title = (v && v.title)
    ? v.title
    : (Number(it.type) === 1 ? 'av' + it.oid : aicuTypeName(it.type) + ' ' + it.oid);
  const kind = Number(it.rank) === 2 ? '楼中楼' : '一级评论';
  const c0 = aicuCommentUrl(it);
  const c2 = aicuSubUrl(it);

  // 上次检查的结论说明。「查不到」和「未检查」光看标签分不出原因，得把话写出来。
  const note = it.note
    ? `<div class="lrow-note">${escapeHtml(it.note)}</div>`
    : '';

  return `<div class="lrow s-${escapeHtml(it.state)}" data-rpid="${escapeHtml(it.rpid)}">
    <input type="checkbox" class="ck" ${state.libSelected.has(it.rpid) ? 'checked' : ''}>
    <div class="lrow-main">
      <div class="lrow-title">${LIB_STATE_TAG[it.state] || ''}${libSourceTag(it)}${escapeHtml(text)}</div>
      <div class="lrow-vid">${escapeHtml(title)}${v && v.owner ? '　·　UP ' + escapeHtml(v.owner) : ''}</div>
      <div class="lrow-meta">${escapeHtml(when)}　·　${escapeHtml(aicuTypeName(it.type))}　·　${kind}
        　·　rpid ${escapeHtml(it.rpid)}${it.aliveCheckedAt ? '　·　查于 ' + escapeHtml(fmtTime(it.aliveCheckedAt)) : ''}</div>
      ${note}
    </div>
    <div class="lrow-links">
      ${c0 ? `<a href="${escapeHtml(c0)}" target="_blank" rel="noreferrer">方式0</a>` : ''}
      ${c2 ? `<a href="${escapeHtml(c2)}" target="_blank" rel="noreferrer">方式2</a>` : ''}
    </div>
  </div>`;
}

export function libPagerHtml(total) {
  const pages = Math.max(1, Math.ceil(total / LIB_PAGE_SIZE));
  if (pages <= 1) return '';
  const cur = Math.min(state.libPage, pages - 1);
  return `<button class="btn mini ghost" data-page="prev"${cur === 0 ? ' disabled' : ''}>← 上一页</button>
    <span class="pager-info">第 ${cur + 1} / ${pages} 页</span>
    <button class="btn mini ghost" data-page="next"${cur >= pages - 1 ? ' disabled' : ''}>下一页 →</button>`;
}

export function renderLibFilters(s) {
  const counts = {
    all: s.total,
    checked: s.total - s.unknown,          // 「已检查」= 除"未检查"之外的全部
    live: s.live, gone: s.gone, deleted: s.deleted,
    unknown: s.unknown, unreachable: s.unreachable
  };
  $('lib-states').innerHTML = LIB_FILTERS.map(function (f) {
    const on = (f.id === 'all' && !state.libStates.length) || (state.libStates.length === 1 && state.libStates[0] === f.id);
    return `<button class="chip${on ? ' on' : ''}" data-state="${f.id}">${f.label} <b>${counts[f.id] || 0}</b></button>`;
  }).join('');
}

export function updateLibSelection() {
  $('btn-delete-selected').textContent = state.libSelected.size
    ? `删除选中（${state.libSelected.size}）`
    : '删除选中';
}

/** 重新算统计 + 重画列表。所有库操作最后都落到这里。 */
export async function refreshLibrary() {
  const s = await libraryStats();

  $('lib-total').textContent = s.total;
  $('lib-live').textContent = s.live;
  $('lib-gone').textContent = s.gone;
  $('lib-deleted').textContent = s.deleted;
  $('lib-unknown').textContent = s.unknown;
  $('lib-unreachable').textContent = s.unreachable;
  $('aicu-count').textContent = s.total;

  const bits = [];
  if (s.uid) bits.push('UID ' + s.uid);
  if (s.totalOnSite > 0) bits.push('站上共 ' + s.totalOnSite + ' 条');
  if (s.videos) bits.push(s.videos + ' 个视频');
  if (s.probedAt) bits.push('上次巡检 ' + fmtTime(s.probedAt));
  $('lib-updated').textContent = bits.join('　·　');

  renderLibFilters(s);

  const r = await queryLib({
    q: state.libQ,
    // 「已检查」翻译成其余四态；库里并没有 checked 这个状态
    states: (state.libStates.length === 1 && state.libStates[0] === 'checked') ? CHECKED_STATES : state.libStates,
    source: state.libSource,
    sort: state.libSort,
    offset: state.libPage * LIB_PAGE_SIZE,
    limit: LIB_PAGE_SIZE
  });

  const pages = Math.max(1, Math.ceil(r.total / LIB_PAGE_SIZE));
  if (state.libPage >= pages) {          // 删着删着当前页没了，退回去重画
    state.libPage = pages - 1;
    return await refreshLibrary();
  }

  const filtering = !!(state.libQ || state.libStates.length);
  $('lib-count').textContent = r.total
    ? `第 ${state.libPage * LIB_PAGE_SIZE + 1}–${Math.min(r.total, (state.libPage + 1) * LIB_PAGE_SIZE)} 条，共 ${r.total} 条`
    : (filtering ? '没有匹配的评论' : '库里还没有评论');

  // 巡检期间这个函数会被反复调用；不保住滚动位置的话列表会一直往回跳，没法看
  const listEl = $('list');
  const keepScroll = listEl.scrollTop;

  listEl.innerHTML = r.items.length
    ? r.items.map(libRowHtml).join('')
    : `<div class="empty" style="padding:18px">${escapeHtml(filtering
        ? '没有匹配的评论，换个词或者把筛选放宽。'
        : '库里还没有评论。点右上角的「导入历史」开始。')}</div>`;
  if (keepScroll) listEl.scrollTop = keepScroll;

  $('lib-pager').innerHTML = libPagerHtml(r.total);

  // 「全选本页」要和本页实际勾选情况对齐
  const pageCk = $('check-page');
  const rows = $('list').querySelectorAll('.lrow');
  let onPage = 0;
  for (const row of rows) if (state.libSelected.has(row.dataset.rpid)) onPage++;
  pageCk.checked = rows.length > 0 && onPage === rows.length;
  pageCk.indeterminate = onPage > 0 && onPage < rows.length;

  updateLibSelection();
}

/**
 * 把库里勾选的评论放进删除队列。
 *
 * **已经没了的（gone）和我们自己删过的（deleted）进不来** —— 为它们发删除请求
 * 只会拿到 12022，纯属浪费一次接口调用，也正好把存活探测省下的功夫还回去。
 *
 * 而且是"放进队列"而不是立刻删：删除不可逆，先让人看一眼队列。
 */
export async function deleteSelected() {
  if (state.running) return;
  if (!state.libSelected.size) { setHint('先在库里勾选要删除的评论。', 'warn'); return; }

  const picked = await getLibItems(Array.from(state.libSelected));
  if (!picked.length) { setHint('勾选的条目在库里找不到了，刷新一下再看看。', 'bad'); return; }

  const deletable = picked.filter(it => isDeletable(it.state));
  const blocked = picked.filter(it => !isDeletable(it.state));

  // 被挡下的一律从勾选集里摘掉，免得反复撞同一堵墙
  for (const it of blocked) state.libSelected.delete(it.rpid);

  if (!deletable.length) {
    const nGone = blocked.filter(x => x.state === 'gone').length;
    const nDel = blocked.filter(x => x.state === 'deleted').length;
    const why = [];
    if (nGone) why.push(`${nGone} 条已经没了`);
    if (nDel) why.push(`${nDel} 条是之前删过的`);
    await refreshLibrary();
    setHint(`选中的 ${picked.length} 条都不能进删除队列：${why.join('，')}。` +
      '已经不存在的评论不需要（也没法）再删一次 —— 为它们发请求只会白费一次接口调用。',
      'warn');
    return;
  }

  const have = new Set();
  for (const x of state.items) if (x.parsed && x.parsed.rpid) have.add(x.parsed.rpid);

  let added = 0;
  for (const it of deletable) {
    if (have.has(it.rpid)) continue;
    state.items.push(aicuRow(it));
    have.add(it.rpid);
    added++;
  }

  render();
  $('fold-delete').open = true;
  await refreshLibrary();

  const skip = blocked.length
    ? `　另有 ${blocked.length} 条已从勾选里去掉（已经没了或删过的，不该再删一次）。`
    : '';
  setHint(`已把 ${added} 条放进删除队列（重复的自动跳过）。${skip}` +
    '展开「删除执行」核对一下再点「开始删除」—— 删除不可逆。', added ? '' : 'warn');
}

export function bindLibraryEvents() {
  $('lib-q').addEventListener('input', function (e) {
    const v = e.target.value;
    clearTimeout(state.libTimer);
    state.libTimer = setTimeout(function () { state.libQ = v; state.libPage = 0; refreshLibrary(); }, 220);
  });

  $('lib-sort').addEventListener('change', function (e) {
    state.libSort = e.target.value;
    state.libPage = 0;
    refreshLibrary();
  });

  $('lib-src').addEventListener('change', function (e) {
    state.libSource = e.target.value === 'record' || e.target.value === 'aicu' ? e.target.value : 'all';
    state.libPage = 0;
    refreshLibrary();
  });

  $('lib-states').addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('button[data-state]') : null;
    if (!btn) return;
    const id = btn.dataset.state;
    if (id === 'all') state.libStates = [];
    else state.libStates = (state.libStates.length === 1 && state.libStates[0] === id) ? [] : [id];
    state.libPage = 0;
    refreshLibrary();
  });

  $('lib-pager').addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('button[data-page]') : null;
    if (!btn || btn.disabled) return;
    state.libPage += btn.dataset.page === 'next' ? 1 : -1;
    if (state.libPage < 0) state.libPage = 0;
    refreshLibrary();
  });

  $('list').addEventListener('change', function (e) {
    const ck = e.target.closest ? e.target.closest('input.ck') : null;
    if (!ck) return;
    const row = ck.closest('.lrow');
    if (!row) return;
    if (ck.checked) state.libSelected.add(row.dataset.rpid);
    else state.libSelected.delete(row.dataset.rpid);

    const rows = $('list').querySelectorAll('.lrow');
    let on = 0;
    for (const r of rows) if (state.libSelected.has(r.dataset.rpid)) on++;
    $('check-page').checked = rows.length > 0 && on === rows.length;
    $('check-page').indeterminate = on > 0 && on < rows.length;
    updateLibSelection();
  });

  $('check-page').addEventListener('change', function (e) {
    const on = e.target.checked;
    const rows = $('list').querySelectorAll('.lrow');
    for (const row of rows) {
      if (on) state.libSelected.add(row.dataset.rpid);
      else state.libSelected.delete(row.dataset.rpid);
      const ck = row.querySelector('input.ck');
      if (ck) ck.checked = on;
    }
    updateLibSelection();
  });

  $('btn-delete-selected').addEventListener('click', function () {
    deleteSelected().catch(function (e) { setHint('操作失败：' + ((e && e.message) || e), 'bad'); });
  });

}

export function render() {
  const list = visibleItems();
  $('queue-list').innerHTML = list.length
    ? list.map(rowHtml).join('')
    : `<div class="empty" style="padding:18px">${escapeHtml(emptyText())}</div>`;
  syncCounts();
}

export function renderRow(it) {
  const el = $('queue-list').querySelector(`.row[data-id="${it.id}"]`);
  if (!el) { render(); return; }

  el.className = 'row ' + it.status;
  const ck = el.querySelector('.ck');
  if (ck) {
    ck.checked = it.checked && it.status !== 'done';
    ck.disabled = it.status === 'done';
  }
  const st = el.querySelector('.row-state');
  st.className = 'row-state ' + (STATE_CLS[it.status] || '');
  st.textContent = stText(it);
}

/** 一次算清所有计数：概览那一行 + 筛选栏 + 勾选数 + 按钮文案 */
export function syncCounts() {
  const left = state.items.filter(i => i.status !== 'done');
  const sel = left.filter(i => i.checked).length;
  $('stat-pending').textContent = left.length;
  $('stat-ok').textContent = state.stats.ok;
  $('stat-fail').textContent = state.stats.fail;
  $('stat-gone').textContent = state.stats.gone;
  $('sel-count').textContent = sel === left.length
    ? `全部 ${left.length} 条都在队列里`
    : `已勾选 ${sel} / ${left.length} 条`;
  $('btn-start').textContent = (sel && sel !== left.length) ? `删除评论（${sel} 条）` : '删除评论';
  renderFilters();
}

export function updateProgress(done, total) {
  $('progress-inner').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
}

/** 顶部那行「预计还要多久」 */
export function setEta(text) {
  const el = $('eta');
  if (el) el.textContent = text || '';
}

export function setUi(isRunning) {
  $('btn-start').disabled = isRunning;
  $('btn-stop').disabled = !isRunning;
  $('btn-reload').disabled = isRunning;
  $('btn-retry').disabled = isRunning;
  $('btn-purge').disabled = isRunning;
  refreshAicuButtons();
  if (isRunning) setPurgeConfirm(false);
}

/* ----------------------------------------------------- 本模块的常量 */

export const FILTER_LABEL = { all: '全部', bookmark: '书签记录', aicu: 'aicu 导入' };

export const STATE_CLS = { done: 'ok', failed: 'bad', working: 'run' };

export const LIB_PAGE_SIZE = 50;

export const LIB_STATE_TAG = {
  live: '<i class="tag live">还在</i>',
  gone: '<i class="tag gone">已没了</i>',
  deleted: '<i class="tag deleted">已删除</i>',
  unreachable: '<i class="tag unreachable">查不到</i>',
  unknown: '<i class="tag">未检查</i>'
};

export const LIB_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'checked', label: '已检查' },
  { id: 'live', label: '还在' },
  { id: 'gone', label: '已没了' },
  { id: 'deleted', label: '已删除' },
  { id: 'unreachable', label: '查不到' },
  { id: 'unknown', label: '未检查' }
];

/** 「已检查」不是库里真实的一种状态，而是其余四态的并集；查询时翻译成它们 */
const CHECKED_STATES = ['live', 'gone', 'deleted', 'unreachable'];
