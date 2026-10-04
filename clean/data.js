/**
 * 数据与存储页 + 账号绑定（UID）
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { refreshBadge } from './delete.js';
import { $, setHint } from './dom.js';
import { loadArchive, refreshLibrary, render } from './library.js';
import { state } from './state.js';
import { getSettings } from '../src/settings.js';
import { clearLibrary, libraryStats } from '../src/store.js';
import { fmtTime } from '../src/urls.js';
import { escapeHtml } from '../src/util.js';

/**
 * 抓到的 UID 和主账号对不上 —— 问一句。
 *
 * 为什么必须问：aicu 的地址就是 `aicu.cc/reply?uid=xxx`，把 uid 一换，
 * 读到的就是**别人的评论**。导进库里之后，「删除选中」会拿着别人的 rpid
 * 去发删除请求，账也全乱了。所以默认什么都不做，等用户明确说"这是我小号"。
 */
export function askAltUid(incoming, owner) {
  state.askingUid = String(incoming || '');
  $('uid-ask-text').innerHTML =
    `抓到的这批数据属于 <b>UID ${escapeHtml(state.askingUid)}</b>，` +
    `而你的账号是 <b>UID ${escapeHtml(String(owner || '（没设）'))}</b>。<br>` +
    '这是你的小号吗？<b>答"不是"的话，这批数据一条都不会导入。</b>';
  $('uid-ask').classList.remove('hide');
}

export function hideAskUid() {
  $('uid-ask').classList.add('hide');
  state.askingUid = '';
}

export function setDataClearConfirm(on) {
  if (state.dataClearTimer) { clearTimeout(state.dataClearTimer); state.dataClearTimer = null; }
  $('data-clear-confirm').classList.toggle('hide', !on);
  $('btn-data-clear').classList.toggle('hide', !!on);
  if (on) state.dataClearTimer = setTimeout(function () { setDataClearConfirm(false); }, 8000);
}

/** 把「数据都在哪、各有多少」如实写出来 */
export async function renderDataPage() {
  const st = await libraryStats();
  const s = await getSettings();

  let bytes = 0;
  try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (e) { bytes = 0; }

  $('data-lib').textContent =
    (st.uid ? `绑定账号 UID ${st.uid}　·　` : '还没绑定账号　·　') +
    `共 ${st.total} 条　·　还在 ${st.live}　·　已没了 ${st.gone}　·　已删除 ${st.deleted}` +
    `　·　查不到 ${st.unreachable}　·　未检查 ${st.unknown}` +
    `　·　其中自己记录 ${st.recorded} 条、导入 ${st.imported} 条` +
    `　·　涉及 ${st.videos} 个视频` +
    (st.probedAt ? `　·　上次巡检 ${fmtTime(st.probedAt)}` : '') +
    (bytes ? `　·　本地存储共占用约 ${(bytes / 1024).toFixed(1)} KB` : '');

  const badge = { off: '不显示', live: '显示还在的条数', pending: '显示还没处理的条数' }[s.badgeMode] || '不显示';
  $('data-settings').textContent =
    `自动记录${s.enabled ? '已开启' : '已关闭'}　·　角标${badge}` +
    `　·　删除间隔 ${s.minDelay}~${s.maxDelay} 毫秒` +
    `　·　同时写收藏夹${s.useBookmarks ? '已开启' : '已关闭'}`;
}

/** 把整个评论库删掉（设置和导出的文件都不动） */
export async function clearWholeLibrary() {
  setDataClearConfirm(false);
  $('btn-data-clear').disabled = true;
  try {
    await clearLibrary();
    state.libSelected.clear();
    state.items = [];
    render();
    await refreshLibrary();
    await loadArchive();
    await renderDataPage();
    await refreshBadge();
    setHint('评论库已经清空。设置没动，之前导出的备份文件也还在你自己的下载目录里。', 'warn');
  } catch (e) {
    setHint('清空失败：' + ((e && e.message) || e), 'bad');
  } finally {
    $('btn-data-clear').disabled = false;
  }
}
