'use strict';
/**
 * 银行工具注册表（Agent 的"手"）。
 * 每个工具声明：用途、参数、风险等级、是否需要二次确认、是否已实现。
 * 阶段1：查询类工具（余额/卡片/明细/收款人/用户画像）已实现；
 *        其余工具占位，后续阶段逐个落地（executed 时返回明确提示，不假装成功）。
 */
const store = require('../store');
const riskEngine = require('./riskEngine');
const actions = require('./actions');
const billEngine = require('./billEngine');
const nlu = require('./nlu');
const giftEngine = require('./giftEngine');
const guard = require('./securityGuard');

class ToolNotReady extends Error {
  constructor(name, phase) {
    super(`工具 ${name} 将在阶段${phase}上线`);
    this.name = 'ToolNotReady';
    this.tool = name;
    this.phase = phase;
  }
}

const money = (n) => `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const registry = new Map();

function define(def) { registry.set(def.name, def); return def; }

/* ============================== 查询类（低风险，直接执行） ============================== */
define({
  name: 'query_balance',
  label: '查询账户余额',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '查询用户名下银行卡的余额/可用额度。可按卡类型（储蓄卡/信用卡）或指定卡片筛选。',
  rationale: '余额属于客户本人可随时查看的账户信息，不涉及资金变动，按分级授权规则可直接执行，无需二次确认。',
  params: {
    type: 'object',
    properties: {
      cardId: { type: 'string', description: '卡片ID，如 CARD_D1；不传则查询全部' },
      kind: { type: 'string', enum: ['debit', 'credit', 'all'], description: 'debit=储蓄卡，credit=信用卡，all=全部' },
    },
  },
  run(args = {}) {
    const s = store.get();
    const kind = args.kind || (args.cardId ? 'all' : 'all');
    let cards = s.cards;
    if (args.cardId) cards = cards.filter((c) => c.id === args.cardId);
    else if (kind !== 'all') cards = cards.filter((c) => c.kind === kind);
    if (!cards.length) {
      return {
        ok: true,
        data: { cards: [], empty: true },
        summary: '你名下目前没有符合条件的银行卡。',
      };
    }
    const lines = cards.map((c) => c.kind === 'debit'
      ? `${c.name}（尾号${c.tail}）：余额 ${money(c.balance)}，可用 ${money(c.available)}`
      : `${c.name}（尾号${c.tail}）：可用额度 ${money(c.available)}，已用 ${money(c.usedCredit)} / 额度 ${money(c.creditLimit)}`);
    const debitTotal = s.cards.filter((c) => c.kind === 'debit').reduce((a, c) => a + c.balance, 0);
    return {
      ok: true,
      data: { cards: cards.map(store.cardSummary), debitTotal: Number(debitTotal.toFixed(2)) },
      summary: lines.join('\n'),
      ui: { focusCards: cards.map((c) => c.id), scrollTo: 'cards' },
      speak: `你名下储蓄卡余额共 ${money(debitTotal)}`,
    };
  },
});

define({
  name: 'query_cards',
  label: '查询名下卡片',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '列出用户持有的所有银行卡及其状态、限额。',
  rationale: '仅读取卡面信息与限额配置，不涉及资金变动，直接执行。',
  params: { type: 'object', properties: {} },
  run() {
    const s = store.get();
    const lines = s.cards.map((c) => `${c.name} 尾号${c.tail} · 状态${c.status === 'active' ? '正常' : c.status === 'frozen' ? '已冻结' : c.status} · 单笔限额 ${money(c.singleLimit)}`);
    return {
      ok: true,
      data: { cards: s.cards.map(store.cardSummary) },
      summary: lines.join('\n'),
      ui: { focusCards: s.cards.map((c) => c.id), scrollTo: 'cards' },
    };
  },
});

define({
  name: 'query_transactions',
  label: '查询交易明细',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '查询近期交易流水，可按时间范围、分类、金额上下限过滤。',
  rationale: '交易流水为账户只读信息，直接执行；查询范围仅限当前登录用户本人账户。',
  params: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '商户/备注关键词' },
      category: { type: 'string', description: '消费分类，如 餐饮' },
      limit: { type: 'number', description: '返回条数，默认 10' },
      from: { type: 'string', description: 'ISO 开始时间' },
      to: { type: 'string', description: 'ISO 结束时间' },
    },
  },
  run(args = {}) {
    const s = store.get();
    let list = s.transactions.slice();
    if (args.from) { const f = Date.parse(args.from); if (!isNaN(f)) list = list.filter((t) => t.timestamp >= f); }
    if (args.to) { const t2 = Date.parse(args.to); if (!isNaN(t2)) list = list.filter((t) => t.timestamp < t2); }
    if (args.category) list = list.filter((t) => t.category === args.category);
    if (args.keyword) list = list.filter((t) => (t.merchant + t.category).includes(args.keyword));
    const limit = Math.min(Number(args.limit) || 10, 50);
    const out = list.slice(0, limit);
    const total = out.filter((t) => t.direction === 'out').reduce((a, t) => a + t.amount, 0);
    const label = [args.category || null, args.from ? args.from.slice(0, 10) + ' 起' : null].filter(Boolean).join(' · ');
    return {
      ok: true,
      data: { count: list.length, shown: out, totalOut: Number(total.toFixed(2)) },
      summary: `找到 ${list.length} 笔交易，展示最近 ${out.length} 笔，其中支出合计 ${money(total)}。`,
      ui: {
        // 把本次查询结果整批推给界面，实现"Agent 查到什么，右侧就显示什么"的实时联动
        panelTxns: out.map((t) => ({ ...t })),
        panelLabel: label || '本次查询',
        highlightTxnIds: out.map((t) => t.id),
        scrollTo: 'transactions',
      },
    };
  },
});

define({
  name: 'query_payees',
  label: '查询常用收款人',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '列出用户常用收款人名单（风控白名单）。',
  rationale: '常用收款人属于风控白名单配置，只读不修改，直接执行。',
  params: { type: 'object', properties: { keyword: { type: 'string' } } },
  run(args = {}) {
    const s = store.get();
    const kw = args.keyword ? String(args.keyword).trim() : '';
    const list = kw ? s.payees.filter((p) => (p.name + p.nickname + p.bank + p.phone).includes(kw)) : s.payees;
    if (!list.length) {
      return {
        ok: true,
        data: { payees: [], empty: true, keyword: kw },
        summary: `常用收款人名单中没有匹配「${kw}」的人（当前名单共 ${s.payees.length} 人）。`,
        ui: { scrollTo: 'payees' },
      };
    }
    return {
      ok: true,
      data: { payees: list, empty: false, keyword: kw },
      summary: list.map((p) => `${p.nickname}（${p.name}）${p.bank} ${p.accountMasked}`).join('\n'),
      ui: { scrollTo: 'payees' },
    };
  },
});

define({
  name: 'query_profile',
  label: '查询用户画像与风险等级',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '查询用户的身份信息、风险测评等级（用于适当性管理）。',
  rationale: '风险等级是理财适当性管理的判断依据，属于只读画像数据，直接执行。',
  params: { type: 'object', properties: {} },
  run() {
    const s = store.get();
    return {
      ok: true,
      data: { user: s.user },
      summary: `用户：${s.user.name}；风险测评等级：${s.user.riskLevel}（${s.user.riskLevelName}），测评日期 ${s.user.riskAssessedAt}。`,
      ui: { scrollTo: 'profile' },
    };
  },
});

/* ============================== 风控预检（真实规则引擎，不划转资金） ============================== */
define({
  name: 'preview_transfer',
  label: '转账风控预检',
  category: 'security',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '在真正转账之前，先对收款人、金额、时段、账户黑名单、限额与余额做完整风控判定，并逐条说明风险原因。本工具不划转任何资金。',
  rationale: '风控预检只读取与判定，不改变任何资金，属于查询类安全能力，可直接执行。',
  params: {
    type: 'object',
    properties: {
      payeeText: { type: 'string', description: '收款人线索：姓名/昵称/手机号尾号，如 "妈" 或 "陈小雨"' },
      accountHint: { type: 'string', description: '收款账户线索（卡号/账号尾号），用于命中反诈黑名单比对' },
      amount: { type: 'number', description: '转账金额（元）' },
      remark: { type: 'string', description: '转账备注或用户的完整原话，用于高风险话术识别' },
      cardId: { type: 'string', description: '付款卡片ID，默认储蓄卡' },
    },
    required: ['amount'],
  },
  run(args = {}) {
    const ev = riskEngine.evaluateTransfer({
      payeeText: args.payeeText || '',
      accountHint: args.accountHint || '',
      amount: args.amount,
      remark: args.remark || '',
      cardId: args.cardId,
    });

    const hit = ev.rules.filter((r) => r.hit);
    const decisionLabel = { allow: '通过', confirm: '需二次确认', reject: '不可执行', block: '已拦截' }[ev.decision] || ev.decision;

    // 预检结果落库：刷新页面后仍可在界面上看到
    const s = store.get();
    s.lastPreflight = {
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      decision: ev.decision,
      decisionLabel,
      amount: ev.amount,
      payee: ev.payee,
      payeeResolution: ev.payeeResolution,
      card: ev.card,
      hitRules: hit.map((r) => ({ id: r.id, name: r.name, level: r.level, detail: r.detail })),
      allRules: ev.rules.map((r) => ({ id: r.id, name: r.name, level: r.level, hit: r.hit, detail: r.detail })),
      explain: ev.explain,
      needsSms: ev.needsSms,
      canProceed: ev.canProceed,
    };
    store.save(true);

    store.addAudit({
      action: 'preview_transfer', category: 'security', riskLevel: 'high',
      amount: ev.amount,
      result: ev.decision === 'allow' ? 'success' : ev.decision,
      detail: `风控预检判定：${decisionLabel}${hit.length ? '；命中 ' + hit.map((r) => r.id).join('/') : '；无命中'}`,
      request: `${ev.payeeResolution.query} ${ev.amount || ''}`,
      reason: '转账前风控预检（不划转资金）',
      requiresConfirm: ev.needsSms,
    });

    const summary = hit.length
      ? `判定：${decisionLabel}；命中 ${hit.length} 条规则 → ${hit.map((r) => `${r.id} ${r.name}`).join('；')}`
      : `判定：${decisionLabel}；共 ${ev.rules.length} 条规则全部通过`;

    return {
      ok: true,
      data: ev,
      summary,
      ui: { riskPanel: s.lastPreflight, scrollTo: 'cards' },
      explain: ev.explain,
    };
  },
});

/* ============================== 资金类动作（阶段 2）============================== */

/** 通用：根据风控结果组装给界面/回答的数据 */
function riskPanelFrom(ev) {
  const decisionLabel = { allow: '通过', confirm: '需二次确认', reject: '不可执行', block: '已拦截' }[ev.decision] || ev.decision;
  return {
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    decision: ev.decision, decisionLabel, amount: ev.amount,
    payee: ev.payee, payeeResolution: ev.payeeResolution, card: ev.card,
    hitRules: ev.rules.filter((r) => r.hit).map((r) => ({ id: r.id, name: r.name, level: r.level, detail: r.detail })),
    allRules: ev.rules.map((r) => ({ id: r.id, name: r.name, level: r.level, hit: r.hit, detail: r.detail })),
    explain: ev.explain, needsSms: ev.needsSms, canProceed: ev.canProceed,
  };
}

function persistPreflight(ev) {
  const s = store.get();
  s.lastPreflight = riskPanelFrom(ev);
  store.save(true);
  return s.lastPreflight;
}

define({
  name: 'transfer_money',
  label: '智能转账',
  category: 'action',
  risk: 'high',
  requiresConfirm: true,
  implemented: true,
  description: '向指定收款人转账。必须先展示收款人、金额、开户行，并等用户二次确认后才真正扣款；达到门槛还需模拟短信验证码。',
  rationale: '转账属于资金变动类高风险操作，按分级授权规则必须先出示关键信息并二次确认。',
  params: {
    type: 'object',
    properties: {
      payeeText: { type: 'string', description: '收款人线索：姓名/昵称/手机号尾号，如 "妈" 或 "李皓阳"' },
      amount: { type: 'number', description: '转账金额（元）' },
      remark: { type: 'string', description: '转账备注' },
      cardId: { type: 'string', description: '付款卡片ID，默认储蓄卡' },
    },
    required: ['amount'],
  },
  run(args = {}) {
    const ev = riskEngine.evaluateTransfer({
      payeeText: args.payeeText || '', accountHint: args.accountHint || '',
      amount: args.amount, remark: args.remark || '', cardId: args.cardId,
    });
    const panel = persistPreflight(ev);

    if (!ev.ok) {
      return { ok: true, outcome: 'need_info', data: ev, summary: '未识别到有效金额',
        ui: { riskPanel: panel }, explain: ['请告诉我具体金额，例如「给我妈转两千块交物业费」。'] };
    }
    if (ev.decision === 'block' || ev.decision === 'reject') {
      store.addAudit({
        action: 'transfer_money', category: 'action', riskLevel: 'high', amount: ev.amount,
        result: ev.decision, detail: `转账未放行（${panel.decisionLabel}）：${ev.rules.filter((r) => r.hit).map((r) => r.id).join('/')}`,
        request: `${ev.payeeResolution.query} ${ev.amount}`, reason: '风控规则拦截/拒绝，未发生资金变动', requiresConfirm: true,
      });
      return { ok: true, outcome: ev.decision === 'block' ? 'blocked' : 'rejected', data: ev,
        summary: `转账未放行：${panel.decisionLabel}（命中 ${panel.hitRules.length} 条规则）`,
        ui: { riskPanel: panel }, explain: ev.explain };
    }

    const card = ev.card;
    const { action, sandboxCode } = actions.createAction({
      type: 'transfer',
      title: `向 ${ev.payee.name}（${ev.payee.bank} ${ev.payee.accountMasked}）转账 ${money(ev.amount)}`,
      payload: { payeeId: ev.payee.id, amount: ev.amount, cardId: card.id, remark: args.remark || '' },
      riskResult: ev,
      summary: `付款卡 ${card.name}（尾号 ${card.tail}）`,
    });
    return {
      ok: true, outcome: 'pending', data: ev,
      pending: { ...action, sandboxCode, payee: ev.payee, card },
      summary: `已生成待确认转账 ${action.id}：收款人 ${ev.payee.name}｜${ev.payee.bank} ${ev.payee.accountMasked}｜金额 ${money(ev.amount)}${action.needsSms ? '（需短信验证码）' : '（点击确认即可）'}`,
      ui: { riskPanel: panel, focusCards: [card.id] },
      explain: ev.explain,
    };
  },
});

define({
  name: 'schedule_transfer',
  label: '定时转账',
  category: 'action',
  risk: 'high',
  requiresConfirm: true,
  implemented: true,
  description: '创建定时/周期转账计划（如每月某日自动转房租），创建前展示收款人、金额与执行日期并要求确认。',
  rationale: '定时转账是对未来多次扣款的授权，属于高风险操作，必须先确认。',
  params: {
    type: 'object',
    properties: {
      payeeText: { type: 'string' },
      amount: { type: 'number' },
      cycle: { type: 'string', enum: ['once', 'monthly'] },
      date: { type: 'string', description: '一次性转账日期 YYYY-MM-DD' },
      monthlyDay: { type: 'number', description: '每月几号' },
      remark: { type: 'string' },
    },
    required: ['amount'],
  },
  run(args = {}) {
    const ev = riskEngine.evaluateTransfer({ payeeText: args.payeeText || '', amount: args.amount, remark: args.remark || '', cardId: args.cardId });
    const panel = persistPreflight(ev);
    if (!ev.ok) return { ok: true, outcome: 'need_info', data: ev, summary: '未识别到有效金额', ui: { riskPanel: panel } };
    if (ev.decision === 'block' || ev.decision === 'reject') {
      return { ok: true, outcome: ev.decision === 'block' ? 'blocked' : 'rejected', data: ev,
        summary: `定时转账未放行：${panel.decisionLabel}`, ui: { riskPanel: panel }, explain: ev.explain };
    }
    const when = args.cycle === 'monthly' && args.monthlyDay ? `每月 ${args.monthlyDay} 日` : (args.date || '待确定日期');
    if (when === '待确定日期') {
      return { ok: true, outcome: 'need_info', data: ev, summary: '缺少执行日期',
        ui: { riskPanel: panel },
        explain: [`请告诉我执行时间，例如「每月 1 号给房东转 2200」或「10 月 8 号给妈妈转 1000」。`] };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'schedule',
      title: `${when} 向 ${ev.payee.name}（${ev.payee.bank} ${ev.payee.accountMasked}）转 ${money(ev.amount)}`,
      payload: { payeeId: ev.payee.id, amount: ev.amount, cardId: ev.card.id, cycle: args.cycle || 'once', date: args.date || null, monthlyDay: args.monthlyDay || null, remark: args.remark || '' },
      riskResult: ev, summary: `执行时间：${when}`,
    });
    return { ok: true, outcome: 'pending', data: ev, pending: { ...action, sandboxCode },
      summary: `已生成待确认定时转账 ${action.id}：${when} 向 ${ev.payee.name} 转 ${money(ev.amount)}`,
      ui: { riskPanel: panel }, explain: ev.explain };
  },
});

define({
  name: 'split_aa_collect',
  label: 'AA 拆分收款',
  category: 'action',
  risk: 'medium',
  requiresConfirm: true,
  implemented: true,
  description: '把一笔共同消费按人数平摊，并生成向常用收款人发起收款请求的清单。',
  rationale: 'AA 收款涉及向他人发起资金请求，需要先展示拆分明细再确认。',
  params: {
    type: 'object',
    properties: {
      total: { type: 'number', description: '总金额' },
      people: { type: 'number', description: '总人数（含自己）' },
      participants: { type: 'array', description: '参与人（常用收款人 ID 或姓名）' },
      remark: { type: 'string' },
    },
    required: ['total'],
  },
  run(args = {}) {
    const total = Number(args.total);
    const s = store.get();
    if (!(total > 0)) {
      return { ok: true, outcome: 'need_info', data: { total: null }, summary: '未识别到有效金额',
        explain: ['请告诉我总金额和参与人，例如「我们四个人吃饭花了 800，跟室友和同学 AA」。'] };
    }
    const names = Array.isArray(args.participants) ? args.participants.filter(Boolean) : [];
    const resolved = [];
    for (const n of names) {
      const r = riskEngine.resolvePayee(String(n));
      if (r.status === 'found') resolved.push(r.payee);
    }
    const uniq = resolved.filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
    if (!uniq.length) {
      return { ok: true, outcome: 'need_info', data: { total },
        summary: '缺少参与人',
        explain: [`总额 ${money(total)} 我收到了。请告诉我向哪几位收款，例如「跟室友和同学 AA」。`] };
    }
    const people = Number(args.people) > 1 ? Number(args.people) : uniq.length + 1;
    const perHead = Number((total / people).toFixed(2));
    const participants = uniq.map((p) => ({ payeeId: p.id, name: p.name, amount: perHead }));
    const { action, sandboxCode } = actions.createAction({
      type: 'aa',
      title: `AA 收款：总额 ${money(total)} / ${people} 人，每人 ${money(perHead)}`,
      payload: { total, people, perHead, participants, remark: args.remark || '' },
      riskResult: { decision: 'allow', hitRules: [] },
      summary: `待收：${participants.map((x) => `${x.name} ${money(x.amount)}`).join('、')}`,
      needsSms: false,
    });
    return { ok: true, outcome: 'pending', data: { total, people, perHead, participants, note: people !== participants.length + 1 ? `你说的是 ${people} 人，我按 ${participants.length} 位参与人拆分，剩下一位算你自己` : '' },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认 AA 收款 ${action.id}：总额 ${money(total)}，${people} 人，每人 ${money(perHead)}，待收 ${participants.length} 笔` };
  },
});

