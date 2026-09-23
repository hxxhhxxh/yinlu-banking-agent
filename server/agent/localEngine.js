'use strict';
/**
 * 本地意图引擎（离线演示模式的"大脑"）——无需大模型即可完成意图理解 → 任务规划 → 工具编排。
 * 大模型可用时由大模型负责规划，本引擎作为兜底与降级方案，保证比赛现场断网也能演完全流程。
 */
const nlu = require('./nlu');
const store = require('../store');

/** 意图规则：从上到下匹配，命中即返回 */
const INTENT_RULES = [
  {
    // 招呼/感谢/告别：仅在“纯寒暄”时命中（短且不含业务词），不会抢走业务意图
    intent: 'smalltalk', label: '寒暄回应', tool: 'smalltalk', phase: 1,
    guard: (t) => String(t).length <= 14 && !/[转查买账单理财冻结挂失取消密码预约额]/.test(t),
    patterns: [/你好|您好|嗨|哈喽|hello|hi\b/i, /早上好|上午好|中午好|下午好|晚上好|晚安|早安/, /在吗|在么|有人吗/, /谢谢|多谢|感谢|辛苦/, /再见|拜拜|回见/, /你是谁|你叫什么|介绍一下|能做什么|会什么/],
  },
  {
    // 必须排在 transfer_money 之前："转账记录" 也含"转账"
    intent: 'query_transfers', label: '查询转账记录', tool: 'query_transfers', phase: 2,
    patterns: [/转账记录/, /转过哪些/, /最近的转账/, /转账历史/],
  },
  {
    // 必须排在 transfer_money 之前：用户问的是"能不能转/有没有风险"，要的是预检而不是执行
    intent: 'preview_transfer', label: '转账风控预检', tool: 'preview_transfer', phase: 1,
    patterns: [/能不能转/, /能转多少/, /行不行/, /有没有风险/, /有风险吗/, /转得过去吗/, /预检/, /帮我看看.{0,6}转/, /这笔转/, /风险评估/],
  },
  {
    // 必须排在 undo_last_transfer 之前："撤销上一步"含"撤销"
    intent: 'undo_last_action', label: '回退上一步操作', tool: 'undo_last_action', phase: 7,
    patterns: [/回退/, /撤销上一步/, /恢复上一步/, /退回上一步/, /反悔/, /恢复刚才/],
  },
  {
    intent: 'undo_last_transfer', label: '撤销最近一笔转账', tool: 'undo_last_transfer', phase: 2,
    patterns: [/撤销/, /撤回/, /转错/, /退回来/, /取消刚才那笔/, /不想要了/],
  },
  {
    // 必须排在 transfer_money 之前："每月1号给房东转2200"其实是定时转账
    intent: 'schedule_transfer', label: '定时转账', tool: 'schedule_transfer', phase: 2,
    patterns: [/定时转账/, /预约转账/, /自动转/, /每(个)?月/, /每(个)?[年限]/, /下个月.{0,6}(转|打|汇)/, /到期.{0,4}再转/],
  },
  {
    // 必须排在 transfer_money 之前：AA 句子里也常含"转"
    intent: 'split_aa_collect', label: 'AA 拆分收款', tool: 'split_aa_collect', phase: 2,
    patterns: [/AA/i, /aa/, /平摊/, /拆分/, /一起付/, /均摊/, /收一下/],
  },
  {
    intent: 'transfer_money', label: '智能转账', tool: 'transfer_money', phase: 2,
    patterns: [/转账/, /转钱/, /转点/, /打钱/, /汇款/, /给.{0,6}(转|打|汇)/, /帮忙交/, /交个?物业费/],
  },
  {
    intent: 'analyze_bills', label: '账单分析', tool: 'analyze_bills', phase: 3, degradeTo: 'query_transactions',
    patterns: [/账单/, /花了多少/, /花了多少钱/, /花了/, /花哪/, /花到哪/, /都花/, /花在/, /消费统计/, /分类/, /开销/, /月报/, /年报/, /年度报告/],
  },
  {
    intent: 'run_scheduled', label: '执行到期预约', tool: 'run_scheduled', phase: 7,
    patterns: [/执行预约/, /模拟到期/, /时间推进/, /到期执行/, /把生日安排执行/],
  },
  {
    intent: 'detect_anomalies', label: '异常交易识别', tool: 'detect_anomalies', phase: 3,
    patterns: [/异常/, /可疑/, /不对劲/, /不太对/, /陌生交易/, /是不是被盗/, /被盗刷/, /风险交易/],
  },
  {
    // 必须排在 list_subscriptions 之前："把那个老扣我钱的会员关了" 同时命中两者，语义上应以"取消"为准
    intent: 'cancel_subscription', label: '取消订阅', tool: 'cancel_subscription', phase: 3,
    patterns: [/取消.{0,6}(订阅|会员|续费|包月)/, /(关掉|关闭|停掉|退掉).{0,8}(订阅|会员|续费|包月)/, /把那个.{0,10}关/, /别再扣/, /不想再(交|付|续)/, /退订/],
  },
  {
    intent: 'list_subscriptions', label: '订阅/代扣查询', tool: 'list_subscriptions', phase: 3, degradeTo: 'query_transactions',
    patterns: [/订阅/, /代扣/, /自动续费/, /会员/, /扣我钱/, /扣费/],
  },
  {
    // 必须排在 recommend_products 之前："我的理财" 含"理财"
    intent: 'query_holdings', label: '查询持仓', tool: 'query_holdings', phase: 4,
    patterns: [/持仓/, /我买了什么/, /我的理财/, /赚了多少/, /收益多少/],
  },
  {
    intent: 'recommend_products', label: '理财推荐与对比', tool: 'recommend_products', phase: 4,
    patterns: [/理财/, /基金/, /推荐.{0,4}(产品|理财)/, /有什么.{0,4}(产品|理财)/, /怎么.{0,2}赚/],
  },
  {
    intent: 'assess_risk', label: '风险测评', tool: 'assess_risk', phase: 4,
    patterns: [/风险测评/, /风险等级/, /我的风险/, /测评/],
  },
  {
    intent: 'purchase_product', label: '理财申购', tool: 'purchase_product', phase: 4,
    patterns: [/申购/, /买入/, /下单/, /买.{0,8}(宝|添利|存单|混合|股票|权益|成长|稳健|均衡|现金)/, /拿.{0,3}(万|千|元|块).{0,3}买/, /买.{0,6}(万|元|块)/, /投.{0,4}(万|元|块)/],
  },
  {
    intent: 'redeem_product', label: '理财赎回', tool: 'redeem_product', phase: 4,
    patterns: [/赎回/, /卖出/, /取出/],
  },
  {
    // 必须排在 report_card_loss 之前："取消挂失"也含"挂失"
    intent: 'report_card_unfreeze', label: '卡片解挂', tool: 'report_card_unfreeze', phase: 7,
    patterns: [/解挂/, /恢复用卡/, /取消挂失/, /重新启用/, /卡恢复/],
  },
  {
    intent: 'report_card_loss', label: '卡片挂失', tool: 'report_card_loss', phase: 4,
    patterns: [/挂失/, /丢了/, /卡丢/, /被盗刷/],
  },
  {
    intent: 'change_password', label: '交易密码修改', tool: 'change_password', phase: 7,
    patterns: [/改.{0,3}密码/, /修改密码/, /重置密码/, /换密码/, /密码改/],
  },
  {
    // 必须带"改额度"的动作词，否则"额度多少/额度分别多少"这类查询会被抢走
    intent: 'adjust_credit_limit', label: '额度调整', tool: 'adjust_credit_limit', phase: 4,
    guard: (t) => /提到|提升|提高|升到|调高|调到|调整到|改成|设为|降额|降低|降到|调低/.test(t),
    patterns: [/额度/, /提额/, /降额/],
  },
  {
    intent: 'set_card_limit', label: '交易限额/解锁', tool: 'set_card_limit', phase: 4,
    patterns: [/限额/, /限制交易/, /解锁/, /冻结/, /解冻/],
  },
  {
    // 必须排在 apply_card 之前："办张虚拟卡"会被 /办.{0,6}卡/ 抢走
    intent: 'apply_virtual_card', label: '虚拟卡开通', tool: 'apply_card', phase: 7,
    patterns: [/虚拟卡/, /虚拟银行卡/],
  },
  {
    intent: 'apply_card', label: '卡片申请', tool: 'apply_card', phase: 4,
    patterns: [/办卡/, /办.{0,6}卡/, /申请.{0,4}卡/, /新卡/, /开卡/, /想要一张/],
  },
  {
    intent: 'gift_concierge', label: '跨场景联动', tool: 'gift_concierge', phase: 5,
    patterns: [/生日/, /礼物/, /送.{0,4}(花|蛋糕)/, /纪念日/, /母亲节/, /父亲节/, /节日/],
  },
  {
    intent: 'query_balance', label: '查询余额', tool: 'query_balance', phase: 1,
    patterns: [/余额/, /还有多少钱/, /有多少钱/, /多少钱/, /查账/, /资产/, /可用额度/, /欠多少/, /剩多少/],
  },
  {
    intent: 'query_transactions', label: '查询交易明细', tool: 'query_transactions', phase: 1,
    patterns: [/明细/, /流水/, /交易记录/, /最近.{0,4}(消费|交易|花了)/, /消费记录/],
  },
  {
    intent: 'query_payees', label: '查询常用收款人', tool: 'query_payees', phase: 1,
    patterns: [/常用收款人/, /收款人/, /转账名单/, /联系人/],
  },
  {
    intent: 'query_cards', label: '查询名下卡片', tool: 'query_cards', phase: 1,
    patterns: [/我有几张卡/, /几张卡/, /有哪些卡/, /我的卡/, /银行卡/, /卡片/, /信用卡/, /储蓄卡/, /额度多少/, /额度分别/, /额度是/, /卡.{0,2}额度/],
  },
  {
    intent: 'query_profile', label: '查询用户画像', tool: 'query_profile', phase: 1,
    patterns: [/我是谁/, /我的信息/, /我的资料/, /风险测评等级/],
  },
];

