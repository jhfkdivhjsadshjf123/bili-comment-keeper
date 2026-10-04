/**
 * main.js —— 侧边栏控制台的入口
 *
 * 面板是一个原生 ES 模块应用（零构建），职责拆在几个文件里：
 *
 *   state.js    跨模块共享的可变状态（就一个对象）
 *   dom.js      通用小工具（$、提示条、日志）
 *   library.js  评论库视图 + 删除队列
 *   import.js   aicu 历史评论的导入与自动翻页
 *   backup.js   导出 / 导入备份
 *   probe.js    存活巡检（判定逻辑 + 取数据）
 *   delete.js   删除引擎（注入网页、重试、主流程）
 *   data.js     数据与存储页 + 账号绑定
 *   main.js     就是本文件：初始化、事件接线、视图切换
 *
 * 这个文件应该保持**薄**：只做"把大家接起来"，业务逻辑不往这儿放。
 *
 * 顺带记一笔为什么删除要注入网页：扩展页面的 origin 是 chrome-extension://，
 * 对 bilibili.com 属于跨站，SESSDATA 会被 SameSite 拦掉。所以删除请求得从
 * bilibili 标签页里发出去（没有就开一个后台标签页），由那个页面以同站身份发。
 */

import { doExport, doImport } from './backup.js';
import { askAltUid, clearWholeLibrary, hideAskUid, renderDataPage, setDataClearConfirm } from './data.js';
import { start } from './delete.js';
import { $, log, setHint } from './dom.js';
import { loadAicu, mergeAicu, pruneDeadAicu, readCurrentAicuPage, scheduleAicuRender, setAicuAuto, setAicuHint, setAicuProbing, startAutoPage, stopAutoPage } from './import.js';
import { bindLibraryEvents, buildFilters, loadArchive, purgeArchive, refreshLibrary, reload, render, renderRow, setPurgeConfirm, syncCounts, visibleItems } from './library.js';
import { probeAicuAlive } from './probe.js';
import { state } from './state.js';
import { DEFAULT_SETTINGS, K_SETTINGS, getSettings, setSettings } from '../src/settings.js';
import { K_LIBRARY, clearLibrary } from '../src/store.js';

/**
 * 库一变就自动重画。
 *
 * 为什么要盯着 storage 而不是等后台广播：**广播要一处一处记得发**。
 * 之前发一条评论，后台写完库就悄悄结束了，面板压根不知道 —— 界面要关掉重开才更新。
 * 盯着存储本身，任何写入路径（现在和将来的）都会自动反映出来。
 */