define({
  name: 'undo_last_transfer',
  label: '撤销最近一笔转账',
  category: 'action',
  risk: 'high',
  requiresConfirm: true,
  implemented: true,
  description: '撤销最近一笔当日（T+0）转账，资金原路返回。展示待撤销的那一笔明细后再确认。',
  rationale: '撤销会反向变动资金，属于高风险操作，必须先展示原交易并要求确认。',
  params: { type: 'object', properties: { transferId: { type: 'string', description: '指定要撤销的转账ID，不传则撤销最近一笔' } } },
  run(args = {}) {
    const s = store.get();
    const list = Array.isArray(s.transfers) ? s.transfers : [];
    const target = args.transferId ? list.find((t) => t.id === args.transferId) : [...list].reverse().find((t) => t.status === 'done');
    if (!target) {
      return { ok: true, outcome: 'need_info', data: { transfers: list.slice(-5).reverse() },
        summary: '没有可撤销的转账记录',
        explain: ['目前没有可撤销的转账。先完成一笔转账后就可以用「撤销最近一笔转账」原路退回。'] };
    }
    if (target.status !== 'done') {
      return { ok: true, outcome: 'rejected', data: { transfer: target },
        summary: `该笔转账状态为 ${target.status}，无法撤销`, explain: ['该笔转账已被撤销或处理过。'] };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'undo',
      title: `撤销 ${target.id}：${target.payeeName} ${money(target.amount)} 原路返回`,
      payload: { transferId: target.id, amount: target.amount },
      riskResult: { decision: Number(target.amount) >= require('../config').security.confirmThreshold ? 'confirm' : 'allow', hitRules: [] },
      summary: `原交易：${target.at} 向 ${target.payeeName} ${money(target.amount)}`,
    });
    return { ok: true, outcome: 'pending', data: { transfer: target },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认撤销 ${action.id}：${target.payeeName} ${money(target.amount)} 原路返回`,
      ui: { focusTransfers: [target.id] } };
  },
});

define({
  name: 'query_transfers',
  label: '查询转账记录',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '查询历史转账记录及其状态（成功/已撤销）。',
  rationale: '转账台账为只读信息，直接执行。',
  params: { type: 'object', properties: { limit: { type: 'number' } } },
  run(args = {}) {
    const s = store.get();
    const list = (Array.isArray(s.transfers) ? s.transfers : []).slice(-(args.limit || 10)).reverse();
    if (!list.length) return { ok: true, data: { transfers: [] }, summary: '暂无转账记录。', ui: { scrollTo: 'transfers' } };
    return {
      ok: true,
      data: { transfers: list },
      summary: list.map((t) => `${t.at} ${t.payeeName} ${money(t.amount)} [${t.status === 'done' ? '成功' : '已撤销'}]`).join('\n'),
      ui: { scrollTo: 'transfers' },
    };
  },
});

/* ============================== 账单分析（阶段 3）============================== */
define({
  name: 'analyze_bills',
  label: '账单分析',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '对真实流水做消费分类统计、环比、商户榜、消费时段分布；可指定分类与时间范围，也可生成年度报告。',
  rationale: '账单为只读数据，直接执行。',
  params: {
    type: 'object',
    properties: {
      category: { type: 'string', description: '消费分类，如 餐饮' },
      from: { type: 'string', description: 'ISO 开始时间' },
      to: { type: 'string', description: 'ISO 结束时间' },
      year: { type: 'number', description: '生成年度报告时指定年份' },
      keyword: { type: 'string', description: '商户关键词' },
    },
  },
  run(args = {}) {
    if (args.year) {
      const y = billEngine.yearlyReport(args.year);
      return {
        ok: true,
        data: { mode: 'yearly', ...y },
        summary: `${y.year} 年共支出 ${billEngine.money(y.totalOut)}，月均 ${billEngine.money(y.avgMonthly)}，最高月份 ${y.peakMonth ? y.peakMonth.month : '-'}（${billEngine.money(y.peakMonth ? y.peakMonth.out : 0)}）；支出最多的是「${y.topCategory ? y.topCategory.category : '-'}」`,
        ui: { panelBills: { mode: 'yearly', year: y.year }, scrollTo: 'bills' },
      };
    }
    const a = billEngine.analyze({ range: { from: args.from, to: args.to }, category: args.category || null, keyword: args.keyword || null });
    const scope = args.category ? `「${args.category}」` : '全部消费';
    const summary = a.outCount
      ? `${scope} 共 ${a.outCount} 笔，支出 ${billEngine.money(a.totalOut)}，笔均 ${billEngine.money(a.avgPerTxn)}${a.delta === null ? '' : `；环比上期 ${a.delta > 0 ? '+' : ''}${a.delta}%`}；TOP1 分类「${a.topCategory ? a.topCategory.category : '-'}」占 ${a.topCategory ? a.topCategory.share : 0}%`
      : `${scope} 在指定范围内没有支出记录`;
    return {
      ok: true,
      data: { mode: 'range', ...a },
      summary,
      ui: { panelBills: { mode: 'range', category: args.category || null }, scrollTo: 'bills' },
    };
  },
});

define({
  name: 'detect_anomalies',
  label: '异常交易识别',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '用评分制规则扫描全部流水，识别深夜大额、异地交易、金额突增、境外交易等异常，并给出可核对的证据。',
  rationale: '异常识别只读扫描，不改变任何数据，直接执行。',
  params: { type: 'object', properties: { limit: { type: 'number' } } },
  run(args = {}) {
    const r = billEngine.detectAnomalies({ limit: args.limit || 10 });
    return {
      ok: true,
      data: r,
      summary: `扫描 ${r.scanned} 笔支出，识别出 ${r.flagged} 笔异常${r.flagged ? `（最高风险评分 ${r.all[0].score}）` : ''}`,
      ui: { highlightAnomalyIds: r.list.map((x) => x.id), scrollTo: 'bills' },
    };
  },
});

/* ============================== 订阅 / 代扣（阶段 3）============================== */
define({
  name: 'list_subscriptions',
  label: '订阅与代扣查询',
  category: 'query',
  risk: 'low',
  requiresConfirm: false,
  implemented: true,
  description: '列出已登记订阅，并从真实流水中自动识别周期性扣费；给出续费倒计时与提前提醒。',
  rationale: '订阅与周期扣费均为只读信息，直接执行。',
  params: { type: 'object', properties: { soonDays: { type: 'number', description: '几天内视为即将扣费，默认 7' } } },
  run(args = {}) {
    const s = billEngine.subscriptions({ soonDays: Number(args.soonDays) || 7 });
    const active = s.items.filter((x) => x.status === 'active');
    return {
      ok: true,
      data: s,
      summary: `共 ${s.items.length} 个订阅（活跃 ${s.activeCount} 个），每月合计 ${billEngine.money(s.monthlyTotal)}，每年合计 ${billEngine.money(s.yearlyTotal)}；其中 ${s.detectedCount} 个是从流水中自动识别出的周期性扣费${s.upcoming.length ? `；${s.soonDays} 天内即将扣费：${s.upcoming.map((u) => `${u.merchant}(+${u.daysLeft}天)`).join('、')}` : ''}`,
      ui: { panelSubscriptions: true, scrollTo: 'bills' },
    };
  },
});

define({
  name: 'cancel_subscription',
  label: '取消订阅',
  category: 'action',
  risk: 'high',
  requiresConfirm: true,
  implemented: true,
  description: '取消指定的自动续费订阅。先展示订阅明细（商户/金额/周期/下次扣费日）并要求二次确认。',
  rationale: '取消订阅会改变后续扣费行为，属于需要确认的操作。',
  params: {
    type: 'object',
    properties: {
      subscriptionId: { type: 'string', description: '订阅ID，如 S4' },
      merchant: { type: 'string', description: '商户名（可用于模糊定位）' },
      hint: { type: 'string', description: '用户原话（用于"那个老扣我钱的会员"这类模糊表述）' },
    },
  },
  run(args = {}) {
    const s = store.get();
    const active = s.subscriptions.filter((x) => (x.status || 'active') === 'active');
    const subsOverview = billEngine.subscriptions();
    let target = args.subscriptionId ? s.subscriptions.find((x) => x.id === args.subscriptionId) : null;
    let basis = args.subscriptionId ? '按订阅ID' : null;

    // 1) 直接点名商户
    if (!target && args.merchant) {
      const q = String(args.merchant).trim();
      if (q) {
        target = active.find((x) => x.merchant.includes(q) || q.includes(x.merchant)) || null;
        if (target) basis = `按商户名「${q}」`;
      }
    }
    // 2) 关键词映射（视频/音乐/相册/PLUS…）
    if (!target) {
      const text = String(args.hint || args.merchant || '');
      const kwMap = [['视频', '腾讯视频'], ['音乐', '网易云'], ['相册', '轻拍'], ['云盘', '轻拍'], ['PLUS', '京东'], ['京东', '京东']];
      for (const [kw, name] of kwMap) {
        if (text.includes(kw)) {
          const hit = active.find((x) => x.merchant.includes(name));
          if (hit) { target = hit; basis = `按关键词「${kw}」`; break; }
        }
      }
    }
    // 3) "那个老扣我钱的会员" → 按累计扣费最多定位，并说明依据
    if (!target && /老扣|总扣|一直扣|老牌|最贵|最多的/.test(String(args.hint || ''))) {
      const ranked = subsOverview.items
        .filter((x) => x.status === 'active')
        .map((x) => ({ item: x, paid: (x.yearlyCost || 0) * 0 + (subsOverview.detected.find((d) => d.merchant === x.merchant) || {}).totalPaid || 0 }))
        .sort((a, b) => b.paid - a.paid);
      if (ranked.length && ranked[0].paid > 0) {
        target = s.subscriptions.find((x) => x.id === ranked[0].item.id) || null;
        basis = `你只说了"老扣我钱的"，我按近期累计扣费最多定位到「${ranked[0].item.merchant}」（累计 ${billEngine.money(ranked[0].paid)}）`;
      }
    }
    // 4) 仍无法定位 → 反问，不瞎猜
    if (!target) {
      const cand = subsOverview.items.filter((x) => x.status === 'active');
      return {
        ok: true, outcome: 'need_info', data: { items: cand },
        summary: '没有定位到要取消的订阅',
        explain: [`请告诉我要取消哪一个，当前活跃订阅有：${cand.map((x) => `${x.merchant}（${billEngine.money(x.amount)}/${x.cycleLabel}）`).join('；')}`],
        ui: { panelSubscriptions: true, scrollTo: 'bills' },
      };
    }
    if ((target.status || 'active') !== 'active') {
      return { ok: true, outcome: 'rejected', data: { subscription: target }, summary: `该订阅已是「${target.status}」状态`, explain: [`「${target.merchant}」当前状态为 ${target.status}，无需重复取消。`] };
    }

    const { action, sandboxCode } = actions.createAction({
      type: 'subscription_cancel',
      title: `取消订阅：${target.merchant}（${billEngine.money(target.amount)}/${target.cycle === 'monthly' ? '月' : '年'}）`,
      payload: { subscriptionId: target.id, amount: target.amount },
      riskResult: { decision: 'allow', hitRules: [] },
      summary: `${basis ? basis + '；' : ''}下次计划扣费日 ${target.nextChargeDate}；取消后不会再自动扣费`,
      needsSms: false,
    });
    return {
      ok: true, outcome: 'pending', data: { subscription: target, basis },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认取消 ${action.id}：${target.merchant}（${billEngine.money(target.amount)}/${target.cycle === 'monthly' ? '月' : '年'}，原定 ${target.nextChargeDate} 扣费）`,
      ui: { panelSubscriptions: true, scrollTo: 'bills' },
    };
  },
});

