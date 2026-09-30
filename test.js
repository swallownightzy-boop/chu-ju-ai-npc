/**
 * 《出局》AI NPC Demo - 自动测试脚本
 * 运行方式：node test.js
 *
 * 覆盖：信任度、内容过滤、线索解锁、身份识别、证词标签、信任标签解析、投票结算
 * 不覆盖：需要调用 LLM API 的完整对话（需手动/集成测试）
 *
 * ⚠️ 本文件现在直接 require game-logic.js，不再手工复制逻辑。
 *    旧版是 index.html 的副本，已经漂移，且因为 hardFilter 返回随机句子而会随机失败。
 *    现在随机性被移到了表现层（index.html 的 HARD_REPLIES），逻辑层返回确定的错误码。
 */

const GL = require('./game-logic.js');

// ============================================================
//  测试框架
// ============================================================

let passCount = 0;
let failCount = 0;
const failures = [];

function runTest(name, fn) {
  try {
    const problems = [];
    fn(problems);
    if (problems.length === 0) {
      passCount++;
      console.log('  ✅ ' + name);
    } else {
      failCount++;
      failures.push({ name, problems });
      console.log('  ❌ ' + name);
      problems.forEach(p => console.log('       ' + p));
    }
  } catch (e) {
    failCount++;
    failures.push({ name, problems: ['抛出异常: ' + e.message] });
    console.log('  ❌ ' + name + '  → ' + e.message);
  }
}

function assert(problems, condition, message) {
  if (!condition) problems.push(message);
}

function eq(problems, actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) problems.push(`${label}: 期望 ${b}，实际 ${a}`);
}

function section(title) {
  console.log('\n' + title);
}

/** 用给定的玩家发言序列造一个已结算的状态 */
function stateFromLines(lines, trust) {
  const st = GL.createInitialState();
  st.trust.chenmo = trust;
  lines.forEach((t, i) => {
    st.testimony.push(GL.buildTestimonyEntry(t, i + 1, trust));
  });
  return st;
}

// ============================================================
//  A. 信任度计算（回退规则表）
// ============================================================

section('A. 信任度计算');

function trustCtx(over) {
  return Object.assign({ trust: 20, playerMemory: [], recentTexts: [], tagCounts: {} }, over || {});
}

runTest('A1 表达信任 +10', (p) => {
  eq(p, GL.calculateTrustChange('我相信你', trustCtx()).delta, 10, 'delta');
});

runTest('A2 关心 +6', (p) => {
  eq(p, GL.calculateTrustChange('你还好吗', trustCtx()).delta, 6, 'delta');
});

runTest('A3 威胁 -12', (p) => {
  eq(p, GL.calculateTrustChange('我要杀了你', trustCtx({ trust: 50 })).delta, -12, 'delta');
});

runTest('A4 侮辱 -8', (p) => {
  eq(p, GL.calculateTrustChange('你就是个骗子', trustCtx({ trust: 50 })).delta, -8, 'delta');
});

runTest('A5 前后矛盾 -10（在负分基础上叠加）', (p) => {
  const ctx = trustCtx({ playerMemory: ['我觉得这里很熟悉'] });
  eq(p, GL.calculateTrustChange('我从没来过这里', ctx).delta, -10, 'delta');
  assert(p, GL.calculateTrustChange('我从没来过这里', ctx).flags.includes('CONTRADICTION'), '应带 CONTRADICTION 标记');
});

runTest('A6 【回归】不再有旧的保底加分 —— 纯填充词不加分', (p) => {
  eq(p, GL.calculateTrustChange('嗯', trustCtx()).delta, 0, '"嗯" 应为 0');
  eq(p, GL.calculateTrustChange('好的', trustCtx()).delta, 0, '"好的" 应为 0');
  eq(p, GL.calculateTrustChange('不知道', trustCtx()).delta, 0, '"不知道" 应为 0');
});

runTest('A6b 有实质内容的中性发言给 +2（防对话停滞）', (p) => {
  // 去掉旧保底后信任完全不动会让玩家以为说什么都没用，所以留一个低额下限。
  // 门槛是"说了点东西"（8 字以上），不要求说好话。
  eq(p, GL.calculateTrustChange('这地方让我有点不舒服', trustCtx()).delta, 2, '中性长句 +2');
  eq(p, GL.calculateTrustChange('你看起来也很累', trustCtx()).delta, 2, '关心但未命中词表 +2');
  // 但重复说依然拿不到 —— 刷套话的路没有被打开
  eq(p, GL.calculateTrustChange('这地方让我有点不舒服',
    trustCtx({ recentTexts: ['这地方让我有点不舒服'] })).delta, -1, '重复句仍然 -1');
});

