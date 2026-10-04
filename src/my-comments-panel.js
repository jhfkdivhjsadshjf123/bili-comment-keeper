/**
 * my-comments-panel.js —— 在 B 站自己的消息页里加一栏「我的评论」
 *
 * 目标页面：https://message.bilibili.com/#/reply （B 站原生的「谁回复了我」）
 * 做一件事：在左侧栏的「我的消息」和「回复我的」之间插一栏「我的评论」，
 * 点开显示评论库里**还活着**的那些评论。
 *
 * 为什么是经典脚本、不能用 import：这一条由 manifest 的 content_scripts 注入。
 * 数据不自己读 storage —— 归一化/状态判定那些逻辑在 store.js（ES 模块）里，
 * 内容脚本用不了；抄一份迟早分叉。所以让后台算好，这里只管显示。
 *
 * ---------------------------------------------------------------------------
 * 这个页面是 Vue SPA，我把它的结构挖出来过（bundle: message-pc/static/js/index.*.js）：
 *
 *   <div class="message-layout">
 *     <aside class="message-aside">
 *       <div class="message-sidebar">
 *         <div class="message-sidebar__title">…消息中心…</div>
 *         <ul class="message-sidebar__interactions">
 *           <li class="message-sidebar__item [is-active]">      ← 我们的插入点
 *             <div class="message-sidebar__item-icon dot"></div>
 *             <div class="message-sidebar__item-name">我的消息</div>
 *             <div class="message-sidebar__item-notify">…</div>
 *           </li>
 *           <li …>回复我的</li> …
 *         </ul>
 *       </div>
 *     </aside>
 *     <main class="message-main"><router-view/></main>
 *   </div>
 *
 * 所以：**直接复用它的类名**（message-sidebar__item / is-active / message-main），
 * 插进去的那一栏看起来就是原生的，不需要自己画一套样式。
 *
 * 两点防御：
 *   · Vue 重渲染 v-for 会把我们插的 li 冲掉 —— 用 MutationObserver 补回来
 *   · 点它自己的栏目会走 vue-router（这个站是 hash 模式），
 *     所以监听 hashchange 来把我们的面板收起来
 */