const wealthEngine = require('./wealthEngine');
/** 按 ID / 卡号尾号 / 名称关键词定位卡片 */
function resolveCard(text) {
  const s = store.get();
  const t = String(text || '').trim();
  if (!t) return s.cards.find((c) => c.kind === 'debit') || s.cards[0] || null;
  let hit = s.cards.find((c) => c.id === t);
  if (hit) return hit;
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 4) { hit = s.cards.find((c) => c.tail === digits.slice(-4)); if (hit) return hit; }
  if (/白金/.test(t)) return s.cards.find((c) => c.level.includes('白金')) || null;
  if (/金卡/.test(t)) return s.cards.find((c) => c.level === '金卡') || null;
  if (/储蓄卡|借记卡/.test(t)) return s.cards.find((c) => c.kind === 'debit') || null;
  if (/信用卡/.test(t)) return s.cards.find((c) => c.kind === 'credit') || null;
  return null;
}

/** 按 ID / 名称 / 代码定位产品 */
function resolveProduct(text) {
  const s = store.get();
  const t = String(text || '').trim();
  if (!t) return null;
  let hit = s.products.find((p) => p.id === t || p.code === t.toUpperCase() || p.name === t);
  if (hit) return hit;
  hit = s.products.find((p) => t.includes(p.name) || p.name.includes(t) || t.includes(p.code));
  if (hit) return hit;
  const kw = [['货币', 'YLMMF'], ['现金宝', 'YLMMF'], ['固收', 'YLFIX90'], ['稳健添利', 'YLFIX90'], ['存单', 'YLCD36'], ['安心存', 'YLCD36'], ['混合', 'YLBLD'], ['均衡', 'YLBLD'], ['股票', 'YLGROW'], ['成长', 'YLGROW'], ['权益', 'YLADV'], ['进取', 'YLADV']];
  for (const [k, code] of kw) if (t.includes(k)) return s.products.find((p) => p.code === code) || null;
  return null;
}