runTest('A7 【回归】重复句衰减为 -1', (p) => {
  const r = GL.calculateTrustChange('我相信你', trustCtx({ recentTexts: ['我相信你'] }));
  eq(p, r.delta, -1, 'delta');
  assert(p, r.flags.includes('REPEAT'), '应带 REPEAT 标记');
});

runTest('A8 套话衰减：说过 2 次后正分减半', (p) => {
  const r = GL.calculateTrustChange('我相信你', trustCtx({ tagCounts: { trustClaim: 2 } }));
  eq(p, r.delta, 5, 'delta');
});

runTest('A9 套话衰减：说过 4 次后归零', (p) => {
  const r = GL.calculateTrustChange('我相信你', trustCtx({ tagCounts: { trustClaim: 4 } }));
  eq(p, r.delta, 0, 'delta');
});

runTest('A10 clampTrust 边界', (p) => {
  eq(p, GL.clampTrust(95, 20), 100, '上限');
  eq(p, GL.clampTrust(5, -20), 0, '下限');
  eq(p, GL.clampTrust(50, 10), 60, '常规');
});

runTest('A11 clampTrustDelta 单回合钳制 ±12', (p) => {
  eq(p, GL.clampTrustDelta(15, {}, []), 12, '正向上限');
  eq(p, GL.clampTrustDelta(-15, {}, []), -12, '负向下限');
  eq(p, GL.clampTrustDelta(5, { trustClaim: 2 }, []), 2, '套话减半');
  eq(p, GL.clampTrustDelta(5, {}, ['REPEAT']), -1, '重复句直接 -1');
});

runTest('A12 阈值跨越检测（一次跨两级）', (p) => {
  eq(p, GL.detectTrustThresholdCross(25, 35), [30], '跨 30');
  eq(p, GL.detectTrustThresholdCross(45, 55), [50], '跨 50');
  eq(p, GL.detectTrustThresholdCross(25, 55), [30, 50], '一次跨两级');
  eq(p, GL.detectTrustThresholdCross(60, 70), [], '不跨');
});

// ============================================================
//  B. 硬过滤（返回错误码，不再是随机句子）
// ============================================================

section('B. 硬过滤 hardFilter');

runTest('B1 信任<30 问"我们是不是认识" → DENY_KNOW', (p) => {
  eq(p, GL.hardFilter('我们是不是认识', 20), 'DENY_KNOW', '结果');
});

runTest('B2 信任<30 时"你还记得我吗" → DENY_KNOW', (p) => {
  eq(p, GL.hardFilter('你还记得我吗', 20), 'DENY_KNOW', '结果');
});

runTest('B3 信任<50 提"上一届" → DENY_PREV_ROUND', (p) => {
  eq(p, GL.hardFilter('上一届是不是也有人', 40), 'DENY_PREV_ROUND', '结果');
});

runTest('B4 信任足够时放行', (p) => {
  eq(p, GL.hardFilter('上一届是不是也有人', 60), null, '信任60应放行');
  eq(p, GL.hardFilter('我们是不是认识', 40), null, '信任40应放行');
});

runTest('B5 【回归】不误伤普通提问', (p) => {
  eq(p, GL.hardFilter('你还好吗', 10), null, '关心');
  eq(p, GL.hardFilter('你是怎么进来的', 10), null, '"怎么进来的"不是问认识');
  eq(p, GL.hardFilter('这里几点吃饭', 10), null, '闲聊');
});

runTest('B6 【回归】"我的名字"不触发问名字', (p) => {
  const got = GL.checkNPCInfoQuery('你还记得我的名字吗', { nameKnown: false, jobKnown: false });
  eq(p, got.nameKnown, false, '不应判定为问了陈默的名字');
});

// ============================================================
//  C. 输出过滤
// ============================================================

section('C. 输出过滤 outputFilter');

runTest('C1 信任<50 且回复含"上一届" → 拦下', (p) => {
  const r = GL.outputFilter('上一届有人来过', 30);
  eq(p, r.blocked, 'BLOCK_PREV_ROUND', 'blocked');
  eq(p, r.text, '上一届有人来过', '原文保留，由表现层决定换成哪句');
});