(function () {
  'use strict';

  if (window.__bcMyCommentsInstalled) return;
  window.__bcMyCommentsInstalled = true;

  /**
   * 这个脚本**自己**的版本号。
   *
   * 为什么手写一份、而不是读 `chrome.runtime.getManifest().version`：
   * 后者给的是**当前已安装**的版本，不是"这段代码是从哪个版本加载进来的"。
   * 内容脚本只在页面加载时注入一次 —— 扩展更新之后，已经开着的页面里
   * 跑的还是旧脚本，而它读 manifest 会读到新版本号，于是完全看不出问题。
   *
   * 有这一份就能对比：对不上就说明本页里的脚本是旧的，直接提示用户刷新。
   * （test/wiring.test.mjs 会盯着它必须和 manifest 的 version 一致。）
   */
  var PANEL_VERSION = '1.14.1';

  var TAB_TEXT = '我的评论';
  var MARK = 'data-bc-mine';
  var PANEL_ID = 'bc-my-comments';

  var showing = false;     // 现在是不是停在我们那一栏

  /* ------------------------------------------------------------ 小工具 */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* --------------------------------------------------- 找到侧栏和插入点 */

  function sidebarList() {
    return document.querySelector('.message-sidebar__interactions');
  }

  /** 侧栏里「我的消息」那一项（按文字找，不靠顺序，页面改版也不容易错） */
  function firstItem(list) {
    var items = list.querySelectorAll('li.message-sidebar__item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].hasAttribute(MARK)) continue;
      var name = items[i].querySelector('.message-sidebar__item-name');
      if (name && name.textContent.trim() === '我的消息') return items[i];
    }
    return items[0] || null;
  }

  function myItem() {
    return document.querySelector('li[' + MARK + ']');
  }

  /** 插一栏「我的评论」，放在「我的消息」后面 */
  function injectTab() {
    var list = sidebarList();
    if (!list) return false;
    if (myItem()) return true;

    var anchor = firstItem(list);
    if (!anchor) return false;

    // 结构照抄它自己的那一项，只是不放假的小圆点（那个是未读提示）
    var li = el('li', 'message-sidebar__item');
    li.setAttribute(MARK, '1');
    li.appendChild(el('div', 'message-sidebar__item-icon dot'));
    li.appendChild(el('div', 'message-sidebar__item-name', TAB_TEXT));
    li.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showMine();
    }, true);

    anchor.parentNode.insertBefore(li, anchor.nextSibling);
    return true;
  }

  /* ------------------------------------------------------------ 面板 */

  /** 右侧内容区（router-view 渲染出来的东西都在这里面） */
  function mainArea() {
    return document.querySelector('main.message-main');
  }

  function panel() {
    return document.getElementById(PANEL_ID);
  }

  function buildPanel() {
    var box = el('div', 'bc-mine');
    box.id = PANEL_ID;

    // 头部做成一条横带 —— 和 B 站自己的「收到的赞」那个标题条是一样的做法
    var head = el('div', 'bc-mine__head');
    head.appendChild(el('div', 'bc-mine__title', '我的评论'));
    var count = el('div', 'bc-mine__count');
    count.id = 'bc-mine-count';
    head.appendChild(count);
    box.appendChild(head);

    var meta = el('div', 'bc-mine__meta');
    meta.id = 'bc-mine-meta';
    box.appendChild(meta);

    var list = el('div', 'bc-mine__list');
    list.id = 'bc-mine-list';
    box.appendChild(list);

    var t = el('div', 'bc-mine__toast');
    t.id = 'bc-mine-toast';
    t.style.display = 'none';
    box.appendChild(t);

    box.appendChild(buildModal());

    // 列表是整块 innerHTML 换的，所以用事件委托接删除按钮
    list.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-bc-del]') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var rpid = btn.getAttribute('data-bc-del');
      var it = null;
      for (var i = 0; i < shown.length; i++) {
        if (String(shown[i].rpid) === String(rpid)) { it = shown[i]; break; }
      }
      if (it) openModal(it);
    });

    return box;
  }

  function renderState(text) {
    var list = document.getElementById('bc-mine-list');
    if (list) list.innerHTML = '<div class="bc-mine__empty">' + esc(text) + '</div>';
  }

  /** 现在列表里显示着的那批（抓标题、删除之后回填都要用） */
  var shown = [];

  /** 拼一行。对外也用于「只更新这一行」 */
  function rowHtml(it) {
    var text = it.message ? esc(it.message) : '<span class="bc-mine__nomsg">（没有正文）</span>';

    // 来源：有缓存的视频标题就用标题，否则用短标签（av… / cv… / t.bilibili.com/…）
    var src = it.video || it.page || '';
    var srcHtml = src
      ? (it.pageUrl
          ? '<a class="bc-mine__src" href="' + esc(it.pageUrl) + '" target="_blank" rel="noreferrer">' + esc(src) + '</a>'
          : '<span class="bc-mine__src">' + esc(src) + '</span>')
      : '<span class="bc-mine__src">来源未知</span>';

    var open = it.url
      ? '<a class="bc-mine__open" href="' + esc(it.url) + '" target="_blank" rel="noreferrer">打开</a>'
      : '';

    // 删得掉的才给删除按钮（缺 type/oid 的删不了，就别摆个点了没用的按钮）
    var del = (it.type && it.oid)
      ? '<button type="button" class="bc-mine__del" data-bc-del="' + esc(it.rpid) + '">删除</button>'
      : '';

    // rpid 不显示（官方也不显示），挂在 title 上，要查的时候鼠标停一下就能看到
    return '<div class="bc-mine__row" data-bc-row="' + esc(it.rpid) + '" title="rpid ' + esc(it.rpid) + '">' +
      '<div class="bc-mine__text">' + text + '</div>' +
      '<div class="bc-mine__line">' +
        '<span class="bc-mine__facts">' + srcHtml +
          '<span class="bc-mine__sep">·</span>' + esc(it.kind) +
          (it.when ? '<span class="bc-mine__sep">·</span>' + esc(it.when) : '') +
        '</span>' +
        '<span class="bc-mine__acts">' + open + del + '</span>' +
      '</div>' +
    '</div>';
  }

  function renderItems(data) {
    var list = document.getElementById('bc-mine-list');
    var meta = document.getElementById('bc-mine-meta');
    var count = document.getElementById('bc-mine-count');
    if (!list) return;

    shown = (data.items || []).slice();
    updateCount();

    if (meta) {
      meta.textContent = data.total
        ? (data.shown < data.total
            ? '这里显示最近 ' + data.shown + ' 条；更早的、以及已没了/已删除的，去扩展控制台看。'
            : '更早的、以及已没了/已删除的，去扩展控制台看。')
        : '';
    }

    if (!shown.length) {
      renderState('还没有还在的评论。去扩展控制台跑一次「巡检存活」就能筛出来。');
      return;
    }

    list.innerHTML = shown.map(rowHtml).join('');
    loadTitles();
  }

  function updateCount() {
    var count = document.getElementById('bc-mine-count');
    if (count) count.textContent = shown.length ? '还在 ' + shown.length + ' 条' : '';
  }

  /* -------------------------------------------------- 按需补视频标题 */

  /**
   * 库里只存了 type:oid，直接显示就是一堆 av123456789。
   * 这里只给"眼前这几条"补标题（后台会按视频缓存，所以每个视频只请求一次）。
   *
   * 补到之后**只改那几行**，不重画整个列表 —— 免得把用户正在看的位置顶掉。
   */
  function loadTitles() {
    var missing = shown.filter(function (x) { return !x.video && Number(x.type) === 1; });
    if (!missing.length) return;

    var ask = missing.slice(0, 12).map(function (x) { return { type: x.type, oid: x.oid }; });

    try {
      chrome.runtime.sendMessage({ type: 'FETCH_VIDEO_TITLES', items: ask, limit: 12 }, function (r) {
        if (chrome.runtime.lastError || !r || !r.ok || !r.titles) return;

        var changed = false;
        shown.forEach(function (x) {
          var t = r.titles[String(Number(x.type)) + ':' + String(x.oid)];
          if (t && t.title && !x.video) { x.video = t.title; changed = true; }
        });
        if (!changed) return;

        // 就地替换受影响的那几行
        var list = document.getElementById('bc-mine-list');
        if (!list) return;
        shown.forEach(function (x) {
          if (!x.video) return;
          var old = list.querySelector('[data-bc-row="' + x.rpid + '"]');
          if (!old) return;
          var box = document.createElement('div');
          box.innerHTML = rowHtml(x);
          old.parentNode.replaceChild(box.firstChild, old);
        });
      });
    } catch (e) { /* 抓不到标题不影响看评论 */ }
  }

  /* -------------------------------------------------------- 确认弹窗 */

  var pendingDelete = null;

  function modal() {
    return document.getElementById('bc-mine-mask');
  }

  function buildModal() {
    var mask = el('div', 'bc-mine__mask');
    mask.id = 'bc-mine-mask';
    mask.style.display = 'none';

    var box = el('div', 'bc-mine__dialog');
    box.appendChild(el('div', 'bc-mine__dialog-title', '删除这条评论？'));

    var quote = el('div', 'bc-mine__dialog-quote');
    quote.id = 'bc-mine-quote';
    box.appendChild(quote);

    box.appendChild(el('div', 'bc-mine__dialog-warn',
      '删掉之后 B 站上就没了，不可恢复。本地这条也会记成「已删除」。'));

    var acts = el('div', 'bc-mine__dialog-acts');
    var yes = el('button', 'bc-mine__btn bc-mine__btn--danger', '确定删除');
    yes.type = 'button';
    yes.id = 'bc-mine-yes';
    var no = el('button', 'bc-mine__btn', '取消');
    no.type = 'button';
    no.id = 'bc-mine-no';
    acts.appendChild(yes);
    acts.appendChild(no);
    box.appendChild(acts);

    mask.appendChild(box);

    // 点遮罩 / 按 Esc 都当取消
    mask.addEventListener('click', function (e) { if (e.target === mask) closeModal(); });

    // 弹窗自己的两个按钮：这里绑一次就够（弹窗只建一次）
    yes.addEventListener('click', confirmDelete);
    no.addEventListener('click', closeModal);

    return mask;
  }

  function openModal(it) {
    pendingDelete = it;
    var m = modal();
    if (!m) return;
    var q = document.getElementById('bc-mine-quote');
    if (q) q.textContent = it.message || '（没有正文）';
    m.style.display = '';
  }

  function closeModal() {
    pendingDelete = null;
    var m = modal();
    if (m) m.style.display = 'none';
  }

  /** 弹窗里点「确定删除」→ 交后台去 B 站删，成功了就把这一行摘掉 */
  function confirmDelete() {
    var it = pendingDelete;
    if (!it) return;

    var yes = document.getElementById('bc-mine-yes');
    if (yes) { yes.disabled = true; yes.textContent = '删除中…'; }

    var done = function (text, ok) {
      if (yes) { yes.disabled = false; yes.textContent = '确定删除'; }
      closeModal();
      if (!ok) { toast(text, true); return; }
      removeRow(it.rpid);
      toast(text, false);
    };

    try {
      chrome.runtime.sendMessage({
        type: 'DELETE_ONE_COMMENT',
        payload: { rpid: it.rpid, type: it.type, oid: it.oid }
      }, function (r) {
        if (chrome.runtime.lastError) {
          done('删除失败：' + chrome.runtime.lastError.message, false);
          return;
        }
        if (!r || !r.ok) {
          done('删除失败：' + ((r && r.reason) || '后台没有应答'), false);
          return;
        }
        done(r.already ? '这条在 B 站上本来就已经没了，本地已记账。' : '已删除，本地也记成「已删除」了。', true);
      });
    } catch (e) {
      done('删除失败：' + ((e && e.message) || e), false);
    }
  }

  function removeRow(rpid) {
    shown = shown.filter(function (x) { return String(x.rpid) !== String(rpid); });
    var list = document.getElementById('bc-mine-list');
    var row = list ? list.querySelector('[data-bc-row="' + rpid + '"]') : null;
    if (row && row.parentNode) row.parentNode.removeChild(row);
    if (!shown.length) renderState('这一栏已经空了。');
    updateCount();
  }

  /** 轻提示：删除结果 / 失败原因。几秒后自己消失 */
  var toastTimer = null;
  function toast(text, bad) {
    var t = document.getElementById('bc-mine-toast');
    if (!t) return;
    t.textContent = text;
    t.className = 'bc-mine__toast' + (bad ? ' bc-mine__toast--bad' : '');
    t.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 4000);
  }

  /* -------------------------------------------------- 版本自检（很重要） */

  /**
   * 内容脚本只在页面加载时注入一次。扩展更新之后，**已经开着的页面里跑的
   * 还是旧脚本** —— 那种情况下界面看起来只是"某个新功能没生效"，
   * 用户根本猜不到要刷新。所以这里自己比一下版本，对不上就直说。
   *
   * 返回值：true 表示本页脚本是旧的。
   */
  function stalePage() {
    try {
      var live = chrome.runtime.getManifest().version;
      return !!live && live !== PANEL_VERSION;
    } catch (e) {
      return false;
    }
  }

  function buildStaleBanner() {
    var live = '';
    try { live = chrome.runtime.getManifest().version; } catch (e) { /* 忽略 */ }
    var bar = el('div', 'bc-mine__stale');
    bar.appendChild(el('span', '', '扩展已经更新到 v' + live + '，但本页里跑的还是 v' +
      PANEL_VERSION + ' 的脚本 —— 所以新功能不会生效。'));
    var btn = el('button', 'bc-mine__reload', '刷新本页');
    btn.type = 'button';
    btn.addEventListener('click', function () { location.reload(); });
    bar.appendChild(btn);
    return bar;
  }

  function load() {
    renderState('正在读取…');
    closeModal();

    // 先把"脚本旧了"这件事说清楚，不然用户只会觉得功能坏了
    var box = panel();
    if (box && stalePage() && !box.querySelector('.bc-mine__stale')) {
      box.insertBefore(buildStaleBanner(), box.firstChild);
    }

    try {
      chrome.runtime.sendMessage({ type: 'GET_LIVE_COMMENTS', limit: 200 }, function (r) {
        if (chrome.runtime.lastError) {
          renderState(readErrorText(chrome.runtime.lastError.message));
          return;
        }
        if (!r || !r.ok) {
          renderState('读不到数据：' + ((r && r.reason) || '后台没有应答'));
          return;
        }
        renderItems(r);
      });
    } catch (e) {
      renderState(readErrorText((e && e.message) || e));
    }
  }

  /** 扩展刚更新/重载时，旧页面里的 chrome.runtime 会失效 —— 那句话要翻译成人话 */
  function readErrorText(msg) {
    var m = String(msg || '');
    if (/invalidated|context/i.test(m)) {
      return '扩展刚更新过或重新加载过，这个页面里的脚本已经失效了。按 F5 刷新一下就正常。';
    }
    return '读不到数据：' + m;
  }

  /* -------------------------------------------------- 进出我们那一栏 */

  /** 把它自己的内容收起来（不删，只是藏起来，返回时原样恢复） */
  function hideTheirContent() {
    var main = mainArea();
    if (!main) return;
    for (var i = 0; i < main.children.length; i++) {
      var c = main.children[i];
      if (c.id === PANEL_ID) continue;
      if (c.style.display !== 'none') {
        c.setAttribute('data-bc-prev-display', c.style.display || '');
        c.style.display = 'none';
      }
    }
  }

  function restoreTheirContent() {
    var main = mainArea();
    if (!main) return;
    for (var i = 0; i < main.children.length; i++) {
      var c = main.children[i];
      if (c.id === PANEL_ID) continue;
      if (c.hasAttribute('data-bc-prev-display')) {
        c.style.display = c.getAttribute('data-bc-prev-display');
        c.removeAttribute('data-bc-prev-display');
      }
    }
  }

  function markActive(on) {
    var mine = myItem();
    if (mine) mine.classList.toggle('is-active', !!on);

    if (!on) return;
    // 我们自己高亮的同时，把它原生高亮的那一项取消掉
    var list = sidebarList();
    if (!list) return;
    var items = list.querySelectorAll('li.message-sidebar__item');
    for (var i = 0; i < items.length; i++) {
      if (!items[i].hasAttribute(MARK)) items[i].classList.remove('is-active');
    }
  }

  function showMine() {
    var main = mainArea();
    if (!main) return;

    if (!panel()) main.appendChild(buildPanel());
    panel().style.display = '';
    hideTheirContent();
    markActive(true);

    showing = true;
    load();
  }

  function leaveMine() {
    if (!showing) return;
    showing = false;
    var p = panel();
    if (p) p.style.display = 'none';
    markActive(false);
    restoreTheirContent();
  }

  /* ------------------------------------------------------------ 接线 */

  // 它自己的栏目被点了 → 让位（用捕获，保证在它的 handler 之前）
  document.addEventListener('click', function (e) {
    var li = e.target && e.target.closest ? e.target.closest('li.message-sidebar__item') : null;
    if (!li || li.hasAttribute(MARK)) return;
    leaveMine();
  }, true);

  // 这个站是 hash 路由，切栏目会改 hash
  window.addEventListener('hashchange', leaveMine);

  // Esc 关掉确认弹窗
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  // Vue 重渲染会把我们插的那一栏冲掉，补回来
  var pending = null;
  function keepAlive() {
    if (pending) return;
    pending = setTimeout(function () {
      pending = null;
      injectTab();
      if (showing) {
        // 面板也可能被重渲染带走
        if (!panel()) { showing = false; showMine(); }
        else { markActive(true); hideTheirContent(); }
      }
    }, 200);
  }

  function watch() {
    injectTab();
    var root = document.querySelector('.message-sidebar') || document.body;
    if (!root) return;
    new MutationObserver(keepAlive).observe(root, { childList: true, subtree: true });
  }

  // SPA：侧栏是后渲染出来的，等它出现
  var tries = 0;
  (function waitForSidebar() {
    if (injectTab()) { watch(); return; }
    if (++tries > 60) return;              // 30 秒还没等到就算了，不当钉子户
    setTimeout(waitForSidebar, 500);
  })();
})();