/* ============================== 理财（阶段 4）============================== */
define({
  name: 'assess_risk', label: '风险测评', category: 'wealth', risk: 'low', requiresConfirm: false, implemented: true,
  description: '开展风险承受能力测评（5 题问卷）。不传答案时返回问卷；传答案后计算等级并写回用户画像。',
  rationale: '风险测评是适当性管理的前置条件，只影响用户画像，不涉及资金，直接执行。',
  params: { type: 'object', properties: { answers: { type: 'string', description: '答案，如 "BCBCB" 或 "1B 2C 3B 4C 5B"' } } },
  run(args = {}) {
    if (!args.answers) {
      return {
        ok: true, outcome: 'need_info', data: { questionnaire: wealthEngine.QUESTIONNAIRE },
        summary: '已准备 5 题风险测评问卷',
        explain: ['请依次回答 5 道题（选项 A–E），例如直接回复：BCBCB。'],
      };
    }
    const r = wealthEngine.assess(args.answers);
    if (!r.ok) {
      return {
        ok: true, outcome: 'need_info', data: { questionnaire: wealthEngine.QUESTIONNAIRE, answered: r.answered },
        summary: `答案不完整（已识别 ${r.answered}/5 题）`,
        explain: ['请把 5 题的选项都告诉我，例如：BCBCB。'],
      };
    }
    const user = wealthEngine.saveAssessment(r);
    const rec = wealthEngine.recommend();
    return {
      ok: true, data: { result: r, user, suitableCount: rec.suitableCount, blockedCount: rec.blockedCount },
      summary: `测评完成：得分 ${r.total}/${r.max} → ${r.level}（${r.levelName}）；可推荐产品 ${rec.suitableCount} 款，超等级屏蔽 ${rec.blockedCount} 款`,
      ui: { scrollTo: 'wealth' },
    };
  },
});

