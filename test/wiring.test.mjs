/**
 * wiring.test.mjs —— 接线检查：相对 import 路径、具名导入、HTML 引用的资源是否都存在
 *
 * CI 里原有的检查只看 manifest.json 点名的那几个文件，管不到下面这几类错误：
 *   · JS 之间的相对 import 写错了路径
 *   · `import { foo }` 里的 foo 在目标模块里根本不存在
 *     （平时靠打包器报错，而这个项目零构建，没有打包器兜底）
 *   · HTML 里的 <script src> / <link href> 指向不存在的文件
 *
 * 这几类错误会让扩展在 chrome://extensions 里**直接加载失败**，或者跑到一半才炸。
 *
 * 纯 Node，零依赖：node test/wiring.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ 工具函数 */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = p => relative(ROOT, p).replace(/\\/g, '/');

/** 调用位置不该被当成"外部依赖"的东西 */
const JS_GLOBALS = new Set([
  'console', 'JSON', 'Math', 'Date', 'Number', 'String', 'Array', 'Object', 'RegExp',
  'Map', 'Set', 'Promise', 'Error', 'TypeError', 'Symbol', 'Boolean', 'URL',
  'URLSearchParams', 'Blob', 'FileReader', 'AbortController', 'TextEncoder',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'fetch', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'encodeURIComponent',
  'decodeURIComponent', 'btoa', 'atob', 'require', 'structuredClone'
]);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
  'new', 'do', 'else', 'delete', 'void', 'in', 'of', 'case', 'throw', 'yield'
]);

/** 把一个模块里所有具名导出的名字抓出来（正则足够，本项目没有花哨的导出语法） */
function exportNames(source) {
  const names = new Set();

  const decl = /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(decl)) names.add(m[1]);

  const list = /^[ \t]*export[ \t]*\{([^}]*)\}/gm;
  for (const m of source.matchAll(list)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t) names.add(t.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

/** 从 import 子句里取出具名导入（忽略 default 与 namespace 形式） */
function namedImports(clause) {
  const m = /\{([^}]*)\}/.exec(clause);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

const IMPORT_RE = /^[ \t]*import[ \t]+([^'"]*?)[ \t]*from[ \t]*['"]([^'"]+)['"]/gm;
const HTML_ATTR_RE = /\b(?:src|href)[ \t]*=[ \t]*["']([^"']+)["']/g;

/* ---------------------------------------------------------------- 用例 */

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`      ${(e && e.message) || e}`);
    failed++;
  }
}

const files = walk(ROOT);
const jsFiles = files.filter(f => /\.(js|mjs)$/.test(f));
const htmlFiles = files.filter(f => f.endsWith('.html'));

console.log('\n接线检查（import / 具名导入 / HTML 资源）\n');

test(`所有相对 import 都指向存在的文件（共 ${jsFiles.length} 个 JS）`, () => {
  const problems = [];
  let checked = 0;

  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;      // 只关心相对路径
      checked++;
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) {
        problems.push(`${rel(file)} → '${spec}'（解析为 ${rel(target)}，不存在）`);
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个 import 指向不存在的文件：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 实际检查了 ${checked} 条相对 import`);
});

test('所有具名导入在目标模块里确实有导出', () => {
  const problems = [];
  let checked = 0;

  // 先把每个 JS 文件的导出集合算出来
  const exportsOf = new Map();
  for (const file of jsFiles) {
    exportsOf.set(resolve(file), exportNames(readFileSync(file, 'utf8')));
  }

  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const clause = m[1];
      const spec = m[2];
      if (!spec.startsWith('.')) continue;

      const target = resolve(dirname(file), spec);
      const available = exportsOf.get(target);
      if (!available) continue;   // 目标不是本仓库的 JS，交给上一条用例管

      for (const name of namedImports(clause)) {
        checked++;
        if (!available.has(name)) {
          problems.push(`${rel(file)} 导入了 { ${name} }，但 ${rel(target)} 没有导出它`);
        }
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个具名导入对不上：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 实际核对了 ${checked} 个具名导入`);
});