export function scheduleLibraryRefresh() {
  // 巡检和删除这两个流程自己会刷新界面，别和它们打架
  if (state.probing || state.running || state.autoRunning) return;
  if (state.libWatchTimer) clearTimeout(state.libWatchTimer);
  state.libWatchTimer = setTimeout(function () {
    state.libWatchTimer = null;
    refreshLibrary().catch(function () {});
    loadArchive().catch(function () {});
  }, 300);
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;

  if (changes[K_LIBRARY]) scheduleLibraryRefresh();

  // 设置被改了（比如在设置页关了自动记录），面板里那份缓存也要跟着换
  if (changes[K_SETTINGS]) {
    getSettings().then(function (s) { state.settings = s; }).catch(function () {});
  }
});

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg) return;

  if (msg.type === 'DELETE_RESULT' && msg.requestId && state.pending.has(msg.requestId)) {
    const resolve = state.pending.get(msg.requestId);
    state.pending.delete(msg.requestId);
    resolve({ ok: !!msg.ok, code: msg.code, message: msg.message || '' });
    return;
  }

  // 在 aicu.cc 页面又抓到一批历史评论，跟着刷新导入区
  // （自动翻页时每页都会推一次，节流一下，别把列表反复重绘几百次）
  if (msg.type === 'AICU_UPDATED') {
    scheduleAicuRender();
    return;
  }

  // 换了个 UID 想导入 —— 拒绝，并且问一句"这是你小号吗"。
  // 答"是"就把这批补进去（后台暂存着）；答"不是"就什么都不做。
  if (msg.type === 'AICU_ASK_UID') {
    scheduleAicuRender();
    askAltUid(msg.incoming, msg.owner);
    return;
  }

  // 还没设置自己的 UID —— 什么都不导，先让他去填
  if (msg.type === 'AICU_NEED_UID') {
    scheduleAicuRender();
    setAicuHint('这批数据没有导入：还没设置你自己的 UID。\n' +
      '先在下面填上你的 UID 并保存 —— 不然分不清抓到的评论是谁的。', 'bad');
    showView('import');
    const el = $('uid-input');
    if (el) el.focus();
    return;
  }

  // 绑定关系变了（自动探测到 / 填了主账号 / 认了小号），刷新界面
  if (msg.type === 'UID_SET') {
    scheduleAicuRender();
    refreshLibrary().catch(function () {});
    if (msg.auto) {
      setAicuHint(`已自动识别你的 UID：${msg.uid}` +
        (msg.uname ? `（${msg.uname}）` : '') +
        '　—— 从 B 站的登录态读的，不用手输。', '');
    }
    return;
  }

  // 在 B 站上又看到别的登录账号，但库里已经绑了别人 —— 提一句，不改动
  if (msg.type === 'UID_SEEN') {
    setAicuHint(`注意到你当前在 B 站登录的是 UID ${msg.uid}，` +
      `而这个库绑定的是 UID ${msg.owner}。\n` +
      '没有做任何改动。如果这是你的小号，去 aicu 抓一次它，到时候会问你要不要加进来。', 'warn');
    return;
  }

  // 自动翻页抓取的进度 / 结束
  if (msg.type === 'AICU_AUTOPAGE' && msg.payload) {
    const p = msg.payload;
    if (p.kind === 'done') {
      setAicuAuto(false);
      setAicuHint('自动抓取结束：' + (p.reason || '已结束') +
        (p.pages ? `（共翻了 ${p.pages} 页）` : ''), 'warn');
      loadAicu().catch(function () {});
    } else if (p.kind === 'progress') {
      setAicuHint('自动抓取中：' + (p.note || '…') +
        '　—— 这是替你点 aicu 页面上的「下一页」，不会多发任何请求。', '');
    }
    return;
  }

  // 你在 B 站网页上自己删了评论，后台同步归档后通知面板更新那一行
  if (msg.type === 'SYNC_ARCHIVED' && msg.rpid) {
    const it = state.items.find(i => i.parsed && i.parsed.rpid === String(msg.rpid));
    if (it && it.status !== 'done') {
      it.status = 'done';
      it.note = '你在网页上手动删除，已同步归档';
      renderRow(it);
      syncCounts();
    }
    loadArchive().catch(function () {});
  }
});

/* ------------------------------------------------------------------ 初始化 */

export async function init() {
  state.settings = await getSettings();
  buildFilters();
  bindEvents();
  render();
  await loadArchive();
  await loadAicu();
}

