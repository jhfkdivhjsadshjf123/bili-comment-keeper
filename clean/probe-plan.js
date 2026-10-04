/**
 * probe-plan.js —— 「巡检到底查哪些条目」的唯一规则
 *
 * 为什么要单独一个文件：这条规则被**两处**用着 ——
 *   · 界面：按钮灰不灰、文案叫什么（clean/import.js 的 refreshAicuButtons）
 *   · 执行：真正去查哪些状态（clean/probe.js 的 probeAicuAlive）
 * 两处各写一份的话，迟早会分叉（按钮说能查、点了却说不该查，这种 bug 最难查）。
 *
 * 放这里还能避开一个循环依赖：probe.js 已经从 import.js 拿 loadAicu / setAicuHint 了，
 * 如果 import.js 再反过来 import probe.js 拿这个函数，就成环了。
 *
 * 规则一句话：**查当前筛选出来的条目，但已没了和已删除除外。**
 *
 *   选中         实际检查                 按钮
 *   未检查       未检查的                 巡检存活
 *   已检查       还在 + 查不到            重新检查
 *   还在         还在的                   重新检查
 *   查不到       查不到的                 重新检查
 *   全部         还在 + 查不到 + 未检查   检查全部
 *   已没了       ——                       灰
 *   已删除       ——                       灰
 *
 * 为什么已没了 / 已删除永远不查：那两条的结论是**确定**的（一条确认没了、
 * 一条是我们自己删的），重问一遍既浪费请求，也问不出新东西。
 * 所以它们既不能单选着查，也不会被「全部」顺带扫进去。
 */

import { state } from './state.js';

/** 值得再问一次 B 站的状态 */
export const PROBE_STATES = ['live', 'unreachable', 'unknown'];

/** 「已检查」在库里的意思 = 除 unknown 之外的四态 */
const ALL_CHECKED = ['live', 'gone', 'deleted', 'unreachable'];

const FILTER_NAME = {
  all: '全部', checked: '已检查', live: '还在',
  gone: '已没了', deleted: '已删除', unreachable: '查不到', unknown: '未检查'
};

/**
 * 返回 { states, label, ok, why }：
 *   states  要检查的状态列表
 *   label   按钮上该写什么
 *   ok      能不能查（false 时按钮应置灰）
 *   why     不能查的原因（给人看的）
 */
export function probePlan() {
  const picked = Array.isArray(state.libStates) ? state.libStates : [];

  // 没选、或选了「全部」
  if (!picked.length || picked.includes('all')) {
    return { states: PROBE_STATES.slice(), label: '检查全部', ok: true, why: '' };
  }

  const states = [];
  for (const s of picked) {
    for (const one of (s === 'checked' ? ALL_CHECKED : [s])) {
      if (PROBE_STATES.includes(one) && !states.includes(one)) states.push(one);
    }
  }

  if (!states.length) {
    return {
      states: [], label: '巡检存活', ok: false,
      why: '「' + picked.map(id => FILTER_NAME[id] || id).join('、') +
        '」的结论已经是确定的了，没有再查的必要。要重新检查请选「已检查」「查不到」或「还在」。'
    };
  }

  const onlyUnknown = states.length === 1 && states[0] === 'unknown';
  return { states: states, label: onlyUnknown ? '巡检存活' : '重新检查', ok: true, why: '' };
}
