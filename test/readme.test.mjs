/**
 * readme.test.mjs —— 文档与代码的一致性
 *
 * 为什么要专门测这个：README 一度停留在"收藏夹 + 索引 + 云同步"那套架构上
 * （那套 v1.7 就拆了），徽章指向旧仓库、写着 Chrome 111+，
 * 导入流程里还留着已经不存在的「存入收藏夹」按钮。
 *
 * **文档漂移比代码 bug 更难发现 —— 因为它不报错。** 用户照着做才发现对不上。
 * 所以这里把"README 声称的事实"逐条拿去比对代码，用断言钉住。
 *
 * 纯 Node，零依赖：node test/readme.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`      ${(e && e.message) || e}`);
    failed++;
  }
}

const read = p => readFileSync(join(ROOT, p), 'utf8');
const RD = read('README.md');
const MF = JSON.parse(read('manifest.json'));
const SETTINGS = read('src/settings.js');

console.log('\n— 徽章与元信息 —');

await test('README 与 manifest 里的仓库地址都指向当前 owner', () => {
  // 这里**不写旧 owner 的字面量**：这条测试本来就是"别残留旧名字"，
  // 把旧名字钉在测试代码里等于换个地方留着它。改成正面断言：
  // 凡是出现 <owner>/bili-comment-keeper 的地方，owner 必须都是当前这个。
  const OWNER = 'jhfkdivhjsadshjf123';
  for (const [what, text] of [['README', RD], ['manifest.json', read('manifest.json')]]) {
    const owners = [...text.matchAll(/github\.com\/([\w.-]+)\/bili-comment-keeper/g)].map(m => m[1]);
    assert.ok(owners.length, `${what} 里一个仓库地址都没有？`);
    const wrong = [...new Set(owners)].filter(o => o !== OWNER);
    assert.equal(wrong.length, 0, `${what} 里还残留别的 owner：${wrong.join(', ')}`);
  }
  assert.match(RD, new RegExp(`${OWNER}/bili-comment-keeper`), 'README 没指向当前仓库');
});

await test(`README 写的 Chrome 版本与 manifest 一致（${MF.minimum_chrome_version}）`, () => {
  assert.ok(RD.includes(`${MF.minimum_chrome_version} 或更高`),
    `README 里找不到"${MF.minimum_chrome_version} 或更高"`);
  assert.doesNotMatch(RD, /chrome-111/, '还残留着 Chrome 111+ 的旧说法');
});

console.log('\n— 已拆掉的老架构，不能讲成现状 —');

/**
 * 这些词允许出现在"已拆掉"的说明里（那是对的，得告诉用户东西去哪了），
 * 但不能出现在功能介绍的位置。判据：那一行或它上一行有没有"拆掉/不再/老架构"之类。
 */
const RETIRED_CONTEXT = /拆掉|拆了|不再|老架构|旧架构|曾经|v1\.7|CHANGELOG|那套架构/;
const nearLines = RD.split('\n').map((_, i, all) => all.slice(Math.max(0, i - 1), i + 1).join(' '));

await test('README 没把收藏夹 / 索引 / 云同步讲成现在的功能', () => {
  const strict = [
    ['存入收藏夹', '那个按钮已经不存在了'],
    ['B站已删除评论目录', '书签归档目录已经不存在了'],
    ['本地书签账本', '账本现在在库里，不是书签']
  ];
  for (const [word, why] of strict) {
    assert.ok(!RD.includes(word), `README 里出现「${word}」—— ${why}`);
  }

  // 「云同步」允许在"已拆掉"的句子里出现
  const bad = nearLines.filter(l => l.includes('云同步') && !RETIRED_CONTEXT.test(l));
  assert.equal(bad.length, 0, `README 把「云同步」讲成了现状：${(bad[0] || '').trim().slice(0, 60)}`);
});

console.log('\n— 权限表 —');

await test('manifest 里每项权限，README 都交代过', () => {
  for (const p of MF.permissions) {
    assert.ok(RD.includes('`' + p + '`'), `README 没交代 ${p} 权限`);
  }
  for (const h of MF.host_permissions) {
    assert.ok(RD.includes(h), `README 没交代主机权限 ${h}`);
  }
});

await test('bookmarks 被说明成"可选、默认关"（它确实不再是必需的）', () => {
  const defaults = SETTINGS.split('export const DEFAULT_SETTINGS')[1].split('};')[0];
  assert.match(defaults, /useBookmarks:\s*false/, 'useBookmarks 默认应该是关的');
  assert.ok(/默认\*\*关闭\*\*|默认\*\*关\*\*/.test(RD), 'README 没说清书签镜像是默认关的');
});

console.log('\n— 设置项 —');

await test('README 描述的默认值与 DEFAULT_SETTINGS 一致', () => {
  const defaults = SETTINGS.split('export const DEFAULT_SETTINGS')[1].split('};')[0];
  for (const key of ['enabled', 'clipboardFallback', 'badgeMode', 'useBookmarks', 'minDelay', 'maxDelay']) {
    assert.ok(defaults.includes(key), `DEFAULT_SETTINGS 里没有 ${key}（README 可能是照着旧版本写的）`);
  }

  const min = /minDelay:\s*(\d+)/.exec(defaults)[1];
  const max = /maxDelay:\s*(\d+)/.exec(defaults)[1];
  assert.ok(RD.includes(`${min} ~ ${max}`) || RD.includes(`${min}~${max}`),
    `README 写的删除间隔与默认值（${min}~${max}）对不上`);

  assert.ok(RD.includes('不显示'), 'README 没写角标默认不显示');
  assert.ok(RD.includes('剪贴板兜底'), 'README 没写剪贴板兜底');
});

console.log('\n— 代码地图 —');

await test('clean/ 下每个模块都在 README 的代码地图里', () => {
  const files = readdirSync(join(ROOT, 'clean')).filter(f => f.endsWith('.js'));
  for (const f of files) {
    assert.ok(RD.includes('`' + f + '`'), `README 的代码地图里没有 clean/${f}`);
  }
  console.log(`      [数据] clean/ 下 ${files.length} 个模块都在地图里`);
});

await test('src/ 的模块表是当前的，没有已经删掉的文件', () => {
  for (const f of ['store.js', 'settings.js', 'urls.js', 'export.js', 'util.js', 'background.js']) {
    assert.ok(RD.includes('`' + f + '`'), `README 的代码地图里没有 src/${f}`);
    assert.ok(existsSync(join(ROOT, 'src', f)), `src/${f} 根本不存在（README 写错了）`);
  }
  assert.ok(!RD.includes('`shared.js`'), 'README 里还有已经不存在的 src/shared.js');
});

await test('README 提醒了内容脚本不能写 import', () => {
  assert.ok(RD.includes('经典脚本'), 'README 没提醒内容脚本是经典脚本');
  assert.match(RD, /import/, 'README 没说清"不能有 import"这件事');
});

console.log('\n— 测试命令 —');

await test('README 里给的跑测试命令都是真的', () => {
  for (const f of ['wiring', 'aicu', 'clean', 'library']) {
    assert.ok(existsSync(join(ROOT, `test/${f}.test.mjs`)), `test/${f}.test.mjs 不存在`);
    assert.ok(RD.includes(`node test/${f}.test.mjs`), `README 里没给 test/${f}.test.mjs 的运行方式`);
  }
  // 这一份自己也得被列进去，否则它就成了"没人跑的检查"
  assert.ok(RD.includes('readme.test.mjs') || read('.github/workflows/check.yml').includes('readme.test.mjs'),
    'readme.test.mjs 自己没被任何地方跑起来');
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