function detectIntentAll(text) {
  const t = nlu.normalize(text);
  const hits = [];
  for (const rule of INTENT_RULES) {
    if (rule.guard && !rule.guard(t)) continue; // 上下文/长度守卫：避免招呼语抢走业务意图
    for (const re of rule.patterns) {
      if (re.test(t)) { hits.push({ ...rule, matched: re.toString() }); break; }
    }
  }
  return hits;
}

function detectIntent(text) {
  return detectIntentAll(text)[0] || null;
}

/**
 * 能力降级：当首选意图所属能力尚未上线、但存在"可先行的已实现能力"时，
 * 降级到已实现能力并如实告知用户"完整能力待哪个阶段上线"。
 * 返回 { rule, degradedFrom } —— degradedFrom 为 null 表示无需降级。
 */
function resolveIntent(text, isImplemented) {
  const hits = detectIntentAll(text);
  if (!hits.length) return { rule: null, degradedFrom: null };
  const primary = hits[0];
  if (isImplemented(primary.tool)) return { rule: primary, degradedFrom: null };
  const alt = hits.find((h) => h !== primary && isImplemented(h.tool));
  if (alt) return { rule: alt, degradedFrom: primary };
  if (primary.degradeTo && isImplemented(primary.degradeTo)) {
    const target = INTENT_RULES.find((r) => r.tool === primary.degradeTo);
    if (target) return { rule: target, degradedFrom: primary };
  }
  return { rule: primary, degradedFrom: null };
}