define({
  name: 'recommend_products', label: '理财产品推荐与对比', category: 'wealth', risk: 'low', requiresConfirm: false, implemented: true,
  description: '按用户风险等级做适当性过滤后推荐与对比理财产品；不匹配的产品会被屏蔽并说明原因。',
  rationale: '推荐为只读分析，不涉及资金，直接执行。',
  params: { type: 'object', properties: {} },
  run() {
    const r = wealthEngine.recommend();
    return {
      ok: true, data: r,
      summary: `你的风险等级 ${r.user.riskLevel}（${r.user.riskLevelName}）：可推荐 ${r.suitableCount} 款，${r.blockedCount} 款因超等级被屏蔽${r.assessment.valid ? '' : `；注意：${r.assessment.message}`}`,
      ui: { scrollTo: 'wealth', panelWealth: true },
    };
  },
});

define({
  name: 'query_holdings', label: '查询我的持仓', category: 'wealth', risk: 'low', requiresConfirm: false, implemented: true,
  description: '查询理财持仓、持仓天数与估算收益。',
  rationale: '持仓为只读信息，直接执行。',
  params: { type: 'object', properties: {} },
  run() {
    const p = wealthEngine.portfolio();
    return {
      ok: true, data: p,
      summary: p.count ? `共 ${p.count} 笔持仓，投入 ${wealthEngine.money(p.totalAmount)}，估算收益 ${wealthEngine.money(p.totalReturn)}，当前估值 ${wealthEngine.money(p.totalValue)}` : '你当前没有理财持仓。',
      ui: { scrollTo: 'wealth', panelWealth: true },
    };
  },
});

define({
  name: 'purchase_product', label: '理财产品申购', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '申购理财产品。先做适当性与起购金额校验，不匹配直接拒绝；匹配则展示关键信息并要求二次确认（含风险提示朗读）。',
  rationale: '理财申购属于资金变动类高风险操作，必须先过适当性校验并二次确认。',
  params: {
    type: 'object',
    properties: {
      productId: { type: 'string' }, productName: { type: 'string' },
      amount: { type: 'number' }, cardId: { type: 'string' },
    },
    required: ['amount'],
  },
  run(args = {}) {
    const s = store.get();
    const product = resolveProduct(args.productId || args.productName || '');
    const amount = Number(args.amount);
    if (!product) {
      return { ok: true, outcome: 'need_info', data: { products: s.products }, summary: '没有定位到要申购的产品',
        explain: ['请告诉我要买哪一款，例如「拿一万块买稳健添利固收」或「申购现金宝 5000」。'], ui: { scrollTo: 'wealth' } };
    }
    if (!(amount > 0)) {
      return { ok: true, outcome: 'need_info', data: { product }, summary: '未识别到有效申购金额',
        explain: [`请告诉我申购金额，例如「拿一万块买${product.name}」。`] };
    }

    // 门 1：测评有效性
    const st = wealthEngine.assessmentStatus(s.user);
    if (!st.valid) {
      return { ok: true, outcome: 'rejected', data: { product, assessment: st }, summary: `风险测评不可用：${st.message}`,
        explain: [`${st.message}，按监管要求需先完成风险测评后才能购买理财产品。说一句「帮我做风险测评」即可开始。`], ui: { scrollTo: 'wealth' } };
    }
    // 门 2：适当性
    if (!wealthEngine.isSuitable(s.user.riskLevel, product)) {
      store.addAudit({ action: 'purchase_product', category: 'wealth', riskLevel: 'high', amount: null, result: 'rejected',
        detail: `适当性拦截：${product.name}（${product.riskLevel}）超出用户等级 ${s.user.riskLevel}`, request: `${product.name} ${amount}`, reason: '风险等级不匹配，禁止推荐与申购', requiresConfirm: true });
      return { ok: true, outcome: 'rejected', data: { product, user: s.user }, summary: `适当性拦截：${product.name}（${product.riskLevel} ${product.riskName}）超出你的风险等级 ${s.user.riskLevel}`,
        explain: [`${product.name} 的风险等级为 ${product.riskLevel}（${product.riskName}），高于你的风险承受能力 ${s.user.riskLevel}（${s.user.riskLevelName}）。`, '按适当性管理规定，我不能向你推荐或办理这款产品。'],
        ui: { scrollTo: 'wealth' } };
    }
    // 门 3：起购金额与余额
    if (amount < Number(product.minAmount)) {
      return { ok: true, outcome: 'rejected', data: { product }, summary: `低于起购金额 ${wealthEngine.money(product.minAmount)}`,
        explain: [`${product.name} 的起购金额为 ${wealthEngine.money(product.minAmount)}，本次 ${wealthEngine.money(amount)} 不满足。`] };
    }
    const card = resolveCard(args.cardId) || s.cards.find((c) => c.kind === 'debit');
    if (Number(card.available) < amount) {
      return { ok: true, outcome: 'rejected', data: { product, card }, summary: `可用余额不足（可用 ${wealthEngine.money(card.available)}）`,
        explain: [`${card.name}（尾号 ${card.tail}）可用 ${wealthEngine.money(card.available)}，本次需 ${wealthEngine.money(amount)}，还差 ${wealthEngine.money(amount - card.available)}。`] };
    }

    const disclosure = `您正在申购${product.name}，风险等级${product.riskLevel}${product.riskName}，业绩比较基准${product.expectedReturn}%/年，期限${product.term}。理财非存款，产品有风险，投资须谨慎，不保证本金和收益。`;
    const { action, sandboxCode } = actions.createAction({
      type: 'product_purchase',
      title: `申购 ${product.name}（${product.riskLevel}）${wealthEngine.money(amount)}`,
      payload: { productId: product.id, amount, cardId: card.id, riskDisclosure: disclosure },
      riskResult: { decision: amount >= 5000 ? 'confirm' : 'allow', hitRules: [] },
      summary: `扣款卡 ${card.name}（尾号 ${card.tail}）；业绩比较基准 ${product.expectedReturn}%/年，期限 ${product.term}`,
    });
    return {
      ok: true, outcome: 'pending', data: { product, card, user: s.user, disclosure },
      pending: { ...action, sandboxCode, riskDisclosure: disclosure },
      summary: `已生成待确认申购 ${action.id}：${product.name} ${wealthEngine.money(amount)}${action.needsSms ? '（需短信验证码）' : '（点击确认即可）'}`,
      ui: { scrollTo: 'wealth' },
    };
  },
});

define({
  name: 'redeem_product', label: '理财产品赎回', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '赎回理财持仓。展示持仓与赎回金额后二次确认；沙箱按 T+0 到账（真实环境 T+1）。',
  rationale: '赎回引发资金回笼，属于需确认的操作。',
  params: { type: 'object', properties: { holdingId: { type: 'string' }, productName: { type: 'string' }, amount: { type: 'number' }, all: { type: 'boolean' } } },
  run(args = {}) {
    const p = wealthEngine.portfolio();
    if (!p.count) {
      return { ok: true, outcome: 'need_info', data: p, summary: '你当前没有理财持仓',
        explain: ['你还没有持仓，先说「有哪些理财可以买」挑一款试试。'], ui: { scrollTo: 'wealth' } };
    }
    let holding = args.holdingId ? p.holdings.find((h) => h.id === args.holdingId) : null;
    if (!holding && args.productName) holding = p.holdings.find((h) => h.name.includes(String(args.productName)));
    if (!holding) holding = p.holdings.filter((h) => h.status === 'holding').sort((a, b) => b.amount - a.amount)[0] || null;
    if (!holding) return { ok: true, outcome: 'need_info', data: p, summary: '没有可赎回的持仓', explain: ['当前没有处于持有中的持仓。'] };
    const amount = args.all || !(Number(args.amount) > 0) ? holding.amount : Number(args.amount);
    if (amount > holding.amount) {
      return { ok: true, outcome: 'rejected', data: { holding }, summary: `赎回金额超过持仓 ${wealthEngine.money(holding.amount)}`,
        explain: [`你在 ${holding.name} 的持仓为 ${wealthEngine.money(holding.amount)}，无法赎回 ${wealthEngine.money(amount)}。`] };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'product_redeem',
      title: `赎回 ${holding.name} ${wealthEngine.money(amount)}`,
      payload: { holdingId: holding.id, amount },
      riskResult: { decision: amount >= 5000 ? 'confirm' : 'allow', hitRules: [] },
      summary: `当前持有 ${wealthEngine.money(holding.amount)}，赎回后剩余 ${wealthEngine.money(holding.amount - amount)}；沙箱按 T+0 到账（真实环境 T+1）`,
    });
    return {
      ok: true, outcome: 'pending', data: { holding, amount }, pending: { ...action, sandboxCode },
      summary: `已生成待确认赎回 ${action.id}：${holding.name} ${wealthEngine.money(amount)}${action.needsSms ? '（需短信验证码）' : ''}`,
      ui: { scrollTo: 'wealth' },
    };
  },
});

