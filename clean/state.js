/**
 * state.js —— 面板的共享可变状态
 *
 * 为什么是一个对象、而不是一堆模块级 `let`：
 * ES 模块之间的 `let` 绑定是**只读**的 —— 甲模块可以读乙模块导出的 `let`，
 * 但赋值会报错。面板里十几个函数要互相读写这些状态（谁在跑、队列里有什么、
 * 筛选项是什么），所以必须装进一个对象的属性里，大家改属性就行。
 *
 * 顺带的好处：状态在一个地方就能看全，不用满文件找 `let`。
 *
 * 命名约定：凡是「会变的、跨函数共享的」，都放这儿；
 * 纯常量（超时、页大小之类）各回各的模块，不进这里。
 */

export const state = {
  /* ---------------------------------------------------------- 流程标志
   * 三个"正在跑"互斥用：跑着的流程自己按节奏刷界面，
   * 存储监听要避开它们（见 main.js 的 scheduleLibraryRefresh）。 */
  running: false,             // 删除流程
  stopRequested: false,       // 删除的停止请求
  autoRunning: false,         // aicu 自动翻页
  probing: false,             // 存活巡检
  probeStop: false,           // 巡检的停止请求

  /* ------------------------------------------------------ 借用来的标签页
   * 删除请求必须从 bilibili 页面发出去（否则没有登录态），
   * 没有现成标签页时会临时开一个后台标签页，用完就关。 */
  workerTabId: null,
  workerCreated: false,

  /* -------------------------------------------------------------- 设置 */
  settings: null,

  /* ------------------------------------------------ 删除队列（待执行） */
  items: [],
  stats: { ok: 0, fail: 0, gone: 0 },

  /* ---------------------------------------------------------- 库视图 */
  libQ: '',                   // 搜索词
  libStates: [],              // 状态筛选；空数组 = 全部
  libSource: 'all',           // 来源筛选：all | record | aicu
  libSort: 'time-desc',
  libPage: 0,
  libSelected: new Set(),     // 勾选中的 rpid

  /* ------------------------------------------------------------ 定时器 */
  libTimer: null,             // 搜索输入防抖
  libWatchTimer: null,        // 存储变化后的重画防抖
  aicuRenderTimer: null,      // 导入区重绘节流
  purgeTimer: null,           // 「清空已删除记录」的二次确认倒计时
  dataClearTimer: null,       // 「删除整个评论库」的二次确认倒计时

  /* -------------------------------------------------------------- 杂项 */
  sourceFilter: 'all',        // 删除队列按来源筛：all | bookmark | aicu
  logAutoOpened: false,       // 出错后日志是否已经自动展开过
  askingUid: '',              // 正在问"这是你小号吗"的那个 UID
  probeDirectWorks: null,     // 直连探测行不行（探过一次之后缓存结论）

  /* ------------------------------------- requestId -> resolve 的等待表
   * 删除/取数据是注入到网页里执行的，结果靠 window.postMessage 回传，
   * 这里按 requestId 挂住对应的 promise。 */
  pending: new Map(),

  /* ------------------------------------------------------ bvid -> aid */
  aidCache: new Map()
};