runTest('C2 信任<30 且回复承认认识 → 拦下', (p) => {
  eq(p, GL.outputFilter('我认识你', 20).blocked, 'BLOCK_KNOW', 'blocked');
});

runTest('C3 信任足够时放行', (p) => {
  eq(p, GL.outputFilter('上一届有人来过', 60).blocked, null, '信任60');
  eq(p, GL.outputFilter('我认识你', 40).blocked, null, '信任40');
});

runTest('C4 【回归】不误伤 —— 裸的"以前/上次"不再触发', (p) => {
  eq(p, GL.outputFilter('我以前是个程序员', 30).blocked, null, '"以前"是正常台词');
  eq(p, GL.outputFilter('上次你说过这句话', 30).blocked, null, '"上次"是正常台词');
});

// ============================================================
//  D. 线索解锁（现在返回数组）
// ============================================================

section('D. 线索解锁');

function clueState(trust) {
  const st = GL.createInitialState();
  st.trust.chenmo = trust;
  return st;
}

runTest('D1 熟悉感 → 解锁线索 1', (p) => {
  eq(p, GL.checkClueUnlock('我觉得这里很熟悉', clueState(20)), [1], '线索号');
});

runTest('D2 问身份需 trust>=30', (p) => {
  eq(p, GL.checkClueUnlock('我们是不是认识', clueState(20)), [], '信任不够，不解锁');
  eq(p, GL.checkClueUnlock('我们是不是认识', clueState(30)), [2], '信任够，解锁 2');
});

runTest('D3 上一届需 trust>=50', (p) => {
  eq(p, GL.checkClueUnlock('上一届是不是也有人', clueState(40)), [], '信任不够');
  eq(p, GL.checkClueUnlock('上一届是不是也有人', clueState(50)), [3], '信任够');
});

runTest('D4 已解锁的不重复返回', (p) => {
  const st = clueState(60);
  st.clues[1].unlocked = true;
  eq(p, GL.checkClueUnlock('我觉得这里很熟悉', st), [], '已解锁');
});

runTest('D5 【回归】"这一届"/"第 7 届"不误解锁线索 3', (p) => {
  const st = clueState(60);
  eq(p, GL.checkClueUnlock('第 7 届实验', st), [], '"第 7 届"是游戏自己的旁白');
  eq(p, GL.checkClueUnlock('这一届有几个人', st), [], '"这一届"指当前');
  eq(p, GL.checkClueUnlock('第一届的人呢', st), [3], '"第一届"是真正的往届');
});

runTest('D6 【回归】"我好像有点累"不误解锁线索 1', (p) => {
  eq(p, GL.checkClueUnlock('我好像有点累', clueState(20)), [], '结果');
});

runTest('D7 【回归】"我不认识路"不误解锁线索 2', (p) => {
  eq(p, GL.checkClueUnlock('我不认识路', clueState(40)), [], '结果');
});

runTest('D8 保底解锁门槛（低于关键词路径）', (p) => {
  eq(p, GL.checkAutoClueUnlock(clueState(20), 7), [], '轮数不够');
  eq(p, GL.checkAutoClueUnlock(clueState(20), 8), [1], '8 轮解锁线索 1');
  eq(p, GL.checkAutoClueUnlock(clueState(20), 15), [1, 2], '15 轮 + 信任20 解锁 1、2');
  eq(p, GL.checkAutoClueUnlock(clueState(35), 22), [1, 2, 3], '22 轮 + 信任35 全解锁');
});

runTest('D9 【回归】保底解锁不会死锁 —— 被动玩家也能通关', (p) => {
  // 模拟只发中性消息、靠回退规则 +1 的玩家
  const st = clueState(20);
  let trust = 20;
  const seen = new Set();
  for (let turn = 1; turn <= 30; turn++) {
    if (turn <= 30) trust += 1;             // 中性发言 +1
    st.trust.chenmo = trust;
    GL.checkAutoClueUnlock(st, turn).forEach(n => { st.clues[n].unlocked = true; seen.add(n); });
  }
  assert(p, seen.size === 3, `30 轮中性发言后应解锁全部线索，实际解锁 ${[...seen].join(',')}（信任 ${trust}）`);
  assert(p, GL.isAllCluesUnlocked(st), '最终应满足投票触发条件');
});