/* ============================== 卡片管理（阶段 4）============================== */
define({
  name: 'apply_card', label: '卡片申请', category: 'action', risk: 'medium', requiresConfirm: true, implemented: true,
  description: '申请新卡（信用卡/储蓄卡）。展示卡种与说明后确认，生成受理单。',
  rationale: '提交办卡申请会产生征信查询等后果，需用户确认。',
  params: { type: 'object', properties: { cardType: { type: 'string' } } },
  run(args = {}) {
    const t = String(args.cardType || '').trim();
    const isVirtual = /虚拟/.test(t);
    if (isVirtual) {
      const { action, sandboxCode } = actions.createAction({
        type: 'virtual_card', toolName: 'apply_card',
        title: '开通银枢虚拟卡（线上支付用，额度 ¥5,000）',
        payload: { virtual: true },
        summary: '黄色操作：即时发卡，单笔限额 ¥2,000 / 日累计 ¥5,000，可随时冻结',
        riskResult: { decision: 'allow', hitRules: [] },
      });
      return {
        ok: true, outcome: 'pending', data: { cardType: '虚拟卡' },
        pending: { ...action, sandboxCode },
        summary: `已生成待确认开通 ${action.id}：银枢虚拟卡`,
        ui: { scrollTo: 'cards' },
      };
    }
    const name = /白金/.test(t) ? '信用卡·白金卡' : (/金卡/.test(t) ? '信用卡·金卡' : (/储蓄|借记/.test(t) ? '储蓄卡·金葵花' : ''));
    if (!name) {
      return { ok: true, outcome: 'need_info', data: {}, summary: '需要确认卡种',
        explain: ['你想办哪种卡？可选：**虚拟卡**（即时开通，推荐演示）/ 信用卡·金卡 / 信用卡·白金卡 / 储蓄卡·金葵花。'], ui: { scrollTo: 'cards' } };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'card_apply', title: `申请 ${name}`, payload: { cardType: name, level: name.split('·')[1] || '' },
      riskResult: { decision: 'allow', hitRules: [] }, needsSms: false,
      summary: '受理后预计 1–3 个工作日出审核结果',
    });
    return { ok: true, outcome: 'pending', data: { cardType: name }, pending: { ...action, sandboxCode },
      summary: `已生成待确认申请 ${action.id}：${name}`, ui: { scrollTo: 'cards' } };
  },
});

define({
  name: 'adjust_credit_limit', label: '额度调整', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '申请提升/降低信用卡额度。展示当前额度与目标额度后确认。',
  rationale: '额度调整影响信用风险敏口，需确认。',
  params: { type: 'object', properties: { cardId: { type: 'string' }, newLimit: { type: 'number' }, delta: { type: 'number' } } },
  run(args = {}) {
    const card = resolveCard(args.cardId);
    if (!card) return { ok: true, outcome: 'need_info', data: {}, summary: '未定位到卡片', explain: ['请告诉我要调整哪张卡的额度，例如「把白金卡额度提到 10 万」。'] };
    if (card.kind !== 'credit') return { ok: true, outcome: 'rejected', data: { card }, summary: '储蓄卡没有信用额度', explain: [`${card.name} 是储蓄卡，不存在信用额度调整。`] };
    const target = args.newLimit ? Number(args.newLimit) : Number(card.creditLimit) + Number(args.delta || 0);
    if (!(target > 0)) return { ok: true, outcome: 'need_info', data: { card }, summary: '需要明确目标额度', explain: [`${card.name} 当前额度 ${wealthEngine.money(card.creditLimit)}（已用 ${wealthEngine.money(card.usedCredit)}），请告诉我目标额度。`] };
    if (target >= 200000) return { ok: true, outcome: 'rejected', data: { card }, summary: '超过单卡额度上限 ¥200,000', explain: ['单卡额度上限为 ¥200,000，如需更高请到柜面申请。'] };
    if (target < Number(card.usedCredit || 0)) return { ok: true, outcome: 'rejected', data: { card }, summary: '新额度低于已用额度', explain: [`已用 ${wealthEngine.money(card.usedCredit)}，新额度不能低于已用额度。`] };
    const { action, sandboxCode } = actions.createAction({
      type: 'limit_adjust',
      title: `${target > card.creditLimit ? '提额' : '降额'}：${card.name}（尾号 ${card.tail}）${wealthEngine.money(card.creditLimit)} → ${wealthEngine.money(target)}`,
      payload: { cardId: card.id, newLimit: target },
      riskResult: { decision: target - card.creditLimit >= 50000 ? 'confirm' : 'allow', hitRules: [] },
      summary: `当前已用 ${wealthEngine.money(card.usedCredit)}，调整后可用 ${wealthEngine.money(target - card.usedCredit)}`,
    });
    return { ok: true, outcome: 'pending', data: { card, target }, pending: { ...action, sandboxCode },
      summary: `已生成待确认额度调整 ${action.id}：${card.name} → ${wealthEngine.money(target)}`, ui: { scrollTo: 'cards' } };
  },
});

define({
  name: 'set_card_limit', label: '交易限额 / 冻结解锁', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '设置卡片单笔/日累计限额，或限制交易（冻结）与解冻。',
  rationale: '限额与冻结直接影响卡片可用性，需确认。',
  params: { type: 'object', properties: { cardId: { type: 'string' }, singleLimit: { type: 'number' }, dailyLimit: { type: 'number' }, action: { type: 'string', enum: ['limit', 'freeze', 'unfreeze'] }, reason: { type: 'string' } } },
  run(args = {}) {
    const card = resolveCard(args.cardId);
    if (!card) return { ok: true, outcome: 'need_info', data: {}, summary: '未定位到卡片', explain: ['请告诉我要操作哪张卡，例如「把信用卡单笔限额降到 5000」。'] };
    const mode = args.action || 'limit';
    if (mode === 'freeze') {
      if (card.status === 'frozen') return { ok: true, outcome: 'rejected', data: { card }, summary: '该卡已是冻结状态', explain: [`${card.name}（尾号 ${card.tail}）当前已冻结。`] };
      const { action, sandboxCode } = actions.createAction({ type: 'card_lock', title: `限制交易：${card.name}（尾号 ${card.tail}）`, payload: { cardId: card.id, action: 'freeze', reason: args.reason || '用户主动限制交易' }, riskResult: { decision: 'allow', hitRules: [] }, needsSms: false, summary: '冻结后该卡无法发生任何支出，可随时解冻' });
      return { ok: true, outcome: 'pending', data: { card }, pending: { ...action, sandboxCode }, summary: `已生成待确认冻结 ${action.id}：${card.name}（尾号 ${card.tail}）` };
    }
    if (mode === 'unfreeze') {
      if (card.lost) return { ok: true, outcome: 'rejected', data: { card }, summary: '挂失卡不能自助解冻', explain: ['该卡已办理挂失，需到柜面补卡后才能恢复使用。'] };
      if (card.status !== 'frozen') return { ok: true, outcome: 'rejected', data: { card }, summary: '该卡状态正常', explain: [`${card.name}（尾号 ${card.tail}）当前状态正常，无需解冻。`] };
      const { action, sandboxCode } = actions.createAction({ type: 'card_lock', title: `解冻：${card.name}（尾号 ${card.tail}）`, payload: { cardId: card.id, action: 'unfreeze' }, riskResult: { decision: 'allow', hitRules: [] }, needsSms: false, summary: '解冻后该卡恢复正常交易' });
      return { ok: true, outcome: 'pending', data: { card }, pending: { ...action, sandboxCode }, summary: `已生成待确认解冻 ${action.id}：${card.name}（尾号 ${card.tail}）` };
    }
    if (!(Number(args.singleLimit) > 0) && !(Number(args.dailyLimit) > 0)) {
      return { ok: true, outcome: 'need_info', data: { card }, summary: '需要明确限额数值', explain: [`${card.name}（尾号 ${card.tail}）当前单笔限额 ${wealthEngine.money(card.singleLimit)}、日累计 ${wealthEngine.money(card.dailyLimit)}；请告诉我要改成多少。`] };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'card_limit',
      title: `调整限额：${card.name}（尾号 ${card.tail}）单笔 ${args.singleLimit ? wealthEngine.money(args.singleLimit) : '不变'} / 日累计 ${args.dailyLimit ? wealthEngine.money(args.dailyLimit) : '不变'}`,
      payload: { cardId: card.id, singleLimit: args.singleLimit || null, dailyLimit: args.dailyLimit || null },
      riskResult: { decision: 'allow', hitRules: [] }, needsSms: false,
      summary: `当前单笔 ${wealthEngine.money(card.singleLimit)}、日累计 ${wealthEngine.money(card.dailyLimit)}`,
    });
    return { ok: true, outcome: 'pending', data: { card }, pending: { ...action, sandboxCode }, summary: `已生成待确认限额调整 ${action.id}` };
  },
});

