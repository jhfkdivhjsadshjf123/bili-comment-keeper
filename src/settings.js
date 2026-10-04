/**
 * 设置：读取、写入、默认值
 *
 * 从 src/shared.js 拆出来的。background 与三个页面共用，所以这里
 * **不能碰任何 DOM** —— service worker 里没有 document。
 */

export const DEFAULT_SETTINGS = {
  enabled: true,                    // 是否开启自动记录
  minDelay: 1500,                   // 删除间隔下限（毫秒）
  maxDelay: 4000,                   // 删除间隔上限（毫秒）
  clipboardFallback: false,         // 手动「复制评论链接」时也记录（可能误记别人的评论，默认关）
  // 角标显示什么：off=不显示（默认，定位是管理器不是任务列表）/ live=库里的存活条数 / pending=待处理总数
  badgeMode: 'off',
  // 还要不要往浏览器收藏夹里写书签。默认关：数据以本地库为准。
  // 留这个开关只是给"想在浏览器书签里也能翻到"的人用。
  useBookmarks: false,
  // 收藏夹相关（只在 useBookmarks 打开时才有意义）
  rootParent: '2',                  // 放在哪：'1' = 书签栏，'2' = 其他收藏夹
  containerFolder: '评论管家',       // 上层容器目录名
  folderActive: 'B站我的评论'        // 评论链接目录
};

export const K_SETTINGS = 'bc_settings';

export async function getSettings() {
  const o = await chrome.storage.local.get(K_SETTINGS);
  return Object.assign({}, DEFAULT_SETTINGS, o[K_SETTINGS] || {});
}

export async function setSettings(patch) {
  const next = Object.assign(await getSettings(), patch);
  await chrome.storage.local.set({ [K_SETTINGS]: next });
  return next;
}