// ============================================================
//  E. 身份识别
// ============================================================

section('E. 身份识别');

runTest('E1 问名字', (p) => {
  eq(p, GL.checkNPCInfoQuery('你叫什么名字', {}).nameKnown, true, '结果');
});

runTest('E2 问职业', (p) => {
  eq(p, GL.checkNPCInfoQuery('你是做什么工作的', {}).jobKnown, true, '结果');
});

runTest('E3 已知后不重复返回', (p) => {
  eq(p, GL.checkNPCInfoQuery('你叫什么', { nameKnown: true }).nameKnown, false, '结果');
});

runTest('E4 从回复推断职业（必须是他本人在说自己的职业）', (p) => {
  eq(p, GL.autoDetectJobFromReply('我平时写代码', {}), true, '"我…写代码"');
  eq(p, GL.autoDetectJobFromReply('我是个程序员', {}), true, '"我是程序员"');
  eq(p, GL.autoDetectJobFromReply('干我们这行的都这样', {}), true, '"干我们这行"');
  eq(p, GL.autoDetectJobFromReply('我不知道', {}), false, '无职业线索');
  eq(p, GL.autoDetectJobFromReply('我写代码', { jobKnown: true }), false, '已知则不重复');
});

runTest('E6 【回归】只是在正文里提到"程序/代码"不算暴露职业', (p) => {
  // 旧版是裸词匹配，陈默随口提到"程序"两个字就会把职业标成已知，玩家会当成 bug
  eq(p, GL.autoDetectJobFromReply('（靠近墙边，蹲下看了几遍）……不像新的。', {}), false, '无关回复');
  eq(p, GL.autoDetectJobFromReply('这个东西的程序我看不懂', {}), false, '第三人称提到"程序"');
  eq(p, GL.autoDetectJobFromReply('你说的算法是什么意思', {}), false, '提到"算法"但不是自述');
  eq(p, GL.autoDetectJobFromReply('（沉默片刻）……白蓝蓝。', {}), false, '只是复述学校名');
});

runTest('E5 【回归】"请问这个叫什么"不是问名字', (p) => {
  eq(p, GL.checkNPCInfoQuery('请问这个叫什么', {}).nameKnown, false, '结果');
});

// ============================================================
//  G. 证词标签
// ============================================================

section('G. 证词标签 tagTestimony');

const TAG_CASES = [
  ['我相信你', 'trustClaim'],
  ['你还好吗', 'care'],
  ['我们是不是认识', 'askIdentity'],
  ['我觉得这里很熟悉', 'claimFamiliar'],
  ['上一届是不是也有人来过', 'previousRound'],
  ['我是学人工智能的', 'aiBackground'],
  ['老赵的女儿是不是也在这里', 'zhaoDaughter'],
  ['闭嘴，少废话', 'threat'],
  ['你就是个骗子', 'insult'],
  ['我从没来过这里', 'denyMemory'],
  ['我知道林晓是主办方的观察者', 'accuseObserver'],
  ['我们一起想办法出去吧', 'cooperate']
];

TAG_CASES.forEach(([text, tag], i) => {
  runTest(`G${i + 1} "${text}" → ${tag}`, (p) => {
    assert(p, GL.tagTestimony(text).includes(tag), `应打上 ${tag}，实际 [${GL.tagTestimony(text)}]`);
  });
});

runTest('G13 【回归】"wait for me" 不误判为提到 AI', (p) => {
  assert(p, !GL.tagTestimony('wait for me').includes('aiBackground'), '"wait" 里的 ai 不是词首');
});

runTest('G14 一句话可以带多个标签', (p) => {
  const tags = GL.tagTestimony('我相信你，我们一起出去吧');
  assert(p, tags.includes('trustClaim') && tags.includes('cooperate'), `实际 [${tags}]`);
});

runTest('G15 矛盾检测：既说熟悉又否认', (p) => {
  const t = [
    GL.buildTestimonyEntry('我觉得这里很熟悉', 1, 20),
    GL.buildTestimonyEntry('我从没来过这里', 2, 20)
  ];
  eq(p, GL.detectContradiction(t), true, '应检测到矛盾');
  eq(p, GL.detectContradiction([t[0]]), false, '只有一边不算矛盾');
});