/** 复杂句 → 多步计划（阶段1只做查询类组合，后续阶段扩展） */
function buildPlan(intentRule, text, extra = {}) {
  const t = nlu.normalize(text);
  const steps = [];

  if (intentRule.intent === 'analyze_bills') {
    const cats = nlu.detectCategory(t);
    const range = nlu.parseTimeRange(t);
    const args = {};
    if (cats.length) args.category = cats[0];
    if (range) { args.from = range.from; args.to = range.to; }
    if (/年度|年报|全年|今年/.test(t)) args.year = 2026;
    steps.push({ tool: 'analyze_bills', args, why: '按你指定的时间范围与分类，对真实流水做分类统计与环比' });
    if (/不对劲|异常|可疑|被盗|不安全/.test(t)) {
      steps.push({ tool: 'detect_anomalies', args: { limit: 10 }, why: '你还问了"有没有不对劲的"，所以再跑一次异常交易识别', parallel: true });
    }
  } else if (intentRule.intent === 'detect_anomalies') {
    steps.push({ tool: 'detect_anomalies', args: { limit: 10 }, why: '用评分制规则扫描全部流水，找出可疑交易并给出证据' });
  } else if (intentRule.intent === 'list_subscriptions') {
    steps.push({ tool: 'list_subscriptions', args: { soonDays: 7 }, why: '列出订阅，并从流水中自动识别周期性扣费与续费时间' });
  } else if (intentRule.intent === 'cancel_subscription') {
    const subs = store.get().subscriptions.filter((x) => (x.status || 'active') === 'active');
    const named = subs.find((x) => t.includes(x.merchant) || t.includes(x.merchant.split('·')[0]));
    steps.push({
      tool: 'cancel_subscription',
      args: { merchant: named ? named.merchant : '', hint: t },
      why: '取消订阅会改变后续扣费，先定位具体是哪一个并展示明细，再请你确认',
    });
  } else if (intentRule.intent === 'query_holdings') {
    steps.push({ tool: 'query_holdings', args: {}, why: '读取你的理财持仓与估算收益（只读）' });
  } else if (intentRule.intent === 'recommend_products') {
    steps.push({ tool: 'recommend_products', args: {}, why: '先看你的风险等级，再做适当性过滤后的推荐与对比' });
  } else if (intentRule.intent === 'assess_risk') {
    const letters = (t.match(/[A-Ea-e]{5,}/) || [])[0] || '';
    steps.push({ tool: 'assess_risk', args: { answers: letters || undefined }, why: '理财推荐必须先完成风险测评，先看看你的测评状态/答案' });
  } else if (intentRule.intent === 'purchase_product') {
    steps.push({
      tool: 'purchase_product',
      args: { productName: t, amount: nlu.parseAmount(t) },
      why: '申购前先过测评有效性、适当性、起购金额三道校验，再生成待确认单',
    });
  } else if (intentRule.intent === 'redeem_product') {
    steps.push({
      tool: 'redeem_product',
      args: { productName: t, amount: nlu.parseAmount(t), all: /全部|都赎回|全赎/.test(t) },
      why: '赎回前展示持仓与金额，回款到卡后给你凭证',
    });
  } else if (intentRule.intent === 'change_password') {
    steps.push({ tool: 'change_password', args: { cardId: t }, why: '密码修改属红色级别：需短信验证码 + 人脸识别双因子' });
  } else if (intentRule.intent === 'report_card_unfreeze') {
    steps.push({ tool: 'report_card_unfreeze', args: { cardId: t }, why: '解挂属红色级别：需多因子确认后才恢复交易' });
  } else if (intentRule.intent === 'apply_virtual_card') {
    steps.push({ tool: 'apply_card', args: { cardType: '虚拟卡' }, why: '虚拟卡属黄色级别：展示卡种与额度后确认即可即时开通' });
  } else if (intentRule.intent === 'apply_card') {
    steps.push({ tool: 'apply_card', args: { cardType: t }, why: '办卡申请会产生征信查询，先确认卡种再提交' });
  } else if (intentRule.intent === 'adjust_credit_limit') {
    steps.push({
      tool: 'adjust_credit_limit',
      args: { cardId: t, newLimit: nlu.parseAmount(t), delta: null },
      why: '额度调整影响信用风险敏口，先展示当前额度与目标额度再确认',
    });
  } else if (intentRule.intent === 'set_card_limit') {
    const action = /解冻|解锁|恢复交易/.test(t) ? 'unfreeze' : (/冻结|限制交易|锁卡/.test(t) ? 'freeze' : 'limit');
    steps.push({
      tool: 'set_card_limit',
      args: { cardId: t, action, singleLimit: action === 'limit' ? nlu.parseAmount(t) : null, dailyLimit: null },
      why: action === 'limit' ? '限额调整直接影响卡片可用性，先展示当前值再确认' : '冻结/解冻会立即影响卡片使用，先确认再执行',
    });
  } else if (intentRule.intent === 'report_card_loss') {
    steps.push({ tool: 'report_card_loss', args: { cardId: t }, why: '挂失不可逆且立即中断用卡，先把后果讲清楚再确认' });
  } else if (intentRule.intent === 'gift_concierge') {
    steps.push({
      tool: 'gift_concierge',
      args: { text: t, budget: require('./giftEngine').parseBudget(t) },
      why: '先听懂对象/日期/预算/形式，缺什么就主动补问；凑齐后锁定资金并下单',
    });
  } else if (intentRule.intent === 'smalltalk') {
    steps.push({ tool: 'smalltalk', args: { text: t }, why: '寒暄不需要查数据，直接回一句有人情味的话' });
  } else if (intentRule.intent === 'undo_last_action') {
    steps.push({ tool: 'undo_last_action', args: {}, why: '先找出最近一笔可回退的操作，展示将恢复的内容再请你确认' });
  } else if (intentRule.intent === 'run_scheduled') {
    steps.push({ tool: 'run_scheduled', args: {}, why: '沙箱演示：把已到期（生日前 2 天）的预约任务立即执行' });
  } else if (intentRule.intent === 'split_aa_collect') {
    const total = nlu.parseAmount(t);
    const pm = t.match(/(\d+|[一二两三四五六七八九十])个?人|仨/);
    const people = pm ? (pm[1] ? nlu.cnToNumber(pm[1]) : 3) : null;
    const participants = [];
    for (const p of store.get().payees) {
      if (t.includes(p.nickname) || t.includes(p.name)) participants.push(p.nickname);
    }
    steps.push({
      tool: 'split_aa_collect',
      args: { total, people, participants, remark: t },
      why: '先把共同消费按人数平摊，列出待收明细再确认',
    });
  } else if (intentRule.intent === 'schedule_transfer') {
    const date = nlu.parseDate(t);
    steps.push({
      tool: 'schedule_transfer',
      args: {
        payeeText: nlu.detectPayeeKeyword(t) || '',
        amount: nlu.parseAmount(t),
        cycle: date && date.monthly ? 'monthly' : 'once',
        date: date && !date.monthly ? date.date : null,
        monthlyDay: date && date.monthly ? date.monthly : null,
        remark: t,
      },
      why: '定时转账是对未来多次扣款的授权，先确认收款人、金额与执行日期',
    });
  } else if (intentRule.intent === 'transfer_money') {
    const tail = (t.match(/(?:尾号|卡号|账号)\s*(\d{4,})/) || [])[1];
    const remarkM = t.match(/交([\u4e00-\u9fa5]{2,6})/) || t.match(/(?:备注|注明)([\u4e00-\u9fa5]{2,8})/);
    steps.push({
      tool: 'transfer_money',
      args: {
        payeeText: nlu.detectPayeeKeyword(t) || (tail ? '' : ''),
        accountHint: tail || '',
        amount: nlu.parseAmount(t),
        remark: remarkM ? remarkM[1] : (t.includes('房租') ? '房租' : ''),
      },
      why: '转账属于资金变动类高风险操作：先跑风控预检，再生成待确认单，展示收款人/金额/开户行等你确认',
    });
  } else if (intentRule.intent === 'undo_last_transfer') {
    steps.push({
      tool: 'undo_last_transfer', args: {},
      why: '撤销会反向变动资金，先把要撤销的那一笔完整展示出来再确认',
    });
  } else if (intentRule.intent === 'query_transfers') {
    steps.push({ tool: 'query_transfers', args: { limit: 10 }, why: '读取转账台账（只读）' });
  } else if (intentRule.intent === 'preview_transfer') {
    const amt = nlu.parseAmount(t);
    const payee = nlu.detectPayeeKeyword(t);
    const tail = (t.match(/(?:尾号|卡号|账号)\s*(\d{4,})/) || [])[1];
    steps.push({
      tool: 'preview_transfer',
      args: { payeeText: payee || tail || '', accountHint: tail || '', amount: amt, remark: t },
      why: '转账前先把收款人、金额、时段、黑名单、限额与余额跑一遍风控规则，把风险逐条讲清楚（不划转资金）',
    });
  } else if (intentRule.intent === 'query_balance') {
    const args = {};
    if (/信用卡/.test(t)) args.kind = 'credit';
    else if (/储蓄卡|借记卡|活期/.test(t)) args.kind = 'debit';
    steps.push({ tool: 'query_balance', args, why: '你问的是账户资金情况，先读取实时余额数据' });
    if (/几张卡|所有卡|全部卡/.test(t)) steps.push({ tool: 'query_cards', args: {}, why: '顺带确认你名下所有卡片' });
  } else if (intentRule.intent === 'query_transactions') {
    const cats = nlu.detectCategory(t);
    const range = nlu.parseTimeRange(t);
    const args = { limit: 10 };
    if (cats.length) args.category = cats[0];
    if (range) { args.from = range.from; args.to = range.to; }
    else args.limit = 10;
    if (extra.category) args.category = extra.category;
    if (extra.from) args.from = extra.from;
    if (extra.to) args.to = extra.to;
    steps.push({ tool: 'query_transactions', args, why: '按你描述的条件筛选交易流水' });
  } else if (intentRule.intent === 'query_payees') {
    steps.push({ tool: 'query_payees', args: {}, why: '读取你的常用收款人白名单' });
  } else if (intentRule.intent === 'query_cards') {
    steps.push({ tool: 'query_cards', args: {}, why: '读取名下卡片与限额状态' });
  } else if (intentRule.intent === 'query_profile') {
    steps.push({ tool: 'query_profile', args: {}, why: '读取你的账户画像与风险等级' });
  } else {
    steps.push({ tool: intentRule.tool, args: {}, why: `${intentRule.label} 需要调用对应银行工具` });
  }

  // ---- 子任务 DAG：为每一步补齐 id / dependsOn（默认串行；标了 parallel 的与上一步并行）----
  const nodes = steps.map((s, i) => ({
    id: `S${i + 1}`,
    tool: s.tool,
    args: s.args || {},
    why: s.why || '',
    parallel: Boolean(s.parallel),
    dependsOn: [],
  }));
  nodes.forEach((n, i) => {
    if (i === 0) { n.dependsOn = []; return; }
    n.dependsOn = n.parallel ? [] : [nodes[i - 1].id];
  });
  return nodes;
}

