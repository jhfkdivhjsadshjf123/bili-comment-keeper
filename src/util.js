/**
 * 杂项工具：延时、随机、转义、错误码翻译、书签目录
 *
 * 从 src/shared.js 拆出来的。background 与三个页面共用，所以这里
 * **不能碰任何 DOM** —— service worker 里没有 document。
 */

import { getSettings } from './settings.js';

/**
 * 确保「容器目录 / 目录名」存在，返回它的 id。
 *
 * 只在设置里打开了「同时写入浏览器收藏夹」时才会被调用 ——
 * 数据以本地库为准，收藏夹只是个可选的镜像。
 */
export async function ensureFolder(title) {
  const settings = await getSettings();
  const rootId = String(settings.rootParent || '2') === '1' ? '1' : '2';
  const name = String(title || '').trim() || '未命名';

  const pick = async function (parentId, want) {
    const children = await chrome.bookmarks.getChildren(parentId).catch(function () { return []; });
    const hit = children.find(n => !n.url && n.title === want);
    if (hit) return hit.id;
    const node = await chrome.bookmarks.create({ parentId: parentId, title: want });
    return node.id;
  };

  const container = String(settings.containerFolder || '').trim();
  const parent = container ? await pick(rootId, container) : rootId;
  return await pick(parent, name);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function randInt(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(a, Number(max) || a);
  return Math.floor(a + Math.random() * (b - a));
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 把接口错误码翻译成人话 */
export function explainCode(code, message) {
  const map = {
    0: '成功',
    '-101': '账号未登录（请先在浏览器里登录 B 站）',
    '-102': '账号被封停',
    '-111': 'csrf 校验失败（登录态异常，建议重新登录）',
    '-400': '请求错误',
    '-403': '权限不足',
    '-404': '无此页',
    '-509': '请求过于频繁（触发了风控限流）',
    12002: '评论区已关闭',
    12004: '禁止操作（已被拉黑或评论被锁）',
    12006: '没有该评论',
    12009: '评论主体的 type 不合法',
    12022: '该评论已经被删除了'
  };
  const key = String(code);
  if (map[key]) return map[key];
  return message ? String(message) : ('未知错误 code=' + key);
}