define({
  name: 'report_card_loss', label: '卡片挂失', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '办理卡片挂失：确认后卡片立即冻结并返回挂失回执（不可撤销）。',
  rationale: '挂失不可逆且会立即中断卡片使用，必须先告知后果再确认。',
  params: { type: 'object', properties: { cardId: { type: 'string' } } },
  run(args = {}) {
    const card = resolveCard(args.cardId);
    if (!card) return { ok: true, outcome: 'need_info', data: { cards: store.get().cards.map(store.cardSummary) }, summary: '未定位到要挂失的卡', explain: ['请告诉我要挂失哪张卡，例如「白金卡丢了，先挂失」。'] };
    if (card.lost) return { ok: true, outcome: 'rejected', data: { card }, summary: '该卡已挂失', explain: [`${card.name}（尾号 ${card.tail}）已于 ${card.lostAt} 办理挂失。`] };
    const { action, sandboxCode } = actions.createAction({
      type: 'card_loss',
      title: `挂失 ${card.name}（尾号 ${card.tail}）`,
      payload: { cardId: card.id },
      riskResult: { decision: 'confirm', hitRules: [] },
      summary: '确认后卡片立即冻结且不可撤销；补卡将寄送至预留地址；卡内未出账单仍需还款',
    });
    return { ok: true, outcome: 'pending', data: { card }, pending: { ...action, sandboxCode },
      summary: `已生成待确认挂失 ${action.id}：${card.name}（尾号 ${card.tail}），需短信验证码`,
      ui: { focusCards: [card.id], scrollTo: 'cards' } };
  },
});

/* ============================== 占位工具（后续阶段实现） ============================== */
const PLACEHOLDERS = [];

for (const [name, label, phase, risk, requiresConfirm] of PLACEHOLDERS) {
  define({
    name, label, category: 'action', risk, requiresConfirm, implemented: false, phase,
    description: `${label}（阶段 ${phase} 上线）`,
    params: { type: 'object', properties: {} },
    run() { throw new ToolNotReady(name, phase); },
  });
}

/* ============================== 跨场景联动（阶段 5）============================== */
define({
  name: 'gift_concierge', label: '跨场景联动（生日/节日安排）', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '把"下周我妈生日"这类一句话诉求拆成完整安排：识别对象与日期 → 主动补问预算与偏好 → 在预算内选方案 → 锁定资金 → 下单鲜花/蛋糕 → 生成配送提醒。',
  rationale: '跨场景联动会产生真实扣款与商户下单，必须先锁定资金并二次确认。',
  params: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '用户原话' },
      budget: { type: 'number', description: '预算（元）' },
      wants: { type: 'string', enum: ['flower', 'cake', 'both'] },
    },
  },
  run(args = {}) {
    const s = store.get();
    const g = giftEngine;
    const text = String(args.text || '').trim();
    const existing = s.giftDraft && s.giftDraft.stage === 'asking'
      && (!s.giftDraft.ts || (Date.now() - s.giftDraft.ts) < 10 * 60 * 1000)
      ? s.giftDraft : null;

    const recipient = g.detectRecipient(text);
    const occasion = existing ? existing.occasion : g.detectOccasion(text);
    const budgetIn = Number(args.budget) > 0 ? Number(args.budget) : g.parseBudget(text);
    const wantsIn = args.wants || g.detectWants(text);
    const dateIn = nlu.parseDate(text);

    const today = new Date('2026-09-22T12:00:00+08:00');
    const p = (n) => String(n).padStart(2, '0');
    const draft = existing
      ? { ...existing }
      : { id: `GD${p(1)}${Date.now().toString().slice(-5)}`, createdAt: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`, stage: 'asking', ts: Date.now() };
    draft.ts = Date.now();

    if (recipient.label !== '家人') { draft.recipient = recipient.label; draft.recipientName = recipient.name; }
    if (!draft.recipient) { draft.recipient = '家人'; draft.recipientName = '王丽华'; }
    draft.occasion = occasion;
    if (dateIn && dateIn.date) { draft.date = dateIn.date; draft.dateLabel = dateIn.label; }
    if (budgetIn) draft.budget = Number(budgetIn);
    if (wantsIn) draft.wants = wantsIn;
    if (/下周|下个?星期/.test(text) && !draft.date) draft.dateHint = '下周（待确认具体哪一天）';
    s.giftDraft = draft;
    store.save(true);

    const known = [
      draft.occasion ? `场合：${draft.occasion}` : null,
      draft.recipient ? `对象：${draft.recipient}${draft.recipientName && draft.recipientName !== '—' ? `（${draft.recipientName}）` : ''}` : null,
      draft.date ? `日期：${draft.date}（${draft.dateLabel}）` : null,
      draft.budget ? `预算：${g.money(draft.budget)}` : null,
      draft.wants ? `形式：${{ flower: '只送鲜花', cake: '只送蛋糕', both: '鲜花 + 蛋糕' }[draft.wants]}` : null,
    ].filter(Boolean);

    // 统一补问：一次把缺的信息问全（不拆成多轮骚扰用户）
    const missing = [];
    if (!draft.date) missing.push('**具体哪一天**（例如「下周三」或「9 月 30 日」）');
    if (!(Number(draft.budget) > 0)) missing.push('**预算**大概多少');
    if (!draft.wants) missing.push('想送**鲜花、蛋糕，还是都要**');
    if (missing.length) {
      return {
        ok: true, outcome: 'need_info', data: { draft },
        summary: `已识别${known.slice(0, 2).join('、')}，还缺 ${missing.length} 项信息`,
        explain: [
          `好的，${draft.occasion}安排我来做。已经记下了：${known.join('，') || '（待补充）'}。`,
          `还需要你告诉我：${missing.join('、')}。`,
        ],
        ui: { panelGift: true, scrollTo: 'cards' },
      };
    }

    const plan = g.planGift(draft.budget, draft.wants);
    if (!plan.ok) {
      return { ok: true, outcome: 'need_info', data: { draft, plan },
        summary: '预算不足以覆盖所选形式',
        explain: [`预算 ${g.money(draft.budget)} 不够：按「${{ flower: '只送鲜花', cake: '只送蛋糕', both: '鲜花+蛋糕' }[draft.wants]}」最低需要 ${g.money(plan.cheapest)}。`, '可以把预算提高一点，或者改成只送鲜花？'] };
    }
    const delivery = g.deliveryPlan(draft.date, today);
    if (!delivery.feasible) {
      return { ok: true, outcome: 'need_info', data: { draft, delivery },
        summary: '日期过近，无法按时送达',
        explain: [delivery.note, '请换一个稍晚一点的日期，或改为快递寄送。'] };
    }
    const card = s.cards.find((c) => c.kind === 'debit');
    if (Number(card.available) < draft.budget) {
      return { ok: true, outcome: 'rejected', data: { draft, card },
        summary: `可用余额不足（可用 ${g.money(card.available)}，预算 ${g.money(draft.budget)}）`,
        explain: [`${card.name}（尾号 ${card.tail}）当前可用 ${g.money(card.available)}，低于预算 ${g.money(draft.budget)}，可以把预算调低或先赎回理财。`] };
    }

    const itemNames = plan.items.map((it) => `${it.name} ${g.money(it.price)}`).join('；');
    const eventDate = draft.date;
    const executeAt = new Date(new Date(eventDate + 'T09:00:00+08:00').getTime() - 2 * 86400000).toISOString().slice(0, 10); // 生日前 2 天订购
    const { action, sandboxCode } = actions.createAction({
      type: 'gift_lock',
      title: `${draft.occasion}安排：锁定 ${g.money(draft.budget)} 并预约 ${executeAt} 下单（${draft.recipient}）`,
      payload: {
        draftId: draft.id, budget: draft.budget, items: plan.items, total: plan.total, leftover: plan.leftover,
        eventDate, executeAt, deliveryWindow: delivery.window,
        recipient: draft.recipient, recipientName: draft.recipientName, occasion: draft.occasion, cardId: card.id,
      },
      riskResult: { decision: draft.budget >= 5000 ? 'confirm' : 'allow', hitRules: [] },
      summary: `当月锁定 ${g.money(draft.budget)} 活期资金 → ${executeAt}（${eventDate} 生日前 2 天）自动下单 ${g.money(plan.total)} → 释放剩余 ${g.money(plan.leftover)}；送达 ${eventDate} ${delivery.window}`,
      needsSms: draft.budget >= 5000,
    });

    return {
      ok: true, outcome: 'pending',
      data: { draft, plan, delivery, card },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认安排 ${action.id}：${draft.recipient} ${draft.occasion}，锁定 ${g.money(draft.budget)}，预约 ${executeAt} 下单（${plan.items.map((it) => it.name).join(' + ')} 共 ${g.money(plan.total)}）`,
      ui: { panelGift: true, scrollTo: 'cards' },
    };
  },
});

