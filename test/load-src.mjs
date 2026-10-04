/**
 * 把 src/ 下的数据层模块合并成一个对象，给测试当"公共层"用。
 *
 * 为什么需要：`src/shared.js` 在 v1.10 拆成了几个模块（settings / util / urls /
 * store / export）。测试关心的是"这些函数合起来能不能用"，不想每加一个模块
 * 就去改三处 import 列表 —— 所以在这里集中一处。
 *
 * 只合并**纯数据/工具**模块：background.js / content.js / recorder-main.js
 * 这些一加载就碰 chrome.* 或 DOM，不能进测试的沙箱。
 */
export async function loadSrc() {
  const mods = ['settings.js', 'util.js', 'urls.js', 'store.js', 'video-info.js', 'export.js'];
  const out = {};
  for (const m of mods) {
    Object.assign(out, await import(`../src/${m}`));
  }
  return out;
}