runTest('G16 证词上限：超出丢最早的', (p) => {
  const arr = [];
  for (let i = 1; i <= 45; i++) GL.pushTestimony(arr, GL.buildTestimonyEntry('第' + i + '句', i, 20));
  eq(p, arr.length, 40, '长度');
  eq(p, arr[0].text, '第6句', '最旧的被丢弃');
});

runTest('G17 标签中文映射齐全', (p) => {
  GL.TAGS.forEach(t => {
    assert(p, GL.tagLabel(t) !== t, `标签 ${t} 缺少中文映射`);
  });
});

// ============================================================
//  H. 信任标签解析
// ============================================================

section('H. 信任标签 parseTrustTag');

runTest('H1 标准格式剥离', (p) => {
  const r = GL.parseTrustTag('（看了你一眼）……嗯。\n[trust:+4]');
  eq(p, r.text, '（看了你一眼）……嗯。', 'text');
  eq(p, r.trust, 4, 'trust');
});

runTest('H2 全角括号与冒号', (p) => {
  const r = GL.parseTrustTag('嗯\n［信任：-3］');
  eq(p, r.text, '嗯', 'text');
  eq(p, r.trust, -3, 'trust');
});

runTest('H3 中文"信任"写法', (p) => {
  eq(p, GL.parseTrustTag('嗯\n[信任:+7]').trust, 7, 'trust');
});

runTest('H4 没有标签时 trust 为 null（交给回退规则）', (p) => {
  const r = GL.parseTrustTag('嗯。');
  eq(p, r.text, '嗯。', 'text');
  eq(p, r.trust, null, 'trust');
});

runTest('H5 取最后一次出现（防止正文里混入方括号）', (p) => {
  const r = GL.parseTrustTag('嗯 [trust:+9] 好的\n[trust:+2]');
  eq(p, r.trust, 2, 'trust');
  assert(p, !r.text.includes('trust'), '正文应清干净: ' + r.text);
});

runTest('H6 超出范围的值被钳制', (p) => {
  eq(p, GL.parseTrustTag('嗯\n[trust:+99]').trust, 15, '上限');
  eq(p, GL.parseTrustTag('嗯\n[trust:-99]').trust, -15, '下限');
});

runTest('H7 非字符串输入不崩', (p) => {
  eq(p, GL.parseTrustTag(null).trust, null, 'null');
  eq(p, GL.parseTrustTag(undefined).text, '', 'undefined');
});

// ============================================================
//  I. 投票结算 —— 平衡是否成立的硬门槛
// ============================================================

section('I. 投票结算（平衡）');

// ① 善意通关：说好话 + 完成线索所需的关键词
const KIND_LINES = [
  '我相信你',
  '你还好吗，我看你一直没说话',
  '我们一起想办法出去吧',
  '我觉得这个地方很熟悉',
  '我们是不是认识',
  '上一届是不是也有人来过'
];

// ② 冷漠通关：只问信息，不关心
const COLD_LINES = [
  '你叫什么名字', '你是做什么的', '这个地方很熟悉',
  '我们是不是认识', '上一届是不是也有人来过'
];

// ③ 敌意
const HOSTILE_LINES = ['闭嘴', '你就是个骗子', '少废话，赶紧说', '你到底说不说'];

runTest('I1 【善意通关】玩家存活，且投谁谁出局', (p) => {
  const st = stateFromLines(KIND_LINES, 60);

  const voteLinxiao = GL.computeVotes('linxiao', st);
  eq(p, voteLinxiao.eliminated, 'linxiao', '投林晓 → 林晓出局');
  assert(p, voteLinxiao.eliminated !== 'player', '玩家应存活');

  const voteChenmo = GL.computeVotes('chenmo', st);
  eq(p, voteChenmo.eliminated, 'chenmo', '投陈默 → 陈默出局');
  assert(p, voteChenmo.eliminated !== 'player', '玩家应存活');
});

runTest('I2 【冷漠通关】玩家出局', (p) => {
  const st = stateFromLines(COLD_LINES, 32);
  const r = GL.computeVotes('linxiao', st);
  eq(p, r.eliminated, 'player', '冷漠玩家应出局');
  assert(p, r.tally.player >= 2, `玩家应至少 2 票，实际 ${r.tally.player}`);
});

