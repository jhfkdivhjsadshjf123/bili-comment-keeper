/**
 * video-info.js —— 按 aid 取视频标题 / UP 主
 *
 * 来源：库里只存了 `type:oid`，显示出来就是一堆 `av123456789`，没人看得懂。
 * 标题是阅读时的刚需，所以做一份按视频缓存的抓取。
 *
 * 只处理视频（type 1）。专栏 / 动态的接口各不相同，先不碰 ——
 * 那两种在界面上退回短标签（`cv888` / `t.bilibili.com/999`）。
 *
 * 这一层**不碰 chrome.*、不碰 DOM**，所以 Node 里能直接加载、测得到。
 * 抓到的标题通过 store.js 的 saveVideoTitles 落盘，所以每个视频只会请求一次。
 */

import { getLibrary, saveVideoTitles, videoKey } from './store.js';
import { sleep } from './util.js';

/** 抓一批标题时的间隔 —— 别把接口打得太急 */
const THROTTLE_MS = 250;

/**
 * 取一个视频的信息。失败（被反爬、视频没了、不是视频）一律返回 null，
 * 调用方当作"这个拿不到"处理就行了。
 */
export async function fetchVideoInfo(type, oid) {
  if (Number(type) !== 1) return null;
  const id = String(oid || '');
  if (!/^\d+$/.test(id)) return null;

  let res;
  try {
    res = await fetch('https://api.bilibili.com/x/web-interface/view?aid=' + id, {
      credentials: 'omit'
    });
  } catch (e) {
    return null;
  }
  if (!res || !res.ok) return null;

  let json;
  try { json = await res.json(); } catch (e) { return null; }

  const d = json && json.code === 0 && json.data;
  if (!d || !d.title) return null;

  return {
    title: String(d.title).slice(0, 200),
    bvid: String(d.bvid || ''),
    owner: String((d.owner && d.owner.name) || '')
  };
}

/**
 * 给一批 `{ type, oid }` 补标题，抓到就存进库。
 *
 * 已经缓存过的直接跳过（不消耗请求）。返回 **key -> 标题** 的映射，
 * 调用方拿它去更新界面上那几行就行。
 *
 * `limit` 是硬上限：页面上可能有几百条评论、对应几百个不同视频，
 * 一次全抓既慢又没必要 —— 先抓眼前这几条，剩下的下次打开接着来。
 */
export async function fillVideoTitles(list, limit) {
  const want = Math.max(0, Math.min(50, Number(limit) || 12));
  const items = Array.isArray(list) ? list : [];
  if (!want || !items.length) return {};

  // 去重 + 跳过非视频 + **跳过已经缓存过的**（那才是"每个视频只请求一次"的关键）
  const lib = await getLibrary();
  const seen = new Set();
  const todo = [];
  for (const it of items) {
    if (Number(it && it.type) !== 1) continue;
    const key = videoKey(it.type, it.oid);
    if (seen.has(key) || lib.videos[key]) continue;
    seen.add(key);
    todo.push({ key: key, type: it.type, oid: it.oid });
    if (todo.length >= want) break;
  }

  const map = {};
  for (let i = 0; i < todo.length; i++) {
    const info = await fetchVideoInfo(todo[i].type, todo[i].oid);
    if (info && info.title) map[todo[i].key] = info;
    if (i < todo.length - 1) await sleep(THROTTLE_MS);
  }

  if (Object.keys(map).length) await saveVideoTitles(map);
  return map;
}