/* ============================== 赛题点名：密码修改 / 解挂 / 虚拟卡（红色与黄色） ============================== */
define({
  name: 'change_password', label: '交易密码修改', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '修改银行卡交易密码（红色级别）：需短信验证码 + 人脸识别双因子，并在确认卡片中设置新密码。',
  rationale: '密码修改属于极高风险操作，赛题明确列入红色清单，需多因子强验证。',
  params: { type: 'object', properties: { cardId: { type: 'string' } } },
  run(args = {}) {
    const card = resolveCard(args.cardId);
    if (!card) return { ok: true, outcome: 'need_info', data: {}, summary: '未定位到卡片', explain: ['请告诉我要改哪张卡的密码，例如「把储蓄卡交易密码改一下」。'] };
    const { action, sandboxCode } = actions.createAction({
      type: 'password_change', toolName: 'change_password',
      title: `修改 ${card.name}（尾号 ${card.tail}）交易密码`,
      payload: { cardId: card.id },
      payloadInput: { key: 'newPassword', label: '新交易密码（6 位数字）', type: 'password', maxLength: 6, hint: '沙箱不保存密码明文，仅记录修改事件' },
      summary: '红色操作：需短信验证码 + 人脸识别双因子，并在卡片中设置新密码',
      riskResult: { decision: 'confirm', hitRules: [] },
    });
    return {
      ok: true, outcome: 'pending', data: { card },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认密码修改 ${action.id}：${card.name}（尾号 ${card.tail}），需短信验证码 + 人脸识别`,
      ui: { focusCards: [card.id], scrollTo: 'cards' },
    };
  },
});

define({
  name: 'report_card_unfreeze', label: '卡片解挂', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '对已挂失/冻结的卡片办理解挂（红色级别）：需多因子认证，解挂后恢复交易。',
  rationale: '解挂会恢复一张曾被主动停用的卡，属于高风险操作，赛题列入红色清单。',
  params: { type: 'object', properties: { cardId: { type: 'string' } } },
  run(args = {}) {
    const card = resolveCard(args.cardId);
    if (!card) return { ok: true, outcome: 'need_info', data: {}, summary: '未定位到卡片', explain: ['请告诉我要解挂哪张卡，例如「把白金卡解挂」。'] };
    if (card.status === 'active' && !card.lost) {
      return { ok: true, outcome: 'rejected', data: { card }, summary: '该卡状态正常，无需解挂', explain: [`${card.name}（尾号 ${card.tail}）当前状态正常。`] };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'card_unfreeze', toolName: 'report_card_unfreeze',
      title: `解挂 ${card.name}（尾号 ${card.tail}）`,
      payload: { cardId: card.id },
      summary: card.lost ? '该卡曾办理挂失，解挂后恢复交易；建议尽快更换实体卡' : '该卡当前处于冻结状态，解挂后恢复交易',
      riskResult: { decision: 'confirm', hitRules: [] },
    });
    return {
      ok: true, outcome: 'pending', data: { card },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认解挂 ${action.id}：${card.name}（尾号 ${card.tail}），需短信验证码 + 人脸识别`,
      ui: { focusCards: [card.id], scrollTo: 'cards' },
    };
  },
});

/* ============================== 赛题对齐：回退上一步 / 执行到期预约 ============================== */
define({
  name: 'undo_last_action', label: '回退上一步操作', category: 'action', risk: 'high', requiresConfirm: true, implemented: true,
  description: '回退最近一笔可回退的操作（转账/取消订阅/冻结卡片/额度限额调整/锁定资金），展示将恢复的内容后确认。',
  rationale: '回退会反向改变账户状态或资金，属于高风险操作，先展示再确认。',
  params: { type: 'object', properties: { actionId: { type: 'string', description: '指定要回退的动作ID，不传则取最近一笔可回退动作' } } },
  run(args = {}) {
    const s = store.get();
    const doneList = (Array.isArray(s.pendingActions) ? s.pendingActions : [])
      .filter((x) => x.status === 'done' && x.revertInfo && x.type !== 'revert')
      .slice(-8).reverse();
    const target = args.actionId ? doneList.find((x) => x.id === args.actionId) : doneList[0];
    if (!target) {
      return { ok: true, outcome: 'need_info', data: { candidates: [] }, summary: '没有可回退的操作',
        explain: ['目前没有可回退的操作。转账、取消订阅、冻结卡片、额度/限额调整、锁定资金这几类执行后都可以用「回退上一步」收回。'] };
    }
    const kindLabel = { transfer: '转账（资金原路返回）', subscription: '取消订阅（恢复自动续费）', card_lock: '卡片冻结（恢复交易）', limit: '额度调整（恢复原额度）', card_limit: '限额调整（恢复原限额）', gift_lock: '锁定资金（解冻并取消预约）' }[target.revertInfo.kind] || target.revertInfo.kind;
    const { action, sandboxCode } = actions.createAction({
      type: 'revert', toolName: 'set_card_limit',
      title: `回退上一步：${kindLabel}`,
      payload: { revertInfo: target.revertInfo },
      summary: `将回退操作 ${target.id}：${target.title}`,
      riskResult: { decision: 'allow', hitRules: [] },
      needsSms: false,
    });
    return {
      ok: true, outcome: 'pending', data: { target: { id: target.id, title: target.title, kind: target.revertInfo.kind }, candidates: doneList.map((x) => ({ id: x.id, title: x.title })) },
      pending: { ...action, sandboxCode },
      summary: `已生成待确认回退 ${action.id}：${kindLabel}（原操作 ${target.id}）`,
      ui: { refresh: true },
    };
  },
});

define({
  name: 'run_scheduled', label: '执行到期预约', category: 'action', risk: 'medium', requiresConfirm: true, implemented: true,
  description: '沙箱演示用：把已锁定资金、待执行的预约任务（如生日前 2 天下单）立即执行。',
  rationale: '预约执行会真正下单扣款，属状态变更操作，需用户确认。',
  params: { type: 'object', properties: { taskId: { type: 'string' } } },
  run(args = {}) {
    const s = store.get();
    const due = (Array.isArray(s.scheduledTasks) ? s.scheduledTasks : []).filter((t) => t.status === 'scheduled' && (!args.taskId || t.id === args.taskId));
    if (!due.length) {
      return { ok: true, outcome: 'need_info', data: {}, summary: '没有待执行的预约任务',
        explain: ['当前没有待执行的预约任务。可以先说「下周我妈生日，帮我安排一下」创建预约。'] };
    }
    const { action, sandboxCode } = actions.createAction({
      type: 'gift_fulfill', toolName: 'set_card_limit',
      title: `执行到期预约：${due.map((t) => `${t.id}（${t.executeAt} 下单）`).join('、')}`,
      payload: { taskId: args.taskId || null },
      summary: `共 ${due.length} 个预约任务待执行；执行后将扣款、生成订单与提醒`, 
      riskResult: { decision: 'allow', hitRules: [] },
      needsSms: false,
    });
    return { ok: true, outcome: 'pending', data: { due }, pending: { ...action, sandboxCode },
      summary: `已生成待确认执行 ${action.id}：${due.length} 个预约任务`, ui: { panelGift: true, scrollTo: 'cards' } };
  },
});

/* ============================== 寒暄回应（有人情味的打招呼）============================== */
define({
  name: 'smalltalk', label: '寒暄回应', category: 'query', risk: 'low', requiresConfirm: false, implemented: true,
  description: '回应问候、感谢、告别、自我介绍等寒暄，不查数据、不动账户。',
  rationale: '纯寒暄，不涉及业务与资金，直接回答。',
  params: { type: 'object', properties: { text: { type: 'string' } } },
  run(args = {}) {
    const s = store.get();
    const t = String(args.text || '');
    const hour = new Date().getHours();
    const tod = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
    const who = s.user && s.user.name ? s.user.name : '你';
    if (/谢谢|多谢|感谢|辛苦/.test(t)) return { ok: true, data: { kind: 'thanks', who }, summary: '回应感谢' };
    if (/再见|拜拜|回见|晚安/.test(t)) return { ok: true, data: { kind: 'bye', who, tod }, summary: '回应告别' };
    if (/你是谁|你叫什么|介绍一下|能做什么|会什么/.test(t)) return { ok: true, data: { kind: 'intro', who }, summary: '自我介绍' };
    return { ok: true, data: { kind: 'greet', who, tod }, summary: `问候（${tod}）` };
  },
});

/* ============================== 对外接口 ============================== */
function get(name) { return registry.get(name) || null; }
function list() { return Array.from(registry.values()); }
function implementedList() { return list().filter((t) => t.implemented); }

/** 转成 OpenAI function-calling 的 tools 数组（仅暴露已实现工具给大模型） */
function toLLMTools() {
  return implementedList().map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.params },
  }));
}

async function execute(name, args = {}, ctx = {}) {
  const tool = get(name);
  if (!tool) return { ok: false, error: `未知工具：${name}` };
  if (!tool.implemented) {
    return {
      ok: false,
      notReady: true,
      phase: tool.phase,
      error: `「${tool.label}」属于阶段 ${tool.phase} 能力，当前阶段尚未接入。`,
    };
  }
  const t0 = Date.now();
  try {
    const res = await tool.run(args, ctx);
    res.ms = Date.now() - t0;
    return res;
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

module.exports = { get, list, implementedList, toLLMTools, execute, money, ToolNotReady, registry };