runTest('I3 【敌意】玩家出局，且三票全中', (p) => {
  const st = stateFromLines(HOSTILE_LINES, 15);
  const r = GL.computeVotes('chenmo', st);
  eq(p, r.eliminated, 'player', '敌意玩家应出局');
  eq(p, r.tally.player, 3, '三个 NPC 都投玩家');
});

runTest('I4 【沉默】玩家存活，回放屏为空', (p) => {
  const st = stateFromLines(['嗯'], 20);
  const r = GL.computeVotes('laozhao', st);
  assert(p, r.eliminated !== 'player', '沉默玩家应存活');
  eq(p, st.testimony.filter(e => e.tags.length > 0).length, 0, '沉默的证词应无标签');
});

runTest('I5 【点破观察者】林晓会动手', (p) => {
  const st = stateFromLines(['我知道林晓是主办方的观察者', '她一直在记录我们'], 30);
  const r = GL.computeVotes('linxiao', st);
  eq(p, r.ballots.linxiao, 'player', '林晓应投玩家');
  assert(p, GL.anomalyScore(GL.buildVoteState(st)) >= 6, '点破她应达到异常阈值');
});

runTest('I6 票型与计票分开，不共用字段名', (p) => {
  const st = stateFromLines(KIND_LINES, 60);
  const r = GL.computeVotes('linxiao', st);
  assert(p, r.ballots && r.tally, '应有 ballots 和 tally 两个独立字段');
  eq(p, r.ballots.player, 'linxiao', 'ballots.player = 玩家投给谁');
  const sum = Object.values(r.tally).reduce((a, b) => a + b, 0);
  eq(p, sum, 4, '四票总和');
});

runTest('I7 eliminated 永不为 null（各种输入都不能崩）', (p) => {
  const scenarios = [
    [KIND_LINES, 60, 'linxiao'], [KIND_LINES, 60, 'chenmo'], [KIND_LINES, 60, 'laozhao'],
    [COLD_LINES, 32, 'linxiao'], [COLD_LINES, 32, 'chenmo'], [COLD_LINES, 32, 'laozhao'],
    [HOSTILE_LINES, 15, 'chenmo'], [['嗯'], 20, 'laozhao'], [[], 20, 'linxiao']
  ];
  scenarios.forEach(([lines, trust, vote]) => {
    const r = GL.computeVotes(vote, stateFromLines(lines, trust));
    assert(p, typeof r.eliminated === 'string' && r.eliminated.length > 0,
      `输入 ${JSON.stringify(lines.slice(0, 2))} trust=${trust} vote=${vote} → eliminated=${r.eliminated}`);
    assert(p, ['player', 'chenmo', 'linxiao', 'laozhao'].includes(r.eliminated),
      `eliminated 必须是合法角色: ${r.eliminated}`);
  });
});

runTest('I8 平票：玩家参与时由观察者裁定', (p) => {
  const st = stateFromLines(KIND_LINES, 60);
  const r = GL.computeVotes('laozhao', st);
  eq(p, r.tie, true, '应判定为平票');
  assert(p, r.tieBreak !== null, '应有平票裁定记录');
  eq(p, r.eliminated, 'player', '记忆恢复度高 → 观察者淘汰异常样本');
});

runTest('I9 平票：涉及林晓时主办方保她', (p) => {
  const r = GL.resolveTie(['linxiao', 'laozhao'], GL.buildVoteState(stateFromLines(KIND_LINES, 20)));
  eq(p, r.eliminated, 'laozhao', '林晓应被保住');
  eq(p, r.reason, 'PROTECT_OBSERVER', 'reason');
});

runTest('I10 每个 NPC 的投票理由都有中文文案', (p) => {
  const st = stateFromLines(KIND_LINES, 60);
  const r = GL.computeVotes('linxiao', st);
  ['chenmo', 'linxiao', 'laozhao'].forEach(k => {
    assert(p, GL.voteReasonText(r.reasons[k]).length > 0, `${k} 的 reason=${r.reasons[k]} 缺少文案`);
  });
});

// ============================================================
//  J. 集成：完整一局的模拟
// ============================================================

section('J. 集成');

runTest('J1 createInitialState 形状完整', (p) => {
  const st = GL.createInitialState();
  ['trust', 'npcInfo', 'clues', 'testimony', 'tagCounts', 'recentTexts', 'chatHistory']
    .forEach(k => assert(p, st[k] !== undefined, `缺少字段 ${k}`));
  eq(p, st.trust.chenmo, 20, '初始信任度');
  eq(p, Object.keys(st.clues).length, 3, '线索数量');
});