/** 把 DAG 拆成执行波次（同一波内的子任务互不依赖） */
function toWaves(plan) {
  const done = new Set();
  const waves = [];
  let guardCount = 0;
  while (done.size < plan.length && guardCount++ < 20) {
    const wave = plan.filter((n) => !done.has(n.id) && n.dependsOn.every((d) => done.has(d)));
    if (!wave.length) break;
    wave.forEach((n) => done.add(n.id));
    waves.push(wave);
  }
  return waves;
}

/** DAG 可读描述（供界面展示子任务依赖关系） */
function describeDag(plan) {
  const waves = toWaves(plan);
  return waves.map((w, i) => `第 ${i + 1} 波（${w.length} 步${w.length > 1 ? '，并行' : ''}）：` + w.map((n) => n.tool).join(' ‖ ')).join('\n');
}

/**
 * 意图匹配度（可解释的规则评分，不是凭空写的模型概率）。
 * 分值由真实解析证据推得，并把证据一并返回，界面上可逐条核对。
 */
function scoreMatch(rule, text, hits = []) {
  const t = nlu.normalize(text);
  const evidence = [];
  let score = 0.55;

  const matchedCount = hits.length || 1;
  if (matchedCount === 1) {
    score += 0.15;
    evidence.push('唯一命中该意图');
  } else {
    score -= 0.05 * Math.min(matchedCount - 1, 3);
    evidence.push(`同时命中 ${matchedCount} 类意图，按优先级取首`);
  }

  const amount = nlu.parseAmount(t);
  if (amount) { score += 0.08; evidence.push(`提取到金额 ${amount}`); }
  const cats = nlu.detectCategory(t);
  if (cats.length) { score += 0.08; evidence.push(`提取到分类「${cats.join('/')}」`); }
  const range = nlu.parseTimeRange(t);
  if (range) { score += 0.06; evidence.push(`提取到时间「${range.label}」`); }
  const date = nlu.parseDate(t);
  if (date) { score += 0.05; evidence.push(`提取到日期「${date.label}」`); }
  const payee = nlu.detectPayeeKeyword(t);
  if (payee) { score += 0.06; evidence.push(`提取到收款人线索「${payee}」`); }

  const kw = String(rule.matched || '').replace(/^\/|\/$/g, '').replace(/[\^$*+?.()|[\]{}]/g, '');
  if (kw.length >= 3) { score += 0.05; evidence.push('触发关键词较具体'); }
  else { score -= 0.05; evidence.push('触发关键词较短，存在歧义风险'); }

  score = Math.max(0.3, Math.min(0.98, score));
  return { score: Number(score.toFixed(2)), evidence };
}

/** 生成"意图识别"展示文案（分值 + 推导证据，全部来自真实解析） */
function describeIntent(rule, text, hits = []) {
  return scoreMatch(rule, text, hits);
}

function planReply(intentRule, plan) {
  const lines = plan.map((s, i) => `${i + 1}. 调用工具 ${s.tool} —— ${s.why}`);
  return lines.join('\n');
}

module.exports = { detectIntent, detectIntentAll, resolveIntent, buildPlan, toWaves, describeDag, describeIntent, scoreMatch, planReply, INTENT_RULES };
