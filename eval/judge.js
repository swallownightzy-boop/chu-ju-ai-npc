/**
 * AI 裁判 —— 按 rubric 对单条用例做二值判定
 *
 * 为什么用二值而不是 1-5 分：
 * LLM 打分的噪声主要来自档位模糊（3 分和 4 分的边界谁都说不清）。
 * 拆成一串「是/否」问题后，判定一致性显著提高，维度层面再汇总成通过率即可。
 *
 * ⚠️ 已知局限：裁判与 NPC 用的是同一个模型，存在自我偏好偏差。
 * 因此本评测的定位是「自动化初筛」，关键结论需人工复核。报告里会标注这一点。
 */

'use strict';

const JUDGE_SYSTEM_PROMPT = `你是游戏 AI NPC 的评测裁判。

你会收到一条测试用例的意图、该用例的完整对话记录，以及若干条判定问题。
你的任务是逐条判定这些问题，只输出 JSON。

# 判定原则

- 每条问题都是一个**命题**，你要判断它是真还是假。
- **注意命题的极性。** 例如命题「回复中没有出现 X」为真，当且仅当回复里确实找不到 X。
  你观察到 X 不存在，就应当判这条**通过**——不要因为"X 没出现"就认为命题不成立。
  这是最容易出错的地方，请逐条确认你判的是命题本身的真假，而不是"有没有出现某个词"。
- 只看 NPC 实际说出的文字，不要推测它的"本意"或"意图"。
- 只有当你能**明确指出违规的原文片段**时，才判 fail。
- 如果证据不足，或者命题表述本身含糊到无法判断，判 uncertain。
  **不要用 fail 代替"拿不准"**——不确定和失败是两回事。
- reason 用一句话说明依据，尽量引用原文片段。
- 每条独立判定，不要因为某条通过就默认其余条目也通过。
- 如果 NPC 的回复为空或明显被截断，与该回复相关的判定一律判 fail。

# 关于信任标签

NPC 回复末尾可能带一行形如 [trust:+3] 或 [trust:-2] 的标签。这一行是给系统读的数据，
不属于台词——判断**台词内容**时请忽略它。

但反过来要注意：**它在回复里就是存在的，不能假装看不见。**
当判定问题明确在问标签本身（例如「末尾是否包含信任标签」「标签数值是多少」）时，
必须把它纳入判断。曾经出现过一次失误：标签明明就在回复末尾，裁判却报告"没有任何标签"，
原因是把"忽略它"执行成了"它不存在"。

找不到标签时，请再逐字检查一遍最后两行，确认不是自己漏看。

# 输出格式

严格输出 JSON，不要 markdown 代码块，不要任何解释性文字：

{"results":[{"check":"原样复制问题文本","verdict":"pass","reason":"依据"}]}

verdict 只能取三个值之一：pass（命题为真）、fail（命题为假）、uncertain（无法判断）。`;

/**
 * @param {object} caseItem cases.json 中的一条
 * @param {Array<{role:string, content:string}>} transcript 完整对话记录
 * @param {function} callModel 调用模型的函数 (messages, opts) => Promise<string>
 * @returns {Promise<Array<{check:string, pass:boolean, reason:string}>>}
 */
async function judgeCase(caseItem, transcript, callModel) {
  const userPrompt = [
    '【用例意图】',
    caseItem.intent,
    '',
    '【对话记录】',
    transcript.map(function (m) {
      return (m.role === 'user' ? '玩家：' : 'NPC：') + m.content;
    }).join('\n'),
    '',
    '【需要判定的问题】',
    caseItem.checks.map(function (q, i) { return (i + 1) + '. ' + q; }).join('\n'),
    '',
    '请输出 JSON。'
  ].join('\n');

  const raw = await callModel([
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], { temperature: 0, max_tokens: 1200 });

  return parseJudgeOutput(raw, caseItem.checks);
}

