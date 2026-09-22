'use strict';
/**
 * 风控规则引擎（独立安全模块）—— 纯逻辑，可单测，不划转任何资金。
 *
 * 覆盖总提示词要求的四条风控规则 + 三类异常输入：
 *   陌生收款人 / 夜间大额 / 整数大额 / 涉诈黑名单
 *   收款人不存在 / 余额不足 / 超限额
 * 并提供"二次确认 + 取消确认"的票据契约（阶段 2 在界面上接线）。
 *
 * 判定等级（从重到轻）：
 *   block  硬阻断：无论用户如何确认都不放行（如涉诈黑名单）
 *   reject 业务拒绝：客观条件不满足（收款人不存在、余额不足、超限额）
 *   confirm 需二次确认：可继续，但必须出示关键信息并验证（阶段 2 接入短信验证码）
 *   allow  直接执行
 */
const store = require('../store');
const config = require('../config');
const nlu = require('./nlu');

const SEC = config.security;
const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* =============================== 收款人解析 =============================== */
/**
 * 把口语里的收款人线索解析成确定性结果（人名 / 昵称 / 手机号尾号 / 备注）。
 * 返回 status: found | ambiguous | not_found
 */
function resolvePayee(input) {
  const s = store.get();
  const raw = typeof input === 'string' ? input : (input && (input.payeeText || input.name)) || '';
  const text = String(raw || '').trim();

  if (input && input.payeeId) {
    const byId = s.payees.find((p) => p.id === input.payeeId);
    if (byId) return { status: 'found', payee: byId, method: 'payeeId', query: text };
    return { status: 'not_found', payee: null, method: 'payeeId', query: text, candidates: [] };
  }

  if (!text) {
    return { status: 'not_found', payee: null, method: 'empty', query: '', candidates: [], reason: '没有提供收款人信息' };
  }

  // 1) 称谓（我妈 / 爸爸 / 室友 / 房东 / 同学）
  const nick = nlu.detectPayeeKeyword(text);
  if (nick) {
    const hit = s.payees.find((p) => p.nickname === nick || p.name === nick);
    if (hit) return { status: 'found', payee: hit, method: 'nickname', query: text };
  }

  // 2) 全名精确
  const exact = s.payees.find((p) => p.name === text);
  if (exact) return { status: 'found', payee: exact, method: 'exact_name', query: text };

  // 3) 包含式（李皓阳 / 王丽华…）
  const contains = s.payees.filter((p) => text.includes(p.name) || text.includes(p.nickname));
  if (contains.length === 1) return { status: 'found', payee: contains[0], method: 'name_contains', query: text };
  if (contains.length > 1) return { status: 'ambiguous', payee: null, method: 'name_contains', query: text, candidates: contains };

  // 4) 手机号/卡号尾号（≥4 位）
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 4) {
    const byPhone = s.payees.filter((p) => p.phone.replace(/\D/g, '').endsWith(digits) || p.accountMasked.replace(/\D/g, '').endsWith(digits));
    if (byPhone.length === 1) return { status: 'found', payee: byPhone[0], method: 'tail_digits', query: text };
    if (byPhone.length > 1) return { status: 'ambiguous', payee: null, method: 'tail_digits', query: text, candidates: byPhone };
  }

  // 5) 备注线索（买菜 / 房租 / 生活费）
  const byRemark = s.payees.filter((p) => (p.remarkHint || []).some((h) => text.includes(h)));
  if (byRemark.length === 1) return { status: 'found', payee: byRemark[0], method: 'remark_hint', query: text };

  return { status: 'not_found', payee: null, method: 'none', query: text, candidates: [] };
}