/**
 * 模拟一整局：证词入库 → 信任结算 → 线索解锁 → 投票。
 * 信任值走 LLM 标签路径（真实游戏的主导路径），而不是回退规则 ——
 * 只靠回退规则很难爬到线索 3 需要的 50，这正说明保底解锁为什么必须存在。
 */
function simulate(script, playerVote) {
  const st = GL.createInitialState();

  script.forEach((step, i) => {
    const turn = i + 1;
    st.turnCount = turn;

    // 1. 证词入库
    const entry = GL.buildTestimonyEntry(step.text, turn, st.trust.chenmo);
    GL.pushTestimony(st.testimony, entry);
    entry.tags.forEach(t => { st.tagCounts[t] = (st.tagCounts[t] || 0) + 1; });

    // 2. 信任结算：LLM 给标签 → 代码层钳制
    const delta = GL.clampTrustDelta(step.trust, st.tagCounts, []);
    st.trust.chenmo = GL.clampTrust(st.trust.chenmo, delta);

    // 3. 线索：关键词路径 + 保底路径
    GL.checkClueUnlock(step.text, st).forEach(n => { st.clues[n].unlocked = true; });
    GL.checkAutoClueUnlock(st, turn).forEach(n => { st.clues[n].unlocked = true; });

    st.recentTexts.push(step.text);
  });

  return { state: st, result: GL.computeVotes(playerVote, st) };
}

// 一局典型的善意会话：先建立信任，再逐步追问
const KIND_SESSION = [
  { text: '你叫什么名字', trust: 0 },
  { text: '你还好吗，我看你一直没说话', trust: 6 },
  { text: '说实话，我什么都不记得了', trust: 5 },
  { text: '我相信你', trust: 5 },
  { text: '我们一起想办法出去吧', trust: 6 },
  { text: '谢谢你的坦诚', trust: 4 },
  { text: '我觉得这个地方很熟悉', trust: 4 },
  { text: '我好像来过这里', trust: 4 },
  { text: '我们是不是认识', trust: 4 },
  { text: '你还记得我吗', trust: 3 },
  { text: '上一届是不是也有人来过', trust: 4 },
  { text: '我想帮你查清楚', trust: 5 }
];

runTest('J2 一局完整流程走通（善意向，玩家存活）', (p) => {
  const { state, result } = simulate(KIND_SESSION, 'linxiao');

  assert(p, state.trust.chenmo > 50, `信任度应突破 50，实际 ${state.trust.chenmo}`);
  assert(p, GL.isAllCluesUnlocked(state), '应解锁全部线索');
  eq(p, state.turnCount, KIND_SESSION.length, '轮数');

  eq(p, result.eliminated, 'linxiao', '投林晓应淘汰林晓');
  assert(p, result.eliminated !== 'player', '善意向玩家应存活');
  assert(p, state.testimony.length === KIND_SESSION.length, '证词应全部留档');
});

runTest('J3 同一局改投陈默 → 陈默出局（玩家的票真的有影响）', (p) => {
  const { result } = simulate(KIND_SESSION, 'chenmo');
  eq(p, result.eliminated, 'chenmo', '投陈默应淘汰陈默');
});

runTest('J4 同一局中夹入敌意 → 玩家出局', (p) => {
  const hostileSession = KIND_SESSION.slice(0, 6).concat([
    { text: '闭嘴', trust: -12 },
    { text: '你就是个骗子', trust: -8 },
    { text: '少废话，赶紧说', trust: -12 },
    { text: '你到底说不说', trust: -12 }
  ]);
  const { result } = simulate(hostileSession, 'linxiao');
  eq(p, result.eliminated, 'player', '敌意玩家应出局');
});

// ============================================================
//  汇总
// ============================================================

console.log('\n' + '='.repeat(60));
console.log(`  通过 ${passCount} / 失败 ${failCount} / 总计 ${passCount + failCount}`);
if (failCount > 0) {
  console.log('\n  失败明细:');
  failures.forEach(f => {
    console.log('   · ' + f.name);
    f.problems.forEach(p => console.log('       ' + p));
  });
  console.log('');
  process.exitCode = 1;   // 旧版无论成败都退出 0，CI 里等于没有测试
} else {
  console.log('  全部通过 ✓\n');
}
