/**
 * 备份：导出 / 导入
 *
 * 从 clean.js 拆出来的。面板是原生 ES 模块（零构建）：
 * 模块之间靠 import 拿对方的东西，跨模块共享的可变状态都在 state.js。
 */

import { loadAicu, setAicuHint } from './import.js';
import { exportLibraryHTML, exportLibraryJSON, exportLibraryMarkdown, importLibraryJSON } from '../src/export.js';

export function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 在扩展页面里下载一段文本。
 * 用 Blob + <a download>，**不需要 downloads 权限** —— 为一个导出功能多要一项权限不值。
 */
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
}

export async function doExport(kind) {
  setAicuHint('正在生成备份…', '');
  const name = `b站评论备份-${stamp()}`;
  try {
    if (kind === 'json') {
      downloadText(name + '.json', await exportLibraryJSON(), 'application/json');
      setAicuHint('已导出 JSON。它是完整备份（含存活结论和视频标题），可以用「导入备份」原样恢复。', '');
    } else if (kind === 'html') {
      downloadText(name + '.html', await exportLibraryHTML(), 'text/html');
      setAicuHint('已导出 HTML。双击就能在浏览器里离线翻看，不依赖扩展、不联网。', '');
    } else {
      downloadText(name + '.md', await exportLibraryMarkdown(), 'text/markdown');
      setAicuHint('已导出 Markdown，方便丢进笔记软件。', '');
    }
  } catch (e) {
    setAicuHint('导出失败：' + ((e && e.message) || e), 'bad');
  }
}

export async function doImport(file) {
  if (!file) return;
  setAicuHint('正在导入备份…', '');
  try {
    const r = await importLibraryJSON(await file.text());
    if (!r || !r.ok) {
      setAicuHint('导入失败：' + ((r && r.reason) || '文件读不出来'), 'bad');
      return;
    }
    await loadAicu();
    setAicuHint(`导入完成：新增 ${r.added} 条，补全 ${r.enriched} 条，` +
      `现共 ${r.total} 条。已有的存活结论不会被覆盖。`, '');
  } catch (e) {
    setAicuHint('导入失败：' + ((e && e.message) || e), 'bad');
  }
}