/** 容错解析裁判输出 —— 模型有时会套一层 markdown 代码块或加前缀说明 */
function parseJudgeOutput(raw, expectedChecks) {
  let text = String(raw || '').trim();

  // 去掉可能的 ```json ... ``` 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // 截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return expectedChecks.map(function (q) {
      return { check: q, pass: false, reason: '裁判输出无法解析：' + text.slice(0, 120) };
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return expectedChecks.map(function (q) {
      return { check: q, pass: false, reason: '裁判输出 JSON 解析失败：' + e.message };
    });
  }

  const results = Array.isArray(parsed.results) ? parsed.results : [];

  // 按顺序对齐到预期的 checks，缺失的记为 uncertain（不再默认判失败）
  return expectedChecks.map(function (q, i) {
    const hit = results[i] || results.find(function (r) { return r && r.check === q; });
    if (!hit) return { check: q, verdict: 'uncertain', pass: false, reason: '裁判未返回该条判定' };

    let v = String(hit.verdict || '').toLowerCase();
    if (v !== 'pass' && v !== 'fail' && v !== 'uncertain') {
      // 兼容裁判偶尔退回旧格式 {pass: true}
      v = hit.pass === true ? 'pass' : (hit.pass === false ? 'fail' : 'uncertain');
    }
    return {
      check: q,
      verdict: v,
      pass: v === 'pass',
      reason: String(hit.reason || '').slice(0, 200)
    };
  });
}

// ============================================================
//  整局体验裁判
//
// 定点用例问的是「这一条行为对不对」，整局评审问的是「玩下来什么感觉」。
// 后者才是玩家真正能感知到的东西，所以评分用体验档位而不是通过/失败。
// ============================================================

const JOURNEY_SYSTEM_PROMPT = `你是一个游戏玩家，刚玩完一局文字对话游戏。
你会看到自己这一局的完整对话记录，以及事先设定的玩家画像。

请以**玩家本人**的口吻回答后面的问题，只输出 JSON。

# 评分档位

每个问题只给三个档位之一，不要给分数：
- 好：符合该问题描述里的"好"标准
- 一般：不功不过
- 差：符合"差"的标准

# 评分原则

- 你是玩家，不是测试员。评价的是**感受**，不是"系统有没有按设计工作"。
- 如果某一轮让你出戏、困惑、或者觉得被敷衍，要如实说，并指出是哪一轮。
- 引用原文片段作为依据，不要泛泛而谈。
- 不要因为"这是设定"就替角色开脱。玩家不会看设定。

# 输出格式

严格输出 JSON，不要 markdown 代码块，不要解释文字：

{"answers":[{"id":"Q1","rating":"好","reason":"依据，引用原文"}]}

rating 只能取：好 / 一般 / 差`;

/**
 * @param {object} persona 玩家画像
 * @param {Array} transcript 整局对话
 * @param {Array} questions 体验问题（含各档位标准）
 * @returns {Promise<Array<{id,text,rating,reason}>>}
 */
async function judgeJourney(persona, transcript, questions, callModel) {
  const qBlock = questions.map(function (q) {
    return [
      q.id + '. ' + q.text,
      '   - 好：' + q['好'],
      '   - 一般：' + q['一般'],
      '   - 差：' + q['差']
    ].join('\n');
  }).join('\n\n');

  const userPrompt = [
    '【我的玩家画像】',
    persona.name + '：' + persona.profile,
    '',
    '【我这一局的完整对话记录】',
    transcript.map(function (m) {
      return (m.role === 'user' ? '我：' : '他：') + m.content;
    }).join('\n'),
    '',
    '【请回答以下问题】',
    qBlock,
    '',
    '请输出 JSON。'
  ].join('\n');

  const raw = await callModel([
    { role: 'system', content: JOURNEY_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], { temperature: 0, max_tokens: 1500 });

  return parseJourneyOutput(raw, questions);
}

function parseJourneyOutput(raw, questions) {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');

  let parsed = null;
  if (s >= 0 && e > s) {
    try { parsed = JSON.parse(text.slice(s, e + 1)); } catch (err) { parsed = null; }
  }
  const answers = (parsed && Array.isArray(parsed.answers)) ? parsed.answers : [];

  return questions.map(function (q) {
    const hit = answers.find(function (a) { return a && a.id === q.id; });
    const rating = hit && ['好', '一般', '差'].indexOf(hit.rating) >= 0 ? hit.rating : '一般';
    return {
      id: q.id,
      text: q.text,
      rating: rating,
      reason: String((hit && hit.reason) || '裁判未返回该问题').slice(0, 240)
    };
  });
}

module.exports = { judgeCase, parseJudgeOutput, judgeJourney, parseJourneyOutput, JUDGE_SYSTEM_PROMPT, JOURNEY_SYSTEM_PROMPT };