test(`HTML 里的 src / href 都指向存在的文件（共 ${htmlFiles.length} 个页面）`, () => {
  const problems = [];
  let checked = 0;

  for (const file of htmlFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(HTML_ATTR_RE)) {
      const value = m[1].trim();
      // 跳过外链、锚点、内联数据等
      if (!value || /^(https?:|data:|mailto:|#|\/\/|chrome-extension:)/i.test(value)) continue;
      checked++;
      const target = resolve(dirname(file), value.split(/[?#]/)[0]);
      if (!existsSync(target)) {
        problems.push(`${rel(file)} 引用了 '${value}'（不存在）`);
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个资源引用不存在的文件：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 实际检查了 ${checked} 条 HTML 资源引用`);
});

test('src/ 的数据层模块都有人用，没有变成孤儿', () => {
  // src/shared.js 拆成了 settings / util / urls / store / export 五个模块。
  // 拆完最容易出的问题是"某一块没人 import 了"（功能被搬走、调用点没跟上），
  // 浏览器里就是一路 undefined。这里确认每个数据层模块至少有一个使用者。
  const DATA_MODULES = ['settings.js', 'util.js', 'urls.js', 'store.js', 'video-info.js', 'export.js'];
  const srcDir = join(ROOT, 'src');

  const usersOf = new Map(DATA_MODULES.map(m => [m, []]));
  const scanDirs = ['src', 'clean', 'popup', 'options'];

  for (const dir of scanDirs) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.js')) continue;
      const rel = dir + '/' + f;
      const s = readFileSync(join(ROOT, rel), 'utf8');
      for (const m of DATA_MODULES) {
        if (new RegExp(`from\\s+['"][^'"]*${m.replace('.', '\\.')}['"]`).test(s)) {
          usersOf.get(m).push(rel);
        }
      }
    }
  }

  const orphans = DATA_MODULES.filter(m => usersOf.get(m).length === 0);
  assert.equal(orphans.length, 0, `这些数据层模块没有任何人 import：${orphans.join(', ')}`);

  // 至少有两个以上的消费者，说明"公共层"这个定位还成立
  const sharedish = DATA_MODULES.filter(m => usersOf.get(m).length >= 2);
  assert.ok(sharedish.length >= 2,
    `公共层模块应该被多处引用，实际只有 ${sharedish.join(', ')} 满足`);

  console.log(`      [数据] src/ 数据层 ${DATA_MODULES.length} 个模块都有使用者：` +
    DATA_MODULES.map(m => `${m}(${usersOf.get(m).length})`).join(' '));
});

test('页面 JS 里 $\'id\' 引用的元素，HTML 里都得有', () => {
  // 这条原来是我手边的一个临时脚本，现在扶正 —— 改 HTML 时最容易犯的错就是
  // 删掉/改了一个 id，JS 那边还在 getElementById，跑起来才炸。
  // clean/ 拆成多模块之后，把所有模块合起来当作"页面脚本"看。
  const cleanDir = join(ROOT, 'clean');
  const cleanJs = readdirSync(cleanDir)
    .filter(f => f.endsWith('.js'))
    .map(f => readFileSync(join(cleanDir, f), 'utf8'))
    .join('\n');

  const pages = [
    { name: 'clean', js: cleanJs, html: readFileSync(join(cleanDir, 'clean.html'), 'utf8') },
    { name: 'popup', js: readFileSync(join(ROOT, 'popup/popup.js'), 'utf8'), html: readFileSync(join(ROOT, 'popup/popup.html'), 'utf8') },
    { name: 'options', js: readFileSync(join(ROOT, 'options/options.js'), 'utf8'), html: readFileSync(join(ROOT, 'options/options.html'), 'utf8') }
  ];

  const problems = [];
  let totalIds = 0;

  for (const page of pages) {
    const ids = new Set([...page.js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
    const htmlIds = new Set([...page.html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    totalIds += ids.size;

    for (const id of ids) {
      if (!htmlIds.has(id)) problems.push(`${page.name}: JS 引用了 #${id}，HTML 里没有`);
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 处 id 对不上：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 核对了三个页面共 ${totalIds} 个 id 引用`);
});

test('clean/ 各模块用到的跨模块符号，都必须真的 import 进来', () => {
  // 这条是补上一个真实踩过的坑：拆分时 `$` 的定义掉了（既没定义、也没 import），
  // 而"具名导入是否存在"那条查不出来 —— 它只查"导入了的不存在"，
  // 查不出"用了的既没定义也没导入"。浏览器里就是运行时 X is not defined。
  const cleanDir = join(ROOT, 'clean');
  const files = readdirSync(cleanDir).filter(f => f.endsWith('.js'));
  const sources = new Map(files.map(f => [f, readFileSync(join(cleanDir, f), 'utf8')]));

  // 每个模块导出了什么
  const exportedBy = new Map();
  for (const [f, s] of sources) {
    const names = new Set();
    for (const m of s.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      names.add(m[1]);
    }
    exportedBy.set(f, names);
  }

  const allExported = new Set();
  for (const set of exportedBy.values()) for (const n of set) allExported.add(n);

  const problems = [];

  for (const [f, raw] of sources) {
    // 剥注释再扫：注释里提到某个函数名不代表真有依赖
    //（state.js 的注释里写了 scheduleLibraryRefresh，差点让它凭空依赖 main.js）
    const s = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // 本文件自己“认领”的名字：定义的 + import 进来的 + 形参 + 局部变量。
    // 注意**不能只看顶层** —— 不然函数里的 `const done = ...`、回调参数
    // 都会被误判成"外部依赖"，检查就全是噪音了。
    const known = new Set(exportedBy.get(f));
    for (const m of s.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) known.add(m[1]);
    for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    // 解构：const { a, b: c } = ...  /  const [a, b] = ...
    for (const m of s.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
      for (const piece of m[1].split(',')) {
        const n = piece.trim().split(':').pop().trim().split(/[=\s]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n);
      }
    }
    for (const m of s.matchAll(/import\s*\{([^}]*)\}/g)) {
      for (const piece of m[1].split(',')) {
        const n = piece.trim().split(/\s+as\s+/).pop();
        if (n) known.add(n);
      }
    }
    // 形参只认"真的是函数参数表"的括号（function f(...) 或 (...) =>）。
    // 见到 ( ... ) { 就当形参的话，`if (state.running) {` 会把 state 误认成局部变量。
    for (const m of s.matchAll(/function\s*[A-Za-z_$]*\s*\(([^()]*)\)/g)) {
      for (const piece of m[1].split(',')) {
        const n = piece.trim().split(':').pop().trim().split(/[=\s.]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n);
      }
    }
    for (const m of s.matchAll(/(?:async\s*)?\(([^()]*)\)\s*=>/g)) {
      for (const piece of m[1].split(',')) {
        const n = piece.trim().split(':').pop().trim().split(/[=\s.]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n);
      }
    }
    for (const m of s.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*=>/g)) known.add(m[1]);
    for (const m of s.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) known.add(m[1]);

    // ① 用了某个"别的模块导出的名字"，但自己既不认识、也没 import
    for (const name of allExported) {
      if (known.has(name)) continue;

      // `$` 要特别小心：模板字符串的 `${…}`、正则的结尾锚点 `/…$/`
      // 都会让朴素的匹配以为"用到了 $"。所以它必须**跟一个左括号**才算调用。
      if (name === '$') {
        if (!/(?<![\w.$])\$\s*\(/.test(s)) continue;
      }

      const esc = name.replace(/\$/g, '\\$');
      // 用「后面不能再接标识符字符」而不是 \b —— 对 `$` 这类名字 \b 不成立
      const uses = [...s.matchAll(new RegExp(`(?<![\\w.$])${esc}(?![\\w$])`, 'g'))];
      // 还要排掉「对象字面量的键」：`{ id: 'live', label: '还在' }` 里的 label
      // 不是那个模块导出的函数。判据：紧跟冒号，且前面是 { 或 ,。
      const real = uses.filter(m => {
        if (!/^\s*:/.test(s.slice(m.index + name.length))) return true;
        const before = s.slice(0, m.index).replace(/\s+$/, '');
        return !/[{,]$/.test(before);
      });
      if (!real.length) continue;
      problems.push(`${f} 用了 ${name}，但既没定义也没 import`);
    }

    // ② 凡是当函数调用的名字，都得能落地。
    // 这一条才抓得住"定义被整个弄丢了" —— ① 抓不住：名字都没被谁导出，
    // 自然不在 allExported 里（`$` 那次就是这么漏掉的）。
    const seen = new Set();
    for (const m of s.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (known.has(name) || JS_GLOBALS.has(name) || KEYWORDS.has(name)) continue;
      const key = `${f}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`clean/${f} 调用了 ${name}()，但它既没定义也没 import`);
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 处跨模块符号没接上：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 核对了 ${files.length} 个模块之间的符号引用`);
});

test('clean/ 各模块没有重复 import 同名绑定，也没有循环依赖', () => {
  // 重复 import 同名绑定在 ES 模块里是**语法错误**（Identifier already declared）——
  // 整页加载失败。而测试夹具会把 import 整个剥掉，所以它**测不出来**。
  // 踩过一次：补 import 的脚本只追加不清理，跑三次就变成三份。
  const cleanDir = join(ROOT, 'clean');
  const files = readdirSync(cleanDir).filter(f => f.endsWith('.js'));
  const problems = [];

  const graph = new Map();   // 模块 -> 它依赖的模块

  for (const f of files) {
    const s = readFileSync(join(cleanDir, f), 'utf8');
    const seen = new Map();   // 名字 -> 第几行
    const deps = new Set();

    for (const m of s.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']*)';\s*$/gm)) {
      const line = s.slice(0, m.index).split('\n').length;
      const target = m[2];

      if (target.startsWith('.')) {
        const dep = target.replace(/^\.\//, '');
        if (files.includes(dep)) deps.add(dep);
      }

      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop();
        if (!name) continue;
        if (seen.has(name)) {
          problems.push(`clean/${f}: ${name} 被 import 了两次（第 ${seen.get(name)} 行和第 ${line} 行）`);
        } else {
          seen.set(name, line);
        }
      }
    }
    graph.set(f, deps);
  }

  // 循环依赖：能走回自己
  const cycles = [];
  for (const start of files) {
    const stack = [[start, [start]]];
    while (stack.length) {
      const [cur, path] = stack.pop();
      for (const next of (graph.get(cur) || [])) {
        if (next === start && path.length > 1) cycles.push(path.concat(next).join(' -> '));
        else if (!path.includes(next) && path.length < 8) stack.push([next, path.concat(next)]);
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 处重复 import：\n      ${problems.join('\n      ')}`);
  // 循环依赖本身 ES 模块能处理（函数声明会提升），但多起来就是维护地狱，这里只提示不改判
  if (cycles.length) console.log(`      [提示] 存在循环依赖：${[...new Set(cycles)].slice(0, 3).join(' / ')}`);
  else console.log('      [数据] 模块依赖无环');
});

test('内容脚本里一条 import 都不能有（它们是经典脚本，不是模块）', () => {
  // 踩过：全仓库补 import 的脚本给内容脚本也塞了 import ——
  // 而 manifest 的 content_scripts 注入的是**经典脚本**，
  // 里面出现 import 就是 "Cannot use import statement outside a module"，
  // 扩展装上去直接不工作。
  //
  // 顺带把"哪些是内容脚本"这件事绑到 manifest 上 —— 以后加了新脚本自动覆盖。
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = (mf.content_scripts || []).flatMap(cs => cs.js || []);
  assert.ok(scripts.length >= 4, `manifest 里的内容脚本看起来不对：${scripts.length} 个`);

  const problems = [];
  for (const p of scripts) {
    const src = readFileSync(join(ROOT, p), 'utf8');
    if (/^\s*import\s/m.test(src)) problems.push(`${p} 里有 import`);
  }

  // background 是 module（manifest 里写了 type: module），所以它**该**有 import
  assert.equal(mf.background.type, 'module', 'background 应该是 module 类型');
  const bg = readFileSync(join(ROOT, mf.background.service_worker), 'utf8');
  assert.match(bg, /^import /m, 'background 是模块，应该从别的模块拿东西');

  assert.equal(problems.length, 0,
    `这些内容脚本里出现了 import（经典脚本不支持）：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] manifest 里的 ${scripts.length} 个内容脚本都没有 import`);
});

test('界面和文档里不出现彩色 emoji', () => {
  // 用户明确要求过：emoji 观感太浮躁，和这种工具类界面不搭。
  //
  // 注意区分：
  //   · 彩色 emoji（🗂️⚠️✅❌⛔🧹🎉⚙️ 这类，Emoji_Presentation）—— 不要
  //   · 排版符号（✓ ✗ · → ← ▸ ┃ 这类，单色 dingbat）—— 保留，
  //     日志里就靠 ✓/✗ 扫读，去掉反而更难用
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
  // ✓(2713) ✗(2717) 是 dingbat，不是 emoji，明确放行
  const ALLOW = /[\u2713\u2717]/g;

  const targets = [
    ...htmlFiles.map(rel),
    ...jsFiles.map(rel),
    'README.md',
    'CHANGELOG.md'
  ].filter(p => !p.startsWith('test/'));

  const problems = [];
  for (const p of targets) {
    const src = readFileSync(join(ROOT, p), 'utf8');
    src.split('\n').forEach((line, i) => {
      const stripped = line.replace(ALLOW, '');
      const m = stripped.match(EMOJI);
      if (m) problems.push(`${p}:${i + 1} 有 ${[...new Set(m)].join(' ')}`);
    });
  }

  assert.equal(problems.length, 0,
    `有 ${problems.length} 处彩色 emoji：\n      ${problems.slice(0, 8).join('\n      ')}`);
  console.log(`      [数据] 核对了 ${targets.length} 个文件，没有彩色 emoji`);
});

test('注入 B 站消息页的那一栏，用的是它自己的类名（看起来才像原生）', () => {
  // 这一条是**和 B 站页面之间的契约**。结构是我从它的 bundle 里挖出来的
  // （message-pc/static/js/index.*.js）：
  //   ul.message-sidebar__interactions > li.message-sidebar__item[.is-active]
  //     > div.message-sidebar__item-icon.dot + div.message-sidebar__item-name
  // 用它的类名，样式就自动跟着走（亮/暗主题也是），不用自己画一套。
  // 哪天 B 站改版改了这些类名，这条会红 —— 那时候去更新注入逻辑，而不是等用户报。
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const entry = (mf.content_scripts || []).find(cs => (cs.js || []).some(f => f.includes('my-comments-panel')));
  assert.ok(entry, 'manifest 里应该有注入 B 站消息页的内容脚本');
  assert.ok(entry.matches.some(m => m.includes('message.bilibili.com')),
    '它应该只跑在 message.bilibili.com 上');
  assert.ok((entry.css || []).length, '它应该有配套的样式文件');

  const src = readFileSync(join(ROOT, 'src/my-comments-panel.js'), 'utf8');
  for (const cls of [
    'message-sidebar__interactions',
    'message-sidebar__item',
    'message-sidebar__item-icon',
    'message-sidebar__item-name',
    'is-active',
    'message-main'
  ]) {
    assert.ok(src.includes(cls), `注入脚本里少了 B 站的原生类名 ${cls}`);
  }

  // 我们自己的样式只该用 bc- 前缀，别去污染它页面上别的元素
  // （扫之前先剥注释 —— 注释里写 "my-comments-panel.js" 会被当成类名 .js）
  const css = readFileSync(join(ROOT, entry.css[0]), 'utf8');
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const mine = [...new Set([...cssCode.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]))];
  const intruders = mine.filter(c => !c.startsWith('bc-'));
  assert.equal(intruders.length, 0, `样式里出现了非 bc- 前缀的类名，会污染页面：${intruders.join(', ')}`);

  // 脚本里用到的 bc- 类，样式里都得有。
  // 只从"确实是当类名用的地方"取：el(tag, 'cls')、classList.xxx('cls')、class="…"。
  // 不能简单地把所有 bc- 开头的字符串都算上 —— 还有 id（bc-my-comments）
  // 和 data- 属性（data-bc-prev-display）也叫这个名字。
  const used = new Set();
  for (const m of src.matchAll(/el\([^,]+,\s*'([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('bc-')) used.add(c);
  }
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('bc-')) used.add(c);
  }
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('bc-')) used.add(c);
  }

  const missing = [...used].filter(c => !new RegExp('\\.' + c + '(?![\\w-])').test(cssCode));
  assert.equal(missing.length, 0, `脚本用了但没有样式的类：${missing.join(', ')}`);

  console.log(`      [数据] 契约类名齐全，${used.size} 个 bc- 类都有样式`);
});

test('注入脚本拼出来的 HTML，标签必须配对', () => {
  // 用户截图里发现的 bug：拼一行评论时多写了一个 </div>，把行容器提前闭合，
  // 于是「打开」链接掉到容器外面、被浏览器当成块级元素排到了下一行。
  // 页面上不报错，只是**排版悄悄错了** —— 这类问题只能靠结构检查。
  //
  // 范围是**整个 rowHtml 函数体**，不只是最后那句 return ——
  // 链接和按钮是在上面的变量里拼的（第一版检查只扫 return，漏了它们）。
  const src = readFileSync(join(ROOT, 'src/my-comments-panel.js'), 'utf8');

  const at = src.indexOf('function rowHtml(');
  assert.ok(at > 0, '找不到 rowHtml（改了名字的话这条也要跟着改）');
  const end = src.indexOf('\n  }\n', at);
  assert.ok(end > at, '找不到 rowHtml 的结尾');
  const frag = src.slice(at, end);

  for (const tag of ['div', 'span', 'a', 'button']) {
    const open = (frag.match(new RegExp('<' + tag + '\\b', 'g')) || []).length;
    const close = (frag.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert.equal(open, close,
      `rowHtml 里 <${tag}> 开 ${open} 个、闭 ${close} 个 —— 拼出来的 HTML 不配对`);
    assert.ok(open > 0, `rowHtml 里一个 <${tag}> 都没有？范围可能取错了`);
  }

  console.log(`      [数据] rowHtml 里的 div/span/a/button 都配对`);
});

test('消息页脚本里那份 PANEL_VERSION 必须和 manifest 的版本一致', () => {
  // 内容脚本只在页面加载时注入一次 —— 扩展更新之后，已经开着的页面里跑的
  // 还是旧脚本。旧脚本读 `chrome.runtime.getManifest()` 拿到的是**新**版本号，
  // 所以它自己发现不了"我是旧的"。
  //
  // 于是在脚本里手写一份它自己的版本号，跟 manifest 比：对不上就提示用户刷新。
  // 这条测试保证那份手写的版本号不会忘了跟着版本一起改（忘了就等于自检失效）。
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const src = readFileSync(join(ROOT, 'src/my-comments-panel.js'), 'utf8');

  const m = src.match(/var PANEL_VERSION = '([^']+)'/);
  assert.ok(m, '内容脚本里应该有 PANEL_VERSION');
  assert.equal(m[1], mf.version,
    `PANEL_VERSION 是 ${m[1]}，但 manifest 是 ${mf.version} —— 版本自检会失效`);

  // 还得真的用它来自检并提示
  assert.match(src, /getManifest\(\)\.version/, '要用 getManifest 拿当前版本做对比');
  assert.match(src, /bc-mine__stale|刷新本页/, '发现版本不一致时要提示用户刷新');
  console.log(`      [数据] PANEL_VERSION ${m[1]} 与 manifest 一致`);
});

test('HTML 里用到的 class 都在 ui.css 里有定义', () => {
  // 重做样式时最容易漏的就是这个：HTML 改了类名、CSS 没跟上，
  // 页面不报错、也不影响测试，只是那块元素悄悄失去样式。
  const css = readFileSync(join(ROOT, 'src/ui.css'), 'utf8');
  const problems = [];
  let checked = 0;

  for (const file of htmlFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/).filter(Boolean)) {
        checked++;
        const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 后面不能再接标识符字符，否则 .btn 会被 .btn-mini 这类规则误判为已定义
        if (!new RegExp('\\.' + esc + '(?![\\w-])').test(css)) {
          problems.push(`${rel(file)} 用了 .${cls}，但 src/ui.css 里没有定义`);
        }
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个 class 没有样式：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 核对了 ${checked} 处 class 引用`);
});

test('manifest.json 里点名的每个文件都存在（含图标与侧边栏页面）', () => {
  // CI 里那一步只看了 background / popup / options / content_scripts，
  // 漏掉图标的话扩展会在 chrome://extensions 直接报错，但谁都不会想到去查 manifest 的 icons。
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

  const named = new Set();
  if (m.background?.service_worker) named.add(m.background.service_worker);
  if (m.action?.default_popup) named.add(m.action.default_popup);
  if (m.options_page) named.add(m.options_page);
  if (m.side_panel?.default_path) named.add(m.side_panel.default_path);
  for (const p of Object.values(m.icons || {})) named.add(p);
  for (const p of Object.values(m.action?.default_icon || {})) named.add(p);
  for (const cs of m.content_scripts || []) for (const j of cs.js || []) named.add(j);

  const missing = [...named].filter(f => !existsSync(join(ROOT, f)));
  assert.equal(missing.length, 0, `manifest 引用了不存在的文件：${missing.join(', ')}`);
  console.log(`      [数据] manifest 点名了 ${named.size} 个文件，全都在`);
});

/* ------------------------------------------- 主世界 → 隔离世界 → 后台的三种 kind */

await test('recorder-main 报的 kind，content.js 都认得', () => {
  const main = readFileSync(join(ROOT, 'src', 'recorder-main.js'), 'utf8');
  const content = readFileSync(join(ROOT, 'src', 'content.js'), 'utf8');

  // 主世界发出去的 kind
  const kinds = new Set();
  for (const m of main.matchAll(/kind:\s*'([a-z]+)'/g)) kinds.add(m[1]);
  assert.ok(kinds.has('deleted'), '删评论要报 deleted');
  assert.ok(kinds.has('nav'), '登录 UID 要报 nav');

  // content.js 得把每个 kind 翻成对应的后台消息类型
  assert.match(content, /p\.kind === 'deleted'[\s\S]{0,80}'COMMENT_DELETED'/,
    'content.js 得认得 deleted');
  assert.match(content, /p\.kind === 'nav'[\s\S]{0,80}'BILI_UID'/,
    'content.js 得认得 nav（自动识别 UID 走这条）');

  // 后台得有人在听 BILI_UID，否则消息发出去没人接，静默失效
  const bg = readFileSync(join(ROOT, 'src', 'background.js'), 'utf8');
  assert.match(bg, /msg\.type === 'BILI_UID'/, '后台要监听 BILI_UID');
});

await test('自动识别 UID 用的是 B 站自己的登录态接口', () => {
  const main = readFileSync(join(ROOT, 'src', 'recorder-main.js'), 'utf8');
  assert.match(main, /x\/web-interface\/nav/, '要读 /x/web-interface/nav');
  assert.match(main, /data[\s\S]{0,40}isLogin/, '没登录就不能报');
  assert.match(main, /d\.mid/, 'UID 取自 data.mid');
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
