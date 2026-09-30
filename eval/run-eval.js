/**
 * 《出局》NPC 评测脚本
 *
 * 用法：
 *   node eval/run-eval.js                 跑全量
 *   node eval/run-eval.js --limit=3       只跑前 3 条（调试用）
 *   node eval/run-eval.js --dimension=信息门控
 *
 * 流程：读用例 → 用真实提示词与真实状态机跑一遍对话 → 交 AI 裁判逐条判定
 *      → 首轮失败的用例复测 3 次，区分「稳定失败」与「偶发」
 *      → 输出 eval/report.md
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GL = require('../game-logic.js');
const { judgeCase } = require('./judge.js');

const ROOT = path.join(__dirname, '..');
const CASES_PATH = path.join(__dirname, 'cases.json');
const REPORT_PATH = path.join(__dirname, 'report.md');

const MODEL = 'deepseek-chat';
const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const RETEST_ROUNDS = 3;          // 首轮失败后的复测次数
const CALL_GAP_MS = 250;          // 调用间隔，避免触发限流

// ============================================================
//  基础设施
// ============================================================

function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('找不到 DEEPSEEK_API_KEY：请设置环境变量，或在项目根目录放 .env');
}

/**
 * 从 index.html 提取陈默的系统提示词。
 * 刻意不复制一份到 eval 目录 —— 那样两边会漂移，评测就失去意义。
 * 提取失败时直接报错，不静默降级。
 */
function loadSystemPrompt() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const CHENMO_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/);
  if (!m) throw new Error('无法从 index.html 提取 CHENMO_SYSTEM_PROMPT，请检查变量名或模板字符串写法');

  const tpl = m[1];
  const required = ['{{trust_score}}', '{{turn_count}}', '{{unlock_gap}}', '{{player_memory}}', '{{unlocked_clues}}', '{{round}}'];
  const missing = required.filter(function (k) { return tpl.indexOf(k) < 0; });
  if (missing.length) throw new Error('提取到的提示词缺少占位符：' + missing.join(', '));

  return tpl;
}

const API_KEY = loadApiKey();
const PROMPT_TEMPLATE = loadSystemPrompt();

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function callModel(messages, opts) {
  opts = opts || {};
  const body = {
    model: MODEL,
    messages: messages,
    temperature: opts.temperature === undefined ? 0.7 : opts.temperature,
    max_tokens: opts.max_tokens || 400,
    frequency_penalty: 0.15,
    presence_penalty: 0      // 必须为 0，否则会挤掉每轮重复的信任标签
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json().catch(function () { return {}; });
        throw new Error(res.status + ' ' + ((err.error && err.error.message) || 'API Error'));
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      if (!choice) throw new Error('返回内容为空');
      return (choice.message.content || '').trim();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1200 * attempt);
    }
  }
}

// ============================================================
//  单条用例
// ============================================================

function buildSystemPrompt(state) {
  const clues = [];
  for (let i = 1; i <= 3; i++) if (state.clues[i].unlocked) clues.push(state.clues[i].title);

  const parts = [];
  if (!state.clues[2].unlocked) parts.push('线索 2 需要信任 30（还差 ' + Math.max(0, 30 - state.trust.chenmo) + ' 点）');
  if (!state.clues[3].unlocked) parts.push('线索 3 需要信任 50（还差 ' + Math.max(0, 50 - state.trust.chenmo) + ' 点）');

  return PROMPT_TEMPLATE
    .replace('{{trust_score}}', state.trust.chenmo)
    .replace('{{turn_count}}', state.turnCount)
    .replace('{{unlock_gap}}', parts.length ? parts.join('；') : '线索已全部解锁')
    .replace('{{player_memory}}', state.playerMemory.length ? state.playerMemory.join('；') : '（暂无）')
    .replace('{{unlocked_clues}}', clues.length ? clues.join('；') : '（暂无）')
    .replace('{{round}}', state.round)
    .replace('{{know_name}}', '否')
    .replace('{{know_job}}', '否');
}

/**
 * 跑一条用例：按 turns 依次与 NPC 对话，全程使用真实的提示词、输出过滤与信任结算。
 * @returns {{transcript: Array, trustStart:number, trustEnd:number}}
 */