/** 收款账户是否命中涉诈黑名单（按卡号尾号模糊匹配） */
function matchBlacklist(accountText) {
  const s = store.get();
  const digits = String(accountText || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return s.blacklist.find((b) => {
    const bd = b.account.replace(/\D/g, '');
    return bd.endsWith(digits) || digits.endsWith(bd);
  }) || null;
}

/* =============================== 高风险话术识别 =============================== */
const FRAUD_PHRASES = [
  ['刷单', '刷单返利'], ['保证金', '保证金类话术'], ['安全账户', '所谓"安全账户"'],
  ['解冻', '账户解冻话术'], ['垫付', '垫付话术'], ['验证资金', '验证资金话术'],
  ['征信', '征信修复话术'], ['公检法', '冒充公检法话术'], ['客服退款', '冒充客服退款话术'],
];

function detectFraudPhrase(remark) {
  const t = String(remark || '');
  const hits = FRAUD_PHRASES.filter(([kw]) => t.includes(kw)).map(([, label]) => label);
  if (/催|急|马上|立刻|尽快|赶紧/.test(t)) hits.push('催促性话术（社工特征）');
  return hits;
}

/* =============================== 规则定义 =============================== */
/**
 * 规则目录：规则 ID 与名称的唯一来源。
 * evaluateRules 必须与它一一对应，自测会校验一致性，避免出现“写死的规则条数”。
 */
const RULE_CATALOG = [
  { id: 'R-09', name: '收款人不存在', level: 'reject' },
  { id: 'R-01', name: '收款人不在常用名单', level: 'strong' },
  { id: 'R-02', name: '收款账户涉诈黑名单', level: 'block' },
  { id: 'R-03', name: '金额达到二次确认阈值', level: 'confirm' },
  { id: 'R-04', name: '夜间大额转账', level: 'confirm' },
  { id: 'R-05', name: '整数大额转账', level: 'confirm' },
  { id: 'R-06', name: '可用余额不足', level: 'reject' },
  { id: 'R-07', name: '超过单笔限额', level: 'reject' },
  { id: 'R-08', name: '超过当日累计限额', level: 'reject' },
  { id: 'R-10', name: '备注命中高风险话术', level: 'strong' },
];
const ruleCount = () => RULE_CATALOG.length;

/**
 * 每条规则独立可测。
 * @returns {id,name,level,hit,detail}
 */
function evaluateRules(ctx) {
  const { amount, payeeResolution, card, remark, now, todayOut, accountHint } = ctx;
  const s = store.get();
  const out = [];
  const hour = now.getHours();
  const isNight = hour >= SEC.nightStartHour || hour < SEC.nightEndHour;

  // R-09 收款人不存在 → 业务拒绝
  out.push({
    id: 'R-09', name: '收款人不存在', level: 'reject',
    hit: payeeResolution.status !== 'found',
    detail: payeeResolution.status === 'ambiguous'
      ? `匹配到多个候选（${payeeResolution.candidates.map((c) => c.name).join('、')}），需要你确认是哪一个`
      : `常用收款人名单与账户库里都查不到「${payeeResolution.query}」，无法确定收款账户`,
  });

  // R-01 陌生收款人 → 强提醒（用于二次确认）
  out.push({
    id: 'R-01', name: '收款人不在常用名单', level: 'strong',
    hit: payeeResolution.status === 'found' && !payeeResolution.payee.usual,
    detail: payeeResolution.status === 'found' && !payeeResolution.payee.usual
      ? `「${payeeResolution.payee.name}」不在你的 ${s.payees.filter((p) => p.usual).length} 个常用收款人中，首次向 TA 转账`
      : '收款人在常用名单内，走快速通道',
  });

  // R-02 涉诈黑名单 → 硬阻断
  const bl = matchBlacklist(ctx.accountHint || (payeeResolution.payee ? payeeResolution.payee.accountMasked : payeeResolution.query));
  out.push({
    id: 'R-02', name: '收款账户涉诈黑名单', level: 'block',
    hit: Boolean(bl),
    detail: bl ? `收款账户命中反诈黑名单：${bl.reason}` : '收款账户未命中涉诈黑名单',
  });

  // R-03 金额达到二次确认阈值 → 需确认
  out.push({
    id: 'R-03', name: `金额达到二次确认阈值（${money(SEC.confirmThreshold)}）`, level: 'confirm',
    hit: Number(amount) >= SEC.confirmThreshold,
    detail: Number(amount) >= SEC.confirmThreshold
      ? `${money(amount)} ≥ ${money(SEC.confirmThreshold)}，属于高风险操作，必须二次确认`
      : `${money(amount)} 低于 ${money(SEC.confirmThreshold)}，无需强制二次确认`,
  });

  // R-04 夜间大额 → 需确认
  const nightHit = isNight && Number(amount) >= 1000;
  out.push({
    id: 'R-04', name: `夜间大额转账（${SEC.nightStartHour}:00–0${SEC.nightEndHour}:00）`, level: 'confirm',
    hit: nightHit,
    detail: nightHit
      ? `当前 ${String(hour).padStart(2, '0')} 点属夜间时段，且金额 ${money(amount)} ≥ ¥1,000`
      : '不在夜间时段，或金额未达夜间大额标准',
  });

  // R-05 整数大额 → 需确认
  const roundHit = Number(amount) >= SEC.roundAmountStep && Number(amount) % SEC.roundAmountStep === 0;
  out.push({
    id: 'R-05', name: '整数大额转账', level: 'confirm',
    hit: roundHit,
    detail: roundHit
      ? `${money(amount)} 恰为 ${money(SEC.roundAmountStep)} 的整数倍，整数大额是常见诈骗特征`
      : `金额 ${money(amount)} 不是 ${money(SEC.roundAmountStep)} 的整数倍`,
  });

  // R-06 余额不足 → 业务拒绝
  const avail = card ? Number(card.available || 0) : 0;
  const shortfall = Number(amount) - avail;
  out.push({
    id: 'R-06', name: '可用余额不足', level: 'reject',
    hit: Boolean(card) && shortfall > 0,
    detail: !card
      ? '未指定付款卡片，无法校验余额'
      : (shortfall > 0
        ? `${card.name}（尾号 ${card.tail}）可用 ${money(avail)}，本次需 ${money(amount)}，还差 ${money(shortfall)}`
        : `${card.name}（尾号 ${card.tail}）可用 ${money(avail)} ≥ ${money(amount)}，余额充足`),
  });

  // R-07 超单笔限额 → 业务拒绝
  const overSingle = Boolean(card) && Number(amount) > Number(card.singleLimit || Infinity);
  out.push({
    id: 'R-07', name: '超过单笔限额', level: 'reject',
    hit: overSingle,
    detail: overSingle
      ? `单笔上限 ${money(card.singleLimit)}，本次 ${money(amount)} 超出 ${money(Number(amount) - Number(card.singleLimit))}`
      : card ? `单笔限额 ${money(card.singleLimit)}，未超出` : '未指定卡片',
  });

  // R-08 超当日累计限额 → 业务拒绝
  const wouldBe = Number(todayOut || 0) + Number(amount);
  const overDaily = Boolean(card) && wouldBe > Number(card.dailyLimit || Infinity);
  out.push({
    id: 'R-08', name: '超过当日累计限额', level: 'reject',
    hit: overDaily,
    detail: overDaily
      ? `今日已转出 ${money(todayOut)}，本笔 ${money(amount)} 合计 ${money(wouldBe)}，超过日限额 ${money(card.dailyLimit)}`
      : card ? `今日已转出 ${money(todayOut)}，加本笔共 ${money(wouldBe)}，未超日限额 ${money(card.dailyLimit)}` : '未指定卡片',
  });

  // R-10 高风险话术 → 强提醒
  const phrases = detectFraudPhrase(remark);
  out.push({
    id: 'R-10', name: '备注命中高风险话术', level: 'strong',
    hit: phrases.length > 0,
    detail: phrases.length ? `备注中出现：${phrases.join('、')}` : '备注未命中已知诈骗话术库',
  });

  return out;
}

/* =============================== 综合判定 =============================== */
function evaluateTransfer(req = {}) {
  const s = store.get();
  const now = req.now ? new Date(req.now) : new Date();
  const amount = Number(req.amount);

  const payeeResolution = resolvePayee(req.payeeId ? { payeeId: req.payeeId } : (req.payeeText || ''));
  const card = req.cardId ? s.cards.find((c) => c.id === req.cardId)
    : s.cards.find((c) => c.kind === 'debit');

  if (!amount || isNaN(amount) || amount <= 0) {
    return {
      ok: false, decision: 'reject', reason: 'amount_invalid',
      payeeResolution, card, amount: null,
      rules: [], explain: ['没有识别到有效的转账金额，请告诉我具体金额。'],
      needsSms: false, canProceed: false,
    };
  }

  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayOut = (s.transfers || [])
    .filter((t) => t.status === 'done' && String(t.at || '').startsWith(todayKey))
    .reduce((a, t) => a + Number(t.amount || 0), 0);

  const rules = evaluateRules({ amount, payeeResolution, card, remark: req.remark, now, todayOut, accountHint: req.accountHint });

  const blockers = rules.filter((r) => r.hit && r.level === 'block');
  const rejects = rules.filter((r) => r.hit && r.level === 'reject');
  const strongs = rules.filter((r) => r.hit && r.level === 'strong');
  const confirms = rules.filter((r) => r.hit && r.level === 'confirm');

  let decision = 'allow';
  if (blockers.length) decision = 'block';
  else if (rejects.length) decision = 'reject';
  else if (confirms.length || strongs.length) decision = 'confirm';

  const explain = [];
  if (decision === 'block') {
    explain.push('⛔ 这是一次硬阻断：该收款账户命中反诈黑名单，**即使你坚持，我也不会放行**。');
    explain.push('建议立即停止转账，拨打 **96110**（国家反诈专线）或联系银行客服核实。');
  } else if (decision === 'reject') {
    for (const r of rejects) explain.push(`❌ ${r.detail}`);
    explain.push('本次转账**未执行**，你的资金没有任何变动。');
  } else if (decision === 'confirm') {
    explain.push(`本次转账需要**二次确认**，原因如下：`);
    for (const r of [...strongs, ...confirms]) explain.push(`• ${r.detail}`);
    explain.push('确认时我会展示收款人、金额、开户行，并核对验证码；你随时可以取消，取消不会产生任何资金变动。');
  } else {
    explain.push('风控未发现异常，该笔转账可按常规流程处理。');
  }

  return {
    ok: true,
    decision,
    amount,
    card: card ? { id: card.id, name: card.name, tail: card.tail, available: card.available, singleLimit: card.singleLimit, dailyLimit: card.dailyLimit } : null,
    payee: payeeResolution.payee ? {
      id: payeeResolution.payee.id, name: payeeResolution.payee.name, nickname: payeeResolution.payee.nickname,
      bank: payeeResolution.payee.bank, accountMasked: payeeResolution.payee.accountMasked, usual: payeeResolution.payee.usual,
    } : null,
    payeeResolution: { status: payeeResolution.status, method: payeeResolution.method, query: payeeResolution.query, accountHint: req.accountHint || '', candidates: (payeeResolution.candidates || []).map((c) => c.name) },
    rules,
    hitRules: rules.filter((r) => r.hit).map((r) => ({ id: r.id, name: r.name, level: r.level })),
    needsSms: decision === 'confirm' && (Number(amount) >= SEC.confirmThreshold || Boolean(blockers.length) === false && strongs.length > 0),
    canProceed: decision === 'confirm',
    explain,
    todayOut,
  };
}

/* =============================== 二次确认票据 =============================== */
let ticketSeq = 0;

/**
 * 创建确认票据（阶段 2 的界面确认流程使用；此处为可测试的纯逻辑）。
 * 沙箱环境：验证码直接随票据返回（真实环境通过短信下发，绝不回显）。
 */
function createTicket(op = {}) {
  const now = Date.now();
  ticketSeq += 1;
  ticketSeq = Math.max(ticketSeq, (store.get().confirmTickets || []).length + 1);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const ticket = {
    id: `CT${String(ticketSeq).padStart(4, '0')}`,
    type: op.type || 'transfer',
    payload: op.payload || {},
    createdAt: now,
    expiresAt: now + SEC.smsCodeTTLms,
    status: 'pending',
    needsSms: op.needsSms !== false,
  };
  const s = store.get();
  if (!Array.isArray(s.confirmTickets)) s.confirmTickets = [];
  s.confirmTickets.push(ticket);
  if (!Array.isArray(s.smsCodes)) s.smsCodes = [];
  s.smsCodes.push({ ticketId: ticket.id, code, expiresAt: ticket.expiresAt, used: false });
  store.save(true);
  return { ticket, sandboxCode: ticket.needsSms ? code : null };
}

function getTicket(id) {
  return (store.get().confirmTickets || []).find((t) => t.id === id) || null;
}

function verifySms(ticketId, code) {
  const t = getTicket(ticketId);
  if (!t) return { ok: false, reason: 'ticket_not_found', message: '确认票据不存在，请重新发起。' };
  if (t.status !== 'pending') return { ok: false, reason: 'ticket_not_pending', message: `该票据当前状态为 ${t.status}，不能重复确认。` };
  if (Date.now() > t.expiresAt) {
    t.status = 'expired';
    store.save(true);
    return { ok: false, reason: 'expired', message: '验证码已过期，请重新发起。' };
  }
  const rec = (store.get().smsCodes || []).find((x) => x.ticketId === ticketId && !x.used);
  if (!rec) return { ok: false, reason: 'no_code', message: '未找到有效验证码。' };
  if (String(code) !== rec.code) {
    store.addAudit({ action: 'confirm_sms', category: 'security', riskLevel: 'high', result: 'failed', detail: `票据 ${ticketId} 验证码错误`, request: `verify ${ticketId}` });
    return { ok: false, reason: 'code_mismatch', message: '验证码不正确。' };
  }
  rec.used = true;
  t.status = 'confirmed';
  store.save(true);
  store.addAudit({ action: 'confirm_sms', category: 'security', riskLevel: 'high', result: 'success', detail: `票据 ${ticketId} 验证码校验通过`, request: `verify ${ticketId}` });
  return { ok: true, ticket: t };
}

/**
 * 用户取消确认 —— 明确契约：不改动任何资金，并留下 result=cancelled 的审计记录。
 */
function cancelTicket(ticketId, reason = '用户取消') {
  const t = getTicket(ticketId);
  if (!t) return { ok: false, reason: 'ticket_not_found', message: '确认票据不存在。' };
  if (t.status === 'cancelled') return { ok: true, ticket: t, message: '该操作此前已被取消。' };
  t.status = 'cancelled';
  t.cancelledAt = Date.now();
  store.save(true);
  const rec = store.addAudit({
    action: t.type === 'transfer' ? 'transfer_cancelled' : `${t.type}_cancelled`,
    category: 'security', riskLevel: 'high', result: 'cancelled',
    amount: t.payload && t.payload.amount ? t.payload.amount : null,
    detail: `用户取消确认：${reason}`,
    request: `ticket ${ticketId}`,
    reason: '用户主动取消，未发生任何资金变动',
  });
  return { ok: true, ticket: t, auditId: rec.id, message: '已取消，未发生任何资金变动。' };
}

module.exports = {
  resolvePayee, matchBlacklist, detectFraudPhrase,
  evaluateRules, evaluateTransfer,
  createTicket, getTicket, verifySms, cancelTicket,
  RULE_CATALOG, ruleCount, SEC,
};