export function bindEvents() {
  bindLibraryEvents();
  $('btn-start').addEventListener('click', start);

  $('btn-settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  // 主视图 ⇄ 导入视图 ⇄ 数据页
  $('btn-open-import').addEventListener('click', function () { showView('import'); });
  $('btn-back-main').addEventListener('click', function () { showView('main'); });
  $('btn-open-data').addEventListener('click', function () { showView('data'); });
  $('btn-back-home2').addEventListener('click', function () { showView('main'); });

  // 数据页上的操作
  $('btn-data-export').addEventListener('click', function () { doExport('json'); });
  $('btn-data-purge').addEventListener('click', function () {
    purgeArchive().then(renderDataPage).catch(function (e) {
      setHint('清理失败：' + ((e && e.message) || e), 'bad');
    });
  });
  $('btn-data-clear').addEventListener('click', function () { setDataClearConfirm(true); });
  $('btn-data-clear-no').addEventListener('click', function () { setDataClearConfirm(false); });
  $('btn-data-clear-yes').addEventListener('click', function () {
    clearWholeLibrary().catch(function (e) { setHint('清空失败：' + ((e && e.message) || e), 'bad'); });
  });
  $('btn-data-reset').addEventListener('click', function () {
    setSettings(Object.assign({}, DEFAULT_SETTINGS))
      .then(async function () {
        state.settings = await getSettings();
        await renderDataPage();
        setHint('设置已恢复默认。评论库没动。', '');
      })
      .catch(function (e) { setHint('恢复失败：' + ((e && e.message) || e), 'bad'); });
  });

  // 来源筛选
  $('filters').addEventListener('click', function (e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.sourceFilter = btn.dataset.src || 'all';
    render();
  });

  $('btn-stop').addEventListener('click', function () {
    if (!state.running) return;
    state.stopRequested = true;
    log('收到停止指令，当前这条删完就停…');
    setHint('正在停止…（等当前这一条处理完）', 'warn');
  });

  $('btn-reload').addEventListener('click', async function () {
    if (state.running) return;
    await reload();
    setHint('列表已刷新。', '');
  });

  $('btn-retry').addEventListener('click', async function () {
    if (state.running) return;
    const failed = state.items.filter(i => i.status === 'failed');
    if (!failed.length) { setHint('没有失败项。', ''); return; }
    failed.forEach(i => { i.status = 'idle'; i.note = ''; i.checked = true; });
    render();
    await start();
  });

  $('check-all').addEventListener('change', function (e) {
    // 只作用于当前筛选出来的那批，别把筛掉的也一起改了
    const vis = new Set(visibleItems().map(i => i.id));
    state.items.forEach(i => { if (vis.has(i.id) && i.status !== 'done') i.checked = e.target.checked; });
    render();
  });

  $('queue-list').addEventListener('change', function (e) {
    if (!e.target.classList.contains('ck')) return;
    const row = e.target.closest('.row');
    const it = row && state.items.find(i => String(i.id) === row.dataset.id);
    if (it) { it.checked = e.target.checked; syncCounts(); }
  });

  // aicu.cc 导入区
  $('btn-aicu-auto').addEventListener('click', function () {
    startAutoPage().catch(e => setAicuHint('启动失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-aicu-autostop').addEventListener('click', stopAutoPage);

  // 只读探测：先问清楚哪些还活着，再决定删什么
  $('btn-aicu-probe').addEventListener('click', function () {
    probeAicuAlive().catch(e => {
      setAicuProbing(false);
      setAicuHint('探测失败：' + ((e && e.message) || e), 'bad');
    });
  });

  // 只读当前这一页（不翻页）。这是最重要的逃生口：
  // 页面明明有评论、导入却一直是 0 的时候，点它试试 —— 它直接从渲染结果里抠，
  // 完全不依赖「挂钩页面请求」那条路。
  $('btn-aicu-read').addEventListener('click', function () {
    if (state.running) return;
    readCurrentAicuPage().catch(e => setAicuHint('读取失败：' + ((e && e.message) || e), 'bad'));
  });

  // 备份：导出 / 导入
  $('btn-export-json').addEventListener('click', function () { doExport('json'); });
  $('btn-export-html').addEventListener('click', function () { doExport('html'); });
  $('btn-export-md').addEventListener('click', function () { doExport('md'); });

  $('btn-import-json').addEventListener('click', function () { $('file-import').click(); });
  $('file-import').addEventListener('change', function (ev) {
    const f = ev.target.files && ev.target.files[0];
    doImport(f).then(function () { ev.target.value = ''; });
  });

  // 清掉已确认没了的，清单里只留活着的
  $('btn-aicu-prune').addEventListener('click', function () {
    pruneDeadAicu().catch(e => setAicuHint('清理失败：' + ((e && e.message) || e), 'bad'));
  });

  $('btn-aicu-merge').addEventListener('click', function () {
    if (state.running) return;
    mergeAicu().catch(e => setAicuHint('加入失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-aicu-clear').addEventListener('click', function () {
    if (state.running) return;
    clearLibrary()
      .then(function () {
        setAicuHint('已清空导入清单。这不影响书签，也不影响 B 站上的评论。', '');
        return loadAicu();
      })
      .catch(e => setAicuHint('清空失败：' + ((e && e.message) || e), 'bad'));
  });

  // 清空归档：先弹确认，8 秒没动作自动收起
  $('btn-purge').addEventListener('click', function () { if (!state.running) setPurgeConfirm(true); });
  $('btn-purge-yes').addEventListener('click', function () {
    purgeArchive().catch(e => setHint('清空失败：' + ((e && e.message) || e), 'bad'));
  });
  $('btn-purge-no').addEventListener('click', function () { setPurgeConfirm(false); });
}

/* ------------------------------------------------- 已删除记录（库里的账本） */

/* ------------------------------------------------- aicu.cc 导入的历史评论
 * 本扩展只记录「装好之后」发出的评论；装之前发的、手机上发的都抓不到。
 * aicu.cc 存着完整历史，由 src/aicu-main.js 在它页面上顺手读回来。
 * 这里只负责展示与并入待删列表 —— 删除走的是上面那套完全相同的流程。
 */

/* -------------------------------------------- aicu.cc 自动翻页抓取 */

/* ------------------------------------------------------ 备份：导出 / 导入 */

/* ---------------------------------------------------------------- 列表渲染 */

/* ============================================================ 评论库视图
 *
 * 这是产品的主界面：本地保存的所有评论，可搜索、可筛选、可排序、可翻页。
 * 删除只是这一层之上的一个可选操作（「删除选中」），不再是主界面。
 */

/**
 * 库里勾选的 rpid。
 * 用 `var` 是故意的：它会挂到全局对象上，测试里能直接摆布它来验证
 * 「哪些状态允许进删除队列」—— 这个准入规则出过一次线上 bug。
 */

/* ------------------------------------------------------- 库操作：删除选中 */

/* ------------------------------------------------------- 库操作：视频标题 */

/* ------------------------------------------------------------ 事件接线 */

/* --------------------------------------------------------- 主视图 / 副视图 */

/**
 * 面板有三个视图：
 *   main   —— 评论库（**主页**：所有历史评论，日常都在这）
 *   import —— 导入历史（一次性的初始化步骤，不是日常功能）
 *   data   —— 数据与存储（数据都在哪、怎么删）
 *
 * 为什么把导入和存储都拆出去：它们回答的是"一开始怎么把数据弄进来"和
 * "数据到底放在哪"这两个一次性问题，摆在主页会喧宾夺主。
 */
export function showView(name) {
  const want = (name === 'import' || name === 'data') ? name : 'main';
  $('view-main').classList.toggle('hide', want !== 'main');
  $('view-import').classList.toggle('hide', want !== 'import');
  $('view-data').classList.toggle('hide', want !== 'data');

  if (want === 'import') loadAicu().catch(function () {});
  else if (want === 'data') renderDataPage().catch(function () {});
  else refreshLibrary().catch(function () {});
}

/* -------------------------------------------------- 账号绑定（UID） */

$('btn-uid-yes').addEventListener('click', function () {
  const u = state.askingUid;
  hideAskUid();
  if (!u) return;
  chrome.runtime.sendMessage({ type: 'CONFIRM_ALT_UID', uid: u })
    .then(function (r) {
      if (!r || !r.ok) {
        setAicuHint('记下小号失败：' + ((r && r.reason) || '后台没应答'), 'bad');
        return;
      }
      const back = r.replayed;
      setAicuHint(back && back.ok
        ? `已把小号 UID ${u} 记下，刚才拒掉的那批也补进来了（新增 ${back.added} 条）。`
        : `已把小号 UID ${u} 记下。刚才那批没能补录，回 aicu 页面重新点一次「读当前页」就行。`, '');
      loadAicu().catch(function () {});
      refreshLibrary().catch(function () {});
    })
    .catch(function (e) { setAicuHint('记下小号失败：' + ((e && e.message) || e), 'bad'); });
});

$('btn-uid-no').addEventListener('click', function () {
  hideAskUid();
  chrome.runtime.sendMessage({ type: 'REJECT_ALT_UID' }).catch(function () {});
  setAicuHint('好，这批数据没有导入，也不会留下任何记录。\n' +
    '如果你要看的是自己的评论，确认地址栏里的 uid= 是你自己的。', 'warn');
});

$('btn-save-uid').addEventListener('click', function () {
  const u = String($('uid-input').value || '').trim();
  if (!/^\d+$/.test(u)) { setAicuHint('UID 只能是数字。', 'bad'); return; }

  chrome.runtime.sendMessage({ type: 'SET_OWNER_UID', uid: u })
    .then(function (r) {
      if (!r || !r.ok) {
        setAicuHint('保存失败：' + ((r && r.reason) || '后台没应答'), 'bad');
        return;
      }
      setAicuHint(`好，你的 UID 是 ${u}。现在可以去 aicu 页面抓了。`, '');
      loadAicu().catch(function () {});
    })
    .catch(function (e) { setAicuHint('保存失败：' + ((e && e.message) || e), 'bad'); });
});

/* -------------------------------------------------- 数据与存储页 */

/* ---------------------------------------------------------------- 删除执行 */

/* ------------------------------------------------ 存活判定（纯逻辑，不走网络） */

/* ------------------------------------------------ 取数据：两条路自动选 */

/**
 * 记住哪条取数通道通。null=还没试过；true/false=以后照这个来。
 * 用 `var` 是故意的：它会挂到全局对象上，测试里能直接观察/设置它。
 */

/* ------------------------------------------------------------------ 主流程 */

init().catch(e => setHint('初始化失败：' + ((e && e.message) || e), 'bad'));