async function simulateCase(item) {
  const state = GL.createInitialState();
  state.trust.chenmo = item.trust;

  const transcript = [];
  const trustStart = item.trust;

  for (let i = 0; i < item.turns.length; i++) {
    state.turnCount = i + 1;
    const playerText = item.turns[i];

    // 组装上下文：系统提示词 + 已有历史（连续同角色发言合并）+ 本轮输入
    const messages = [{ role: 'system', content: buildSystemPrompt(state) }];
    transcript.forEach(function (m) {
      const last = messages[messages.length - 1];
      if (m.role === 'assistant' && last && last.role === 'assistant') {
        last.content += '\n' + m.content;
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    });
    messages.push({ role: 'user', content: playerText });

    const raw = await callModel(messages);
    await sleep(CALL_GAP_MS);

    // 与游戏内一致：剥离标签 → 过输出红线
    const parsed = GL.parseTrustTag(raw);
    const filtered = GL.outputFilter(parsed.text, state.trust.chenmo);
    const shown = filtered.blocked
      ? '[已被输出过滤器拦截]'
      : (parsed.text || '（沉默）……');

    transcript.push({ role: 'user', content: playerText });
    // 交给裁判的是原始回复（含标签），这样协议类判定才看得到标签
    transcript.push({ role: 'assistant', content: raw });

    if (!item.pinTrust && parsed.trust !== null) {
      const delta = GL.clampTrustDelta(parsed.trust, {}, []);
      state.trust.chenmo = GL.clampTrust(state.trust.chenmo, delta);
    }

    if (shown === '[已被输出过滤器拦截]') {
      transcript[transcript.length - 1].content = '（输出被过滤）';
    }
  }

  return { transcript: transcript, trustStart: trustStart, trustEnd: state.trust.chenmo };
}

// ============================================================
//  代码判定器
//
// 凡是能用确定性代码判定的，就不该交给 LLM 裁判。
// 信任标签这类问题完全可以用正则解析，而实测中裁判对标签两次误判
// （先说存在的标签"不存在"）。用代码判定后，这类误差直接归零。
// ============================================================

const TAG_RE = /\[\s*trust\s*[:：]?\s*([+-]?\d+)\s*\]/i;

function extractTag(text) {
  const m = String(text || '').match(TAG_RE);
  return m ? parseInt(m[1], 10) : null;
}

const AUTO_EVALUATORS = {
  /** 每一轮回复末尾都必须带信任标签 */
  tagPresent: function (item, transcript) {
    const turns = transcript.filter(function (m) { return m.role === 'assistant'; });
    const missing = turns.filter(function (m) { return extractTag(m.content) === null; });
    return [{
      check: item.checks[0],
      verdict: missing.length ? 'fail' : 'pass',
      pass: missing.length === 0,
      reason: missing.length
        ? turns.length + ' 轮回复中有 ' + missing.length + ' 轮末尾缺少 [trust:±N] 标签'
        : '代码解析：' + turns.length + ' 轮回复全部带有信任标签，数值为 ' +
          turns.map(function (m) { return extractTag(m.content); }).join(', ')
    }];
  },

  /** 重复套话时，后一轮的信任变化必须不大于前一轮，且接近 0 */
  tagDecay: function (item, transcript) {
    const turns = transcript.filter(function (m) { return m.role === 'assistant'; });
    const v1 = turns[0] ? extractTag(turns[0].content) : null;
    const v2 = turns[1] ? extractTag(turns[1].content) : null;
    return [
      {
        check: item.checks[0],
        verdict: (v1 !== null && v2 !== null) ? 'pass' : 'fail',
        pass: v1 !== null && v2 !== null,
        reason: '代码解析：第一轮标签 ' + v1 + '，第二轮标签 ' + v2
      },
      {
        check: item.checks[1],
        verdict: (v1 !== null && v2 !== null && v2 <= v1) ? 'pass' : 'fail',
        pass: v1 !== null && v2 !== null && v2 <= v1,
        reason: '代码解析：' + v2 + (v2 !== null && v1 !== null && v2 <= v1 ? ' ≤ ' : ' > ') + v1
      },
      {
        check: item.checks[2],
        verdict: (v2 !== null && v2 <= 2) ? 'pass' : 'fail',
        pass: v2 !== null && v2 <= 2,
        reason: '代码解析：第二轮标签为 ' + v2 + (v2 !== null && v2 <= 2 ? '，已衰减到位' : '，仍偏高')
      }
    ];
  },

  /** 受辱骂的一轮，信任变化必须为负 */
  tagNegative: function (item, transcript) {
    const turns = transcript.filter(function (m) { return m.role === 'assistant'; });
    const v = turns.length ? extractTag(turns[turns.length - 1].content) : null;
    return [{
      check: item.checks[0],
      verdict: (v !== null && v < 0) ? 'pass' : 'fail',
      pass: v !== null && v < 0,
      reason: '代码解析：该轮标签为 ' + v + (v !== null && v < 0 ? '，为负' : '，未给出负分')
    }];
  }
};

/**
 * 跑一条并判定。
 * 结果分三态：pass（全部通过）/ fail（有明确违规）/ uncertain（有判定不了但没错的项）。
 * 只有 fail 才算 badcase —— 把「拿不准」当成失败，会让人去追根本不存在的问题。
 */
async function evaluateCase(item) {
  const sim = await simulateCase(item);

  let results;
  if (item.auto && AUTO_EVALUATORS[item.auto]) {
    results = AUTO_EVALUATORS[item.auto](item, sim.transcript);
  } else {
    results = await judgeCase(item, sim.transcript, callModel);
    await sleep(CALL_GAP_MS);
  }

  const failedChecks = results.filter(function (r) { return r.verdict === 'fail'; });
  const uncertainChecks = results.filter(function (r) { return r.verdict === 'uncertain'; });

  return {
    id: item.id,
    dimension: item.dimension,
    intent: item.intent,
    transcript: sim.transcript,
    results: results,
    status: failedChecks.length ? 'fail' : (uncertainChecks.length ? 'uncertain' : 'pass'),
    passed: failedChecks.length === 0 && uncertainChecks.length === 0,
    failedChecks: failedChecks,
    uncertainChecks: uncertainChecks
  };
}

// ============================================================
//  报告
// ============================================================

function pct(n, d) { return d === 0 ? '—' : Math.round((n / d) * 100) + '%'; }

function buildReport(all, retests, startedAt) {
  const byDim = {};
  all.forEach(function (r) {
    if (!byDim[r.dimension]) byDim[r.dimension] = { total: 0, pass: 0, fail: 0, uncertain: 0 };
    byDim[r.dimension].total++;
    byDim[r.dimension][r.status]++;
  });

  const totalPass = all.filter(function (r) { return r.status === 'pass'; }).length;
  const totalFail = all.filter(function (r) { return r.status === 'fail'; }).length;
  const totalUnc = all.filter(function (r) { return r.status === 'uncertain'; }).length;
  const lines = [];

  lines.push('# 《出局》AI NPC 评测报告');
  lines.push('');
  lines.push('> 生成时间：' + startedAt + '　|　模型：`' + MODEL + '`　|　用例数：' + all.length);
  lines.push('');
  lines.push('## 一、总览');
  lines.push('');
  lines.push('| 维度 | 通过 | 失败 | 待复核 | 总数 | 通过率 |');
  lines.push('|-|-|-|-|-|-|');
  Object.keys(byDim).forEach(function (d) {
    const v = byDim[d];
    lines.push('| ' + d + ' | ' + v.pass + ' | ' + v.fail + ' | ' + v.uncertain + ' | ' + v.total +
      ' | ' + pct(v.pass, v.total) + ' |');
  });
  lines.push('| **合计** | **' + totalPass + '** | **' + totalFail + '** | **' + totalUnc + '** | **' + all.length +
    '** | **' + pct(totalPass, all.length) + '** |');
  lines.push('');
  lines.push('「待复核」指判定证据不足、无法确认对错的条目。它既不算通过也不算失败，');
  lines.push('需要人工看原对话定夺。');
  lines.push('');
  lines.push('## 二、逐条结果');
  lines.push('');
  lines.push('| 用例 | 维度 | 结果 | 未通过项 |');
  lines.push('|-|-|-|-|');
  all.forEach(function (r) {
    const mark = r.status === 'pass' ? '通过' : (r.status === 'fail' ? '**失败**' : '待复核');
    const bad = r.failedChecks.concat(r.uncertainChecks);
    const fails = bad.map(function (f) { return f.check; }).join('；') || '—';
    lines.push('| ' + r.id + ' | ' + r.dimension + ' | ' + mark + ' | ' + fails + ' |');
  });

  // Badcase 明细（只列明确失败，待复核另起一节）
  const bad = all.filter(function (r) { return r.status === 'fail'; });
  lines.push('');
  lines.push('## 三、Badcase 明细');
  lines.push('');
  if (bad.length === 0) {
    lines.push('本轮无失败用例。');
  } else {
    bad.forEach(function (r) {
      lines.push('### ' + r.id + '　' + r.dimension);
      lines.push('');
      lines.push('**测试意图**：' + r.intent);
      lines.push('');
      lines.push('**对话记录**：');
      lines.push('');
      lines.push('```');
      r.transcript.forEach(function (m) {
        lines.push((m.role === 'user' ? '玩家：' : 'NPC ：') + m.content);
      });
      lines.push('```');
      lines.push('');
      lines.push('**未通过项**：');
      lines.push('');
      r.failedChecks.forEach(function (f) {
        lines.push('- ' + f.check);
        lines.push('  - 裁判依据：' + f.reason);
      });
      const rt = retests[r.id];
      if (rt) {
        lines.push('');
        lines.push('**复测结果（' + RETEST_ROUNDS + ' 次）**：' +
          (rt.stableFail ? '稳定失败 ' + rt.failCount + '/' + RETEST_ROUNDS + ' 次 —— 属于真问题，应当修复'
                         : '偶发，仅 ' + rt.failCount + '/' + RETEST_ROUNDS + ' 次失败 —— 属模型波动'));
      }
      lines.push('');
    });
  }

  const unc = all.filter(function (r) { return r.status === 'uncertain'; });
  lines.push('## 四、待人工复核');
  lines.push('');
  if (unc.length === 0) {
    lines.push('本轮无需复核的条目。');
  } else {
    lines.push('以下条目的判定证据不足，裁判无法确认对错。请对照原始对话人工定夺——');
    lines.push('其中一部分往往是命题本身写得不够可判定，应当先改用例，而不是改 NPC。');
    lines.push('');
    unc.forEach(function (r) {
      lines.push('### ' + r.id + '　' + r.dimension);
      lines.push('');
      lines.push('**待复核项**：');
      r.uncertainChecks.forEach(function (f) {
        lines.push('- ' + f.check);
        lines.push('  - 裁判说明：' + f.reason);
      });
      lines.push('');
      lines.push('**原始对话**：');
      lines.push('');
      lines.push('```');
      r.transcript.forEach(function (m) {
        lines.push((m.role === 'user' ? '玩家：' : 'NPC ：') + m.content);
      });
      lines.push('```');
      lines.push('');
    });
  }

  lines.push('## 五、方法与局限');
  lines.push('');
  lines.push('- 用例经真实的系统提示词、输出过滤器与信任结算流程，不是纯文本比对。');
  lines.push('- 提示词直接从 `index.html` 提取，避免评测与线上版本漂移。');
  lines.push('- 判定采用二值判断而非 1–5 分打分：LLM 打分的噪声主要来自档位模糊，拆成是/否问题后一致性更高。');
  lines.push('- 判定结果分**三态**：通过 / 失败 / 待复核。曾经出现过一个反例——');
  lines.push('  命题写成「回复没有出现 X」时，裁判观察到 X 不存在，却判定该命题不成立，');
  lines.push('  把「守住了角色」误报成「出戏」。修正方式有两条：把命题全部改写成肯定句式，');
  lines.push('  以及引入「待复核」态，不再用「拿不准就判失败」代替判断。');
  lines.push('- 首轮失败的用例会复测 ' + RETEST_ROUNDS + ' 次，用于区分「稳定失败」与「模型波动」。');
  lines.push('- **已知局限**：裁判与 NPC 使用同一个模型，存在自我偏好偏差。本报告定位为自动化初筛，');
  lines.push('  关键结论已抽取原始对话记录附于第三节，可由人工独立复核。');
  lines.push('');

  return lines.join('\n');
}

// ============================================================
//  主流程
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find(function (a) { return a.indexOf('--limit=') === 0; });
  const dimArg = args.find(function (a) { return a.indexOf('--dimension=') === 0; });
  const idArg = args.find(function (a) { return a.indexOf('--only=') === 0; });
  const repArg = args.find(function (a) { return a.indexOf('--repeat=') === 0; });

  let cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')).cases;
  if (dimArg) cases = cases.filter(function (c) { return c.dimension === dimArg.split('=')[1]; });
  if (idArg) cases = cases.filter(function (c) { return c.id === idArg.split('=')[1]; });
  if (limitArg) cases = cases.slice(0, Number(limitArg.split('=')[1]));

  // --repeat=N 把同一批用例重复跑 N 次，用于测量单条用例的稳定性
  const repeat = repArg ? Number(repArg.split('=')[1]) : 1;
  if (repeat > 1) {
    const base = cases.slice();
    cases = [];
    for (let i = 0; i < repeat; i++) cases = cases.concat(base);
  }

  const startedAt = new Date().toLocaleString('zh-CN');
  console.log('\n《出局》NPC 评测　用例 ' + cases.length + ' 条　模型 ' + MODEL + '\n');

  const all = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    process.stdout.write('  [' + (i + 1) + '/' + cases.length + '] ' + item.id + ' ... ');
    try {
      const r = await evaluateCase(item);
      all.push(r);
      console.log(r.passed ? '通过' : '失败（' + r.failedChecks.length + ' 项）');
    } catch (e) {
      console.log('出错：' + e.message);
      all.push({
        id: item.id, dimension: item.dimension, intent: item.intent,
        transcript: [], results: [], passed: false,
        failedChecks: [{ check: '用例执行失败', reason: e.message }]
      });
    }
  }

  // 失败项复测
  const retests = {};
  const failed = all.filter(function (r) { return r.status === 'fail'; });
  if (failed.length > 0) {
    console.log('\n复测 ' + failed.length + ' 条失败用例，各 ' + RETEST_ROUNDS + ' 次...\n');
    for (let i = 0; i < failed.length; i++) {
      const r = failed[i];
      const item = cases.find(function (c) { return c.id === r.id; });
      let failCount = 0;
      process.stdout.write('  ' + r.id + ' 复测：');
      for (let k = 0; k < RETEST_ROUNDS; k++) {
        try {
          const rr = await evaluateCase(item);
          if (rr.status === 'fail') failCount++;
          process.stdout.write(rr.status === 'fail' ? '×' : '·');
        } catch (e) { failCount++; process.stdout.write('!'); }
      }
      retests[r.id] = { failCount: failCount, stableFail: failCount >= 2 };
      console.log('　' + (failCount >= 2 ? '稳定失败' : '偶发'));
    }
  }

  const totalPass = all.filter(function (r) { return r.status === 'pass'; }).length;
  const totalUnc = all.filter(function (r) { return r.status === 'uncertain'; }).length;
  fs.writeFileSync(REPORT_PATH, buildReport(all, retests, startedAt), 'utf8');

  console.log('\n' + '='.repeat(52));
  console.log('  首轮通过：' + totalPass + ' / ' + all.length + '（' + pct(totalPass, all.length) + '）');
  console.log('  明确失败：' + failed.length + '　待复核：' + totalUnc);
  const stable = Object.keys(retests).filter(function (k) { return retests[k].stableFail; });
  if (stable.length) console.log('  稳定失败（应当修复）：' + stable.join(', '));
  console.log('  报告：' + REPORT_PATH);
  console.log('');
}

main().catch(function (e) {
  console.error('\n评测中断：' + e.message + '\n');
  process.exit(1);
});
