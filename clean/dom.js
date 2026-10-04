/**
 * 通用 UI 小工具（提示条、日志、进度）
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { state } from './state.js';
import { fmtTime } from '../src/urls.js';

/** 取元素。面板里到处在用，所以放最前面。 */
export const $ = id => document.getElementById(id);

export function setHint(text, kind) {
  const el = $('hint');
  el.className = 'hint' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

export function log(line) {
  const el = $('log');
  el.textContent += `[${fmtTime(Date.now())}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

/** 失败时用的日志：顺手把日志区展开，别让它埋在折叠里没人看见 */
export function logError(line) {
  log(line);
  if (state.logAutoOpened) return;
  state.logAutoOpened = true;
  const fold = $('fold-log');
  if (fold) fold.open = true;
}
