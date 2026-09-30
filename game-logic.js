/**
 * 《出局》— 纯逻辑层
 *
 * 这个文件被 index.html（浏览器）和 test.js（Node）共用，是唯一事实来源。
 *
 * ⚠️ 切分契约 —— 一个函数能进这里，当且仅当它：
 *    (a) 不碰 DOM
 *    (b) 不调 Math.random
 *    (c) 不调 setTimeout
 *    (d) 状态全走参数、只返回纯数据
 *
 * 随机候选句、音效、DOM 渲染都属于表现层，留在 index.html。
 * 这也是 test.js 不再随机失败的原因：hardFilter 返回错误码而不是随机句子。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================
  //  ⚙️  常量
  // ============================================================

  var TRUST_MIN = 0;
  var TRUST_MAX = 100;
  var TRUST_TAG_RANGE = 15;   // LLM 标签 / 回退规则的绝对值上限
  var TRUST_TURN_CAP = 12;    // 代码层单回合钳制上限
  var TESTIMONY_MAX = 40;     // 证词上限，超出丢最早

  var VOTE_ORDER = ['player', 'chenmo', 'linxiao', 'laozhao'];

  var TAGS = [
    'trustClaim', 'care', 'selfShare', 'cooperate', 'askIdentity',
    'claimFamiliar', 'previousRound', 'aiBackground', 'zhaoDaughter',
    'threat', 'insult', 'denyMemory', 'accuseObserver'
  ];

  var NEGATIVE_TAGS = ['threat', 'insult'];

  var TAG_LABELS = {
    trustClaim: '表信任',
    care: '关心',
    selfShare: '自述',
    cooperate: '求合作',
    askIdentity: '问身份',
    claimFamiliar: '熟悉感',
    previousRound: '往届',
    aiBackground: 'AI背景',
    zhaoDaughter: '老赵',
    threat: '施压',
    insult: '指控',
    denyMemory: '否认',
    accuseObserver: '点破'
  };

  // ============================================================
  //  🔍  正则（全部匹配"提问框架"，不匹配裸关键词）
  // ============================================================

  // 问对方的称呼。负向排除"我的名字"。
  var NAME_Q = /(你|您)(叫|是)(什么|啥|谁|嘛)|(你|您)?怎么称呼|(请问)?(你|您)的?名字是?(什么|啥|谁)|问你(个|一个)?名字|你叫啥/;

  // 问对方的职业
  var JOB_Q = /做什么(的|工作)|什么工作|职业是|你是干(什么|嘛)|从事什么|什么职业|干嘛的|干啥的|做啥的|干什么工作|做什么工作|你之前.{0,4}(干|做)|你以前.{0,4}(干|做)|什么行业|做哪行/;

  // 声称对设施熟悉 —— 同时也是线索 1 的触发条件
  var FAMILIAR = /(这里|这儿|这地方|这个地方|这栋楼|这栋建筑)(我)?(很|挺|好|有点|似乎|好像|感觉|总是)?(熟悉|眼熟)|我(好像|似乎|总觉得|莫名|仿佛)?(来|到)过(这里|这儿|这个地方)?|似曾相识|既视感|(好像|仿佛|感觉)?不是第一次(来|到)|觉得.{0,6}(熟悉|眼熟)/;

  // 问"我们是不是认识" —— 同时也是线索 2 的触发条件
  // 负向前瞻 (?![的们名]) 让"你还记得我吗"命中、"你还记得我的名字吗"不命中
  var ASK_IDENTITY = /(我们|咱俩|你和我|你我).{0,4}(是不是|难道)?(认识|见过|见过面)|你是不是(认识|认得|见过)我|你(还)?记得我(?![的们名])|你(是不是)?知道我(是谁)?/;

  // 提"上一届" —— 同时也是线索 3 的触发条件
  // 只认第 1-6 届（当前是第 7 届），避免玩家复述规则就解锁
  var PREV_ROUND = /上一届|上届|那一届|上(一)?轮|之(前|前那)一届|之(前|以)?前(的)?(那个|那批)?(实验|游戏)|上次(的)?(实验|游戏)|以前那些人|之前那批|第[一二三四五六]届/;

  // 暴露 AI / 学校背景
  var AI_BG = /人工智能|\bai\b|白蓝蓝|我的专业|我学的|我学计算机|我们学校|我的大学|我大学|神经科学|机器学习|深度学习|计算机系|智能系|记忆清除|洗脑/;

  var ZHAO_DAUGHTER = /老赵|赵(叔|大爷|师傅)|女儿|他闺女|小晴/;

  var THREAT = /闭嘴|滚(开|远|蛋)?|去死|杀了?你|弄死|揍你|打你|不客气|你最好(老实|说)|给我(老实)?(说|讲)|快说|赶紧说|别装了|装什么|别演了|少废话|老实交代/;

  var INSULT = /骗子|撒谎|骗我|你说谎|鬼话|放屁|扯淡|胡说|废话|你有病|神经病|废物|垃圾/;

  var TRUST_CLAIM = /我相信你|我信你|相信你|信任你|我信任你|我挺你|支持你|站你(这边|那边)|我站你|我理解你|理解你|我懂你|懂你|我站在你/;

  var CARE = /你还好(吗|么)|还好吗|没事吧|没事么|你没事|担心你|辛苦了|不容易|你怎么样|关心你|你冷不冷|你累不累|保重/;

  var COOPERATE = /一起(出去|走|离开|想办法|逃)|合作|联手|结盟|我们一伙|一起逃|帮你出去|搭档|带你出去/;

  // 真正的自我披露，不是"我觉得/我认为"这种口头禅
  var SELF_SHARE = /我叫|我来自|我的(名字|学校|专业|记忆|过去)|我记(得|不起|不得)|我什么都(不记得|想不起来)|我失忆|我(也)?想不起来|我(的)?记忆|我以前|我家里|我在.{0,6}(大学|学校)/;

  // 注意 (从|从来)? —— "从没"和"从来没"都是常见口语，只写"从来"会漏掉前者
  var DENY_MEMORY = /我(从|从来|根本|压根|确实)?没(来|到)过(这里|这儿|这个地方)?|我不认识(这里|这个地方|你)|我(以前)?没见过(你|这里)|我不记得(这里|你|这个地方)|我对这里(没|没有)印象|第一次来(这里|这儿)?/;

  var ACCUSE_OBSERVER = /林晓.{0,6}(观察|监视|卧底|主办方|不是好人|有问题|记录)|她(是|在)(观察|监视|记录)|观察者|卧底|主办方安插/;

  var HONEST = /说实话|坦白说|老实说|不瞒你|说真的|说句实话|跟你坦白|我跟你讲|我告诉你|老实跟你说/;

  var POLITE = /谢谢|感谢|多谢|麻烦你|不好意思|抱歉|对不起/;

  var RESPECT = /你觉得呢|你怎么看|你认为呢|你说呢|听你的|你决定|你说了算|我听你的|你怎么想|你怎么认为/;

  var INTEREST = /我想了解|我想知道|很好奇|感兴趣|我想听|说说看|讲讲|能说说吗|可以告诉我吗|愿闻其详|我很好奇|想听听/;

  var COMFORT = /别担心|别怕|没事的|会好的|一切都会好|别难过|别伤心|振作点|加油|有我在|别害怕|不用怕/;

  // 逼问（比 THREAT 轻，单独计 -5）
  var PRESS = /你到底说不说|你必须说|你必须告诉我|你不说我就|快点告诉我/;

  var MEMORY_KEYWORDS = ['认识', '记得', '熟悉', '上一届', '第一次', '背叛', '林晓', '老赵', '女儿', '淘汰', '死', '出去', '来过', '见过', '相信', '信任', '名字', '职业'];

  // 必须是"他本人在说自己的职业"，不能只要回复里出现"代码/程序"就算。
  // 旧版是裸词匹配，陈默随口提到"程序"两个字就会把职业标成已知，玩家会当成 bug。
  var JOB_HINTS = /我(是|以前是|之前是|做过|干过|搞过|学的?是).{0,6}(程序|开发|工程|码农|编程|写代码)|我.{0,4}(写|敲)代码|我(是|做|干)(程序员|工程师|开发的?)|干(我们)?这行|我们这一行/;

  // ============================================================
  //  🧰  基础工具
  // ============================================================

  function clampTrust(cur, delta) {
    return Math.max(TRUST_MIN, Math.min(TRUST_MAX, (Number(cur) || 0) + (Number(delta) || 0)));
  }

  // 纯正则版（原实现用 document.createElement，在 Node 里会崩）
  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // 去标点空白，用于重复句检测
  function normalizeText(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[\s，。！？!?~、.,；;：:"'“”‘’（）()\[\]【】]/g, '');
  }

  function lc(text) {
    return String(text == null ? '' : text).toLowerCase();
  }

  // ============================================================
  //  🛡️  内容过滤 —— 返回错误码，不返回句子（随机选句属于表现层）
  // ============================================================

  /**
   * @returns {null|'DENY_KNOW'|'DENY_PREV_ROUND'}
   */
  function hardFilter(text, trust) {
    var t = lc(text);
    var tr = Number(trust);
    if (isNaN(tr)) tr = 0;

    // 信任 < 30：否认认识
    if (tr < 30 && ASK_IDENTITY.test(t)) return 'DENY_KNOW';

    // 信任 < 50：回避"上一届"
    if (tr < 50 && PREV_ROUND.test(t)) return 'DENY_PREV_ROUND';

    return null;
  }

  /**
   * 拦住 LLM 心软泄露的信息。只拦真正的红线，误伤率要低。
   * @returns {{text: string, blocked: null|'BLOCK_PREV_ROUND'|'BLOCK_KNOW'}}
   */
  function outputFilter(reply, trust) {
    var raw = String(reply == null ? '' : reply);
    var tr = Number(trust);
    if (isNaN(tr)) tr = 0;
    var t = lc(raw);

    // 红线 1：信任 < 50 时提到上一届
    // 用强信号，不用裸的"以前/上次"（误伤太狠）
    if (tr < 50 && /上一届|上届|那一届|上(一)?轮|第[一二三四五六]届|之前那批|以前那些人/.test(t)) {
      return { text: raw, blocked: 'BLOCK_PREV_ROUND' };
    }

    // 红线 2：信任 < 30 时承认认识玩家
    if (tr < 30 && /(我|咱).{0,3}(认识|见过|记得)(你|他)|认识你|见过你|我们.{0,3}(认识|见过)|你不是第一次/.test(t)) {
      return { text: raw, blocked: 'BLOCK_KNOW' };
    }

    return { text: raw, blocked: null };
  }

  // ============================================================
  //  🧠  信任度
  // ============================================================

  /**
   * 从 LLM 回复里剥离 [trust:+N] 标签。取最后一次出现。
   * 容忍全角括号 / 冒号 / 写成"信任"。
   * @returns {{text: string, trust: number|null}}
   */
  function parseTrustTag(raw) {
    if (typeof raw !== 'string') return { text: '', trust: null };
    var re = /[\[［]\s*(?:trust|信任)\s*[:：]?\s*([+-]?\d+)\s*[\]］]/gi;
    var m, last = null;
    while ((m = re.exec(raw)) !== null) last = m;
    if (!last) return { text: raw.trim(), trust: null };

    // 取值用最后一次出现（最后一次才是模型的最终自评），
    // 但剥离要剥掉**全部** —— 否则模型在正文里多写一个标签就会原样显示给玩家。
    var text = raw.replace(re, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    var n = parseInt(last[1], 10);
    if (isNaN(n)) return { text: text, trust: null };
    return { text: text, trust: Math.max(-TRUST_TAG_RANGE, Math.min(TRUST_TAG_RANGE, n)) };
  }

  /**
   * 回退规则表 —— 仅在 LLM 没给标签、或走了 hardFilter 短路路径时使用。
   *
   * 与旧版的两个关键差异：
   *   1. 删掉了保底 `if (change >= 0) change += 2`（"只涨不跌"的根因）
   *   2. 加了重复句检测和套话衰减
   *
   * @param {string} text
   * @param {{trust?:number, playerMemory?:string[], recentTexts?:string[], tagCounts?:object}} ctx
   * @returns {{delta:number, flags:string[]}}
   */
  function calculateTrustChange(text, ctx) {
    ctx = ctx || {};
    var t = lc(text);
    var tagCounts = ctx.tagCounts || {};
    var recentTexts = ctx.recentTexts || [];
    var playerMemory = ctx.playerMemory || [];
    var flags = [];
    var change = 0;

    // 重复句：同样的话说第二遍不会更可信
    var norm = normalizeText(t);
    if (norm) {
      var recent = recentTexts.slice(-5);
      for (var i = 0; i < recent.length; i++) {
        if (normalizeText(recent[i]) === norm) {
          return { delta: -1, flags: ['REPEAT'] };
        }
      }
    }

    // 正向
    if (CARE.test(t)) change += 6;
    if (TRUST_CLAIM.test(t)) change += 10;
    if (HONEST.test(t)) change += 5;
    if (POLITE.test(t)) change += 3;
    if (RESPECT.test(t)) change += 4;
    if (INTEREST.test(t)) change += 3;
    if (COMFORT.test(t)) change += 5;
    if (COOPERATE.test(t)) change += 5;
    if (SELF_SHARE.test(t) && t.length > 5) change += 2;

    // 负向
    if (INSULT.test(t)) change -= 8;
    if (THREAT.test(t)) change -= 12;
    if (PRESS.test(t)) change -= 5;

    // 前后矛盾
    if (DENY_MEMORY.test(t)) {
      var contradicted = false;
      for (var j = 0; j < playerMemory.length; j++) {
        var m = lc(playerMemory[j]);
        if (FAMILIAR.test(m) || ASK_IDENTITY.test(m)) { contradicted = true; break; }
      }
      if (contradicted) {
        change -= 10;
        flags.push('CONTRADICTION');
      }
    }

    // 同类套话衰减
    var claims = tagCounts.trustClaim || 0;
    if (change > 0 && claims >= 4) change = 0;
    else if (change > 0 && claims >= 2) change = Math.floor(change / 2);

    // 防卡死下限：有实质内容的中性发言给 +2，避免去掉保底后信任完全不动。
    // 门槛设为 6 字 —— 中文里这大约是一句完整的话；"嗯""好的""不知道" 仍然拿不到分。
    // 只要求"说了点东西"，不要求说好话，所以刷套话依然无效（重复句会被判 -1）。
    if (change === 0 && t.length >= 6) change = 2;

    return {
      delta: Math.max(-TRUST_TAG_RANGE, Math.min(TRUST_TAG_RANGE, change)),
      flags: flags
    };
  }

  /**
   * 代码层钳制 —— 无论 LLM 标签还是回退结果都要过这一关。
   * LLM 光靠 prompt 说"重复给 0"不可靠，会老实每轮给 +5，所以这里兜底。
   */
  function clampTrustDelta(delta, tagCounts, flags) {
    var d = Number(delta) || 0;
    tagCounts = tagCounts || {};
    if (flags && flags.indexOf('REPEAT') >= 0) return -1;

    if (d > 0) {
      var claims = tagCounts.trustClaim || 0;
      if (claims >= 4) d = 0;
      else if (claims >= 2) d = Math.floor(d / 2);
    }
    return Math.max(-TRUST_TURN_CAP, Math.min(TRUST_TURN_CAP, d));
  }

  /**
   * 一次性 +25 会同时跨越 30 和 50，所以返回数组而不是单个值。
   * @returns {number[]} 例如 [30] / [50] / [30,50] / []
   */
  function detectTrustThresholdCross(oldTrust, newTrust) {
    var out = [];
    [30, 50].forEach(function (th) {
      if (oldTrust < th && newTrust >= th) out.push(th);
    });
    return out;
  }

  // ============================================================
  //  🔑  线索
  // ============================================================

  /** @returns {number[]} 本次需要解锁的线索号 */
  function checkClueUnlock(text, state) {
    var t = lc(text);
    var clues = (state && state.clues) || {};
    var trustChenmo = ((state && state.trust) || {}).chenmo || 0;
    var out = [];

    if (!(clues[1] && clues[1].unlocked) && FAMILIAR.test(t)) out.push(1);
    if (!(clues[2] && clues[2].unlocked) && trustChenmo >= 30 && ASK_IDENTITY.test(t)) out.push(2);
    if (!(clues[3] && clues[3].unlocked) && trustChenmo >= 50 && PREV_ROUND.test(t)) out.push(3);

    return out;
  }

  /**
   * 保底解锁 —— 防止玩家卡在"信任涨不上去 → 线索解锁不了 → 投票永不触发"的死锁。
   * 门槛比关键词路径低（20/35 vs 30/50），因为它是兜底而不是奖励。
   * @returns {number[]}
   */
  function checkAutoClueUnlock(state, turnCount) {
    var clues = (state && state.clues) || {};
    var trustChenmo = ((state && state.trust) || {}).chenmo || 0;
    var out = [];

    if (!(clues[1] && clues[1].unlocked) && turnCount >= 8) out.push(1);
    if (!(clues[2] && clues[2].unlocked) && turnCount >= 15 && trustChenmo >= 20) out.push(2);
    if (!(clues[3] && clues[3].unlocked) && turnCount >= 22 && trustChenmo >= 35) out.push(3);

    return out;
  }

  function isAllCluesUnlocked(state) {
    var clues = (state && state.clues) || {};
    return [1, 2, 3].every(function (i) { return clues[i] && clues[i].unlocked; });
  }

  // ============================================================
  //  📝  身份识别
  // ============================================================

  /**
   * @returns {{nameKnown:boolean, jobKnown:boolean}} 本次新解锁的项
   */
  function checkNPCInfoQuery(text, npcInfo) {
    var t = lc(text);
    var info = npcInfo || {};
    var got = { nameKnown: false, jobKnown: false };

    if (!info.nameKnown && NAME_Q.test(t)) got.nameKnown = true;
    if (!info.jobKnown && JOB_Q.test(t)) got.jobKnown = true;

    return got;
  }

  /** @returns {boolean} 是否推断出了职业 */
  function autoDetectJobFromReply(reply, npcInfo) {
    var info = npcInfo || {};
    if (info.jobKnown) return false;
    return JOB_HINTS.test(lc(reply));
  }

  function extractMemoryKeywords(text) {
    var s = String(text == null ? '' : text);
    return MEMORY_KEYWORDS.filter(function (k) { return s.indexOf(k) >= 0; });
  }

  // ============================================================
  //  📋  证词
  // ============================================================

  /** @returns {string[]} 这句话被打上的标签 */
  function tagTestimony(text) {
    var t = lc(text);
    var tags = [];
    if (TRUST_CLAIM.test(t)) tags.push('trustClaim');
    if (CARE.test(t)) tags.push('care');
    if (SELF_SHARE.test(t)) tags.push('selfShare');
    if (COOPERATE.test(t)) tags.push('cooperate');
    if (ASK_IDENTITY.test(t)) tags.push('askIdentity');
    if (FAMILIAR.test(t)) tags.push('claimFamiliar');
    if (PREV_ROUND.test(t)) tags.push('previousRound');
    if (AI_BG.test(t)) tags.push('aiBackground');
    if (ZHAO_DAUGHTER.test(t)) tags.push('zhaoDaughter');
    if (THREAT.test(t)) tags.push('threat');
    if (INSULT.test(t)) tags.push('insult');
    if (DENY_MEMORY.test(t)) tags.push('denyMemory');
    if (ACCUSE_OBSERVER.test(t)) tags.push('accuseObserver');
    return tags;
  }

  /**
   * 注意：证词存的是玩家说过的**全部原话**，和 recordPlayerMemory 的用途不同
   * （后者只在命中关键词时记录、上限 20 条，回放屏会缺句错序）。
   */
  function buildTestimonyEntry(text, turn, trust) {
    var s = String(text == null ? '' : text);
    return { text: s, turn: turn, tags: tagTestimony(s), trustAtTime: trust };
  }

  function pushTestimony(testimony, entry, max) {
    testimony.push(entry);
    var cap = max || TESTIMONY_MAX;
    while (testimony.length > cap) testimony.shift();   // 丢最早的
    return testimony;
  }

  function countTags(testimony) {
    var acc = {};
    (testimony || []).forEach(function (e) {
      (e.tags || []).forEach(function (t) { acc[t] = (acc[t] || 0) + 1; });
    });
    return acc;
  }

  /** 带时间衰减的标签计分：最近 6 条权重 1.0，更早 0.5 */
  function tagScore(testimony) {
    var list = testimony || [];
    var n = list.length;
    var acc = {};
    list.forEach(function (e, i) {
      var w = i >= n - 6 ? 1 : 0.5;
      (e.tags || []).forEach(function (t) { acc[t] = (acc[t] || 0) + w; });
    });
    return acc;
  }

  function detectContradiction(testimony) {
    var fam = false, deny = false;
    (testimony || []).forEach(function (e) {
      var tags = e.tags || [];
      if (tags.indexOf('claimFamiliar') >= 0) fam = true;
      if (tags.indexOf('denyMemory') >= 0) deny = true;
    });
    return fam && deny;
  }

  function tagLabel(tag) {
    return TAG_LABELS[tag] || tag;
  }

  function isNegativeTag(tag) {
    return NEGATIVE_TAGS.indexOf(tag) >= 0;
  }

  // ============================================================
  //  🗳️  投票结算
  // ============================================================

  function buildVoteState(state) {
    var testimony = (state && state.testimony) || [];
    return {
      trust: (state && state.trust) || {},
      testimony: testimony,
      tagScore: tagScore(testimony),
      contradiction: detectContradiction(testimony),
      round: (state && state.round) || 1
    };
  }

  /**
   * 林晓的判据：样本偏离预设的程度。
   * accuseObserver 权重特意等于阈值（6），即"点破她的身份"一句话就足以让她动手。
   */
  function anomalyScore(s) {
    var t = s.tagScore || {};
    return 3 * (t.claimFamiliar || 0)
      + 3 * (t.askIdentity || 0)
      + 4 * (t.previousRound || 0)
      + 4 * (t.aiBackground || 0)
      + 6 * (t.accuseObserver || 0)
      + 2 * (t.selfShare || 0);
  }

  /** 敌意程度 —— 林晓和老赵都会看这个 */
  function hostilityScore(s) {
    var t = s.tagScore || {};
    return (t.threat || 0) + (t.insult || 0);
  }

  /** 陈默：被背叛过的幸存者。怕"又是那个人"，但不想再错杀。信任度是主锚。 */
  function voteChenmo(s) {
    var t = s.tagScore || {};
    var tr = (s.trust && s.trust.chenmo) || 0;

    var against = 2.5 * (t.threat || 0) + 2 * (t.insult || 0)
      + 2.5 * (t.askIdentity || 0) + 1.5 * (t.previousRound || 0)
      + (s.contradiction ? 4 : 0);
    var forPlayer = 1.5 * (t.trustClaim || 0) + 1.5 * (t.care || 0)
      + 2.5 * (t.cooperate || 0) + 1 * (t.selfShare || 0);
    var bias = tr < 30 ? 7 : (tr < 45 ? 3 : (tr >= 65 ? -5 : 0));

    // 阈值 4（不是 2）：陈默戒备但不急着杀人，光靠"信任低"这一条不够定罪
    if (against + bias - forPlayer > 4) {
      var hostile = ((t.threat || 0) + (t.insult || 0)) > 0;
      return { vote: 'player', reason: hostile ? 'THREAT' : 'DISTRUST' };
    }
    // 不投你时：他知道林晓是观察者，但信任够高才敢动她
    return tr >= 45
      ? { vote: 'linxiao', reason: 'SUSPECT_LINXIAO' }
      : { vote: 'laozhao', reason: 'SPARE' };
  }

  /**
   * 林晓：主办方观察者。她只关心"样本是否偏离预设"。
   * 偏离有两种：记忆在恢复（异常样本），或者情绪失控（不稳定样本）。
   */
  function voteLinxiao(s) {
    var anom = anomalyScore(s);
    if (anom >= 6) return { vote: 'player', reason: 'ANOMALY' };
    if (hostilityScore(s) >= 1.5) return { vote: 'player', reason: 'HOSTILE_SAMPLE' };

    var t = s.tagScore || {};
    return (t.zhaoDaughter || 0) > 0
      ? { vote: 'chenmo', reason: 'KEEP_EXPERIMENT' }
      : { vote: 'laozhao', reason: 'KEEP_EXPERIMENT' };
  }

  /** 老赵：女儿死在上一届，他本来就是冲"活下来的那个孩子"来的。 */
  function voteLaozhao(s) {
    var t = s.tagScore || {};
    var heat = 2.0 * (t.previousRound || 0) + 1.5 * (t.askIdentity || 0)
      + 1.0 * (t.zhaoDaughter || 0) + 2.0 * (t.insult || 0)
      + 1.5 * (t.threat || 0);
    var calm = 2.0 * (t.care || 0) + 1.0 * (t.trustClaim || 0);

    if (heat - calm >= 5) return { vote: 'player', reason: 'REVENGE' };
    return { vote: 'chenmo', reason: 'HUNT_SURVIVOR' };
  }

  /**
   * 平票由观察者裁定 —— 这条规则平时不出现，只在平票那一刻由广播公布，
   * 同时是"林晓不是普通受试者"的第二次伏笔。
   *
   * ⚠️ 顺位很重要：玩家参与平票必须**先**判，否则 PROTECT_OBSERVER 会在四人全平票时
   * 武断地丢掉玩家（玩家排在 VOTE_ORDER 第一位），玩家会觉得被暗算而不是被裁定。
   */
  function resolveTie(leaders, s) {
    var sorted = leaders.slice().sort(function (a, b) {
      return VOTE_ORDER.indexOf(a) - VOTE_ORDER.indexOf(b);
    });

    // 1) 玩家参与平票 → 观察者裁定：越像在恢复记忆，越淘汰你
    if (sorted.indexOf('player') >= 0) {
      return anomalyScore(s) >= 6
        ? { eliminated: 'player', by: 'linxiao', reason: 'ANOMALY' }
        : { eliminated: sorted.filter(function (x) { return x !== 'player'; })[0],
            by: 'linxiao', reason: 'KEEP_SAMPLE' };
    }
    // 2) 平票涉及林晓（玩家不在其中）→ 主办方保自己的观察者
    if (sorted.indexOf('linxiao') >= 0) {
      return { eliminated: sorted.filter(function (x) { return x !== 'linxiao'; })[0],
               by: 'host', reason: 'PROTECT_OBSERVER' };
    }
    // 3) 与玩家无关的平票
    return { eliminated: sorted[0], by: 'linxiao', reason: 'NEUTRAL' };
  }

  /**
   * ⚠️ 契约：eliminated 永不为 null，否则结局屏会渲染出 "undefined 被淘汰了"。
   *
   * 命名注意：ballots = 谁投给谁，tally = 各得几票。
   * 旧代码用 votes.player 同时表示这两件事，是原 bug 难被发现的原因之一。
   */
  function computeVotes(playerVote, state) {
    var s = buildVoteState(state);
    var c = voteChenmo(s), l = voteLinxiao(s), z = voteLaozhao(s);

    var ballots = { player: playerVote, chenmo: c.vote, linxiao: l.vote, laozhao: z.vote };
    var tally = { player: 0, chenmo: 0, linxiao: 0, laozhao: 0 };

    VOTE_ORDER.forEach(function (k) {
      var v = ballots[k];
      if (tally[v] === undefined) tally[v] = 0;
      tally[v]++;
    });

    var maxVotes = Math.max(tally.player, tally.chenmo, tally.linxiao, tally.laozhao);
    var leaders = VOTE_ORDER.filter(function (k) { return tally[k] === maxVotes; });
    var tie = leaders.length > 1;

    var res = tie
      ? resolveTie(leaders, s)
      : { eliminated: leaders[0], by: null, reason: null };

    return {
      ballots: ballots,
      tally: tally,
      maxVotes: maxVotes,
      leaders: leaders,
      tie: tie,
      eliminated: res.eliminated,
      tieBreak: tie ? res : null,
      reasons: { chenmo: c.reason, linxiao: l.reason, laozhao: z.reason },
      playerVotedFor: playerVote
    };
  }

  var REASON_TEXT = {
    THREAT: '你让他想起了什么',
    DISTRUST: '他不信你',
    SUSPECT_LINXIAO: '他更不信她',
    SPARE: '他放过了你',
    ANOMALY: '样本记忆恢复异常',
    HOSTILE_SAMPLE: '样本情绪失控',
    KEEP_EXPERIMENT: '实验还要继续',
    REVENGE: '他在找人',
    HUNT_SURVIVOR: '他冲着他来的',
    PROTECT_OBSERVER: '主办方保她',
    KEEP_SAMPLE: '样本还有用',
    NEUTRAL: '随手一票'
  };

  function voteReasonText(code) {
    return REASON_TEXT[code] || '';
  }

  // ============================================================
  //  🎮  初始状态 —— index.html 与 test.js 共用，从根上掐死漂移
  // ============================================================

  function createInitialState() {
    return {
      currentScreen: 'intro',
      currentNPC: 'chenmo',
      round: 1,
      aliveCount: 4,
      turnCount: 0,
      trust: { chenmo: 20, linxiao: 20, laozhao: 20 },
      npcInfo: {
        chenmo: { name: '陈默', job: '程序员', nameKnown: false, jobKnown: false, avatar: '😶' },
        linxiao: { name: '林晓', job: '大学生', nameKnown: false, jobKnown: false, avatar: '😊' },
        laozhao: { name: '老赵', job: '出租车司机', nameKnown: false, jobKnown: false, avatar: '😐' }
      },
      clues: {
        1: { unlocked: false, title: '这个地方不是第一次出现', desc: '设施里有旧的痕迹，证明之前有人来过' },
        2: { unlocked: false, title: '陈默认识你', desc: '陈默对你的态度不对劲，他似乎知道你的一些事' },
        3: { unlocked: false, title: '上一届实验存在', desc: '有上一届的证据——旧名单、照片、物品' }
      },
      playerMemory: [],
      chatHistory: { chenmo: [], linxiao: [], laozhao: [] },
      testimony: [],
      tagCounts: {},
      recentTexts: [],
      selectedVote: null,
      isGenerating: false,
      noProgressTurns: 0,
      introStep: 0,
      chatIntroShown: false
    };
  }

  // ============================================================

  return {
    // 常量
    TRUST_MIN: TRUST_MIN,
    TRUST_MAX: TRUST_MAX,
    TRUST_TAG_RANGE: TRUST_TAG_RANGE,
    TRUST_TURN_CAP: TRUST_TURN_CAP,
    TESTIMONY_MAX: TESTIMONY_MAX,
    VOTE_ORDER: VOTE_ORDER,
    TAGS: TAGS,
    TAG_LABELS: TAG_LABELS,

    // 基础
    clampTrust: clampTrust,
    escapeHtml: escapeHtml,
    normalizeText: normalizeText,

    // 过滤
    hardFilter: hardFilter,
    outputFilter: outputFilter,

    // 信任
    parseTrustTag: parseTrustTag,
    calculateTrustChange: calculateTrustChange,
    clampTrustDelta: clampTrustDelta,
    detectTrustThresholdCross: detectTrustThresholdCross,

    // 线索
    checkClueUnlock: checkClueUnlock,
    checkAutoClueUnlock: checkAutoClueUnlock,
    isAllCluesUnlocked: isAllCluesUnlocked,

    // 身份
    checkNPCInfoQuery: checkNPCInfoQuery,
    autoDetectJobFromReply: autoDetectJobFromReply,
    extractMemoryKeywords: extractMemoryKeywords,

    // 证词
    tagTestimony: tagTestimony,
    buildTestimonyEntry: buildTestimonyEntry,
    pushTestimony: pushTestimony,
    countTags: countTags,
    tagScore: tagScore,
    detectContradiction: detectContradiction,
    tagLabel: tagLabel,
    isNegativeTag: isNegativeTag,

    // 投票
    buildVoteState: buildVoteState,
    anomalyScore: anomalyScore,
    voteChenmo: voteChenmo,
    voteLinxiao: voteLinxiao,
    voteLaozhao: voteLaozhao,
    resolveTie: resolveTie,
    computeVotes: computeVotes,
    voteReasonText: voteReasonText,

    // 初始化
    createInitialState: createInitialState
  };
});
