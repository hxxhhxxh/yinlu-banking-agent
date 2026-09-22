'use strict';
/**
 * 动作层（阶段 2）：把"高风险操作"拆成『预检 → 待确认 → 执行/取消 → 留痕』四步。
 *
 * 设计要点：
 *  1. 创建动作时先跑风控（riskEngine），block/reject 的行不给确认入口；
 *  2. 所有动作先落 `pendingActions`，界面上展示收款人/金额/开户行等关键信息；
 *  3. 达到二次确认门槛的动作额外需要模拟短信验证码；
 *  4. 真正的资金变动只发生在 executeAction() 里，且执行时会**再次校验**余额与状态（防并发/超时）；
 *  5. 取消与失败都写审计日志，且明确"未发生资金变动"。
 */
const store = require('../store');
const config = require('../config');
const risk = require('./riskEngine');
const guard = require('./securityGuard');

const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nowText = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const todayKey = () => nowText().slice(0, 10);

let seq = 0;
function syncSeq() {
  const s = store.get();
  const list = Array.isArray(s.pendingActions) ? s.pendingActions : [];
  for (const a of list) {
    const n = parseInt(String(a.id || '').replace(/^PA/, ''), 10);
    if (!isNaN(n) && n > seq) seq = n;
  }
}

function ensureState() {
  const s = store.get();
  if (!Array.isArray(s.pendingActions)) s.pendingActions = [];
  if (!Array.isArray(s.transfers)) s.transfers = [];
  if (!Array.isArray(s.plans)) s.plans = [];
  if (!Array.isArray(s.aaSplits)) s.aaSplits = [];
  return s;
}

/* ============================== 创建待确认动作 ============================== */
/**
 * @param {object} opts {type, title, payload, riskResult, summary}
 * @returns {{action:object, sandboxCode:string|null}}
 */
function createAction(opts = {}) {
  const s = ensureState();
  syncSeq();
  expireOld();

  // 分级：优先使用外部传入的分级；否则由安全守卫按赛题口径自动分级（绿/黄/红）
  let tierInfo;
  if (opts.tier) {
    tierInfo = { tier: opts.tier, label: opts.tierLabel || '', requiredFactors: opts.requiredFactors || [], reason: opts.tierReason || '' };
  } else {
    const toolName = opts.toolName || guard.ACTION_TYPE_TO_TOOL[opts.type] || opts.type;
    const amount = (opts.payload && (opts.payload.amount || opts.payload.budget)) || 0;
    tierInfo = guard.classifyTier(toolName, { amount }, { todayOut: guard.todayOutAmount() });
  }
  const requiredFactors = tierInfo.requiredFactors.slice();
  const needsSms = requiredFactors.includes('sms');
  const needsFace = requiredFactors.includes('face');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  seq += 1;

  const action = {
    id: `PA${String(seq).padStart(4, '0')}`,
    type: opts.type,
    title: opts.title || '',
    summary: opts.summary || '',
    payload: opts.payload || {},
    riskDecision: opts.riskResult ? opts.riskResult.decision : 'allow',
    hitRules: opts.riskResult ? opts.riskResult.hitRules : [],
    tier: tierInfo.tier,
    tierLabel: tierInfo.label,
    tierReason: tierInfo.reason || '',
    requiredFactors,
    needsSms,
    needsFace,
    smsCode: needsSms ? code : null,
    createdAt: Date.now(),
    createdAtText: nowText(),
    expiresAt: Date.now() + config.security.smsCodeTTLms,
    status: 'pending',
    attempts: 0,
    decisionChain: opts.decisionChain || null,
    payloadInput: opts.payloadInput || null,
  };
  s.pendingActions.push(action);
  if (s.pendingActions.length > 100) s.pendingActions.splice(0, s.pendingActions.length - 100);
  store.save(true);

  store.addAudit({
    action: `${opts.type}_pending`, category: 'action',
    riskLevel: action.tier === 'red' ? 'high' : 'medium',
    amount: action.payload.amount || null,
    result: 'pending',
    detail: `已创建待确认动作 ${action.id}：${action.title}（${action.tierLabel}${requiredFactors.length ? '，需 ' + requiredFactors.join('+') : ''}）`,
    request: opts.summary || '',
    reason: action.tierReason || '高风险操作先出示关键信息并等待用户确认',
    requiresConfirm: true,
    tier: action.tier,
    decisionChain: action.decisionChain,
  });

  return { action, sandboxCode: needsSms ? code : null };
}

function expireOld() {
  const s = ensureState();
  for (const a of s.pendingActions) {
    if (a.status === 'pending' && Date.now() > a.expiresAt) {
      a.status = 'expired';
      store.save(true);
      store.addAudit({ action: `${a.type}_expired`, category: 'action', riskLevel: 'medium', result: 'expired', detail: `待确认动作 ${a.id} 超时自动失效（未发生资金变动）`, request: a.id, reason: '确认超时保护' });
    }
  }
}

function getAction(id) {
  ensureState();
  expireOld();
  return store.get().pendingActions.find((a) => a.id === id) || null;
}

function listPending() {
  ensureState();
  expireOld();
  return store.get().pendingActions.filter((a) => a.status === 'pending');
}

function recentActions(n = 10) {
  ensureState();
  return store.get().pendingActions.slice(-n).reverse();
}

/* ============================== 取消 ============================== */
function cancelAction(id, reason = '用户取消') {
  const a = getAction(id);
  if (!a) return { ok: false, error: '未找到该待确认操作（可能已失效）' };
  if (a.status === 'cancelled') return { ok: true, action: a, message: '该操作此前已被取消。' };
  if (a.status !== 'pending') return { ok: false, error: `该操作当前状态为 ${a.status}，无法取消。` };
  a.status = 'cancelled';
  a.cancelledAt = Date.now();
  store.save(true);
  const rec = store.addAudit({
    action: `${a.type}_cancelled`, category: 'action', riskLevel: 'high',
    amount: a.payload.amount || null, result: 'cancelled',
    detail: `用户取消：${reason}（${a.title}）`, request: a.id,
    reason: '用户主动取消，未发生任何资金变动',
  });
  return { ok: true, action: a, auditId: rec.id, message: '已取消，未发生任何资金变动。' };
}

/* ============================== 执行 ============================== */
/**
 * 确认并执行。
 * @param {string} id
 * @param {{code?:string, confirmText?:string}} input
 */
function executeAction(id, input = {}) {
  const a = getAction(id);
  if (!a) return { ok: false, error: '未找到该待确认操作（可能已失效，请重新发起）' };
  if (a.status === 'done') return { ok: false, error: '该操作已执行完成，请勿重复提交。' };
  if (a.status === 'cancelled') return { ok: false, error: '该操作已被取消。' };
  if (a.status === 'expired') return { ok: false, error: '该操作已超时失效，请重新发起。' };

  // 熔断保护：安全锁定期间禁止红色操作
  const lock = guard.assertNotLocked(a.tier || 'yellow');
  if (!lock.ok) return { ok: false, error: lock.error, circuit: guard.circuitState() };

  const required = a.requiredFactors || (a.needsSms ? ['sms'] : []);

  // 因子一：短信验证码
  if (required.includes('sms')) {
    a.attempts += 1;
    if (a.attempts > 3) {
      a.status = 'locked';
      store.save(true);
      store.addAudit({ action: `${a.type}_locked`, category: 'action', riskLevel: 'high', result: 'failed', detail: `验证码错误次数过多，动作 ${a.id} 已锁定`, request: a.id, reason: '防暴力尝试' });
      guard.recordFailure('sms_locked');
      return { ok: false, error: '验证码错误次数过多，该操作已锁定，请重新发起。' };
    }
    if (String(input.code || '') !== String(a.smsCode)) {
      store.save(true);
      store.addAudit({ action: `${a.type}_verify`, category: 'security', riskLevel: 'high', result: 'failed', detail: `动作 ${a.id} 验证码错误（第 ${a.attempts} 次）`, request: a.id });
      guard.recordFailure('sms_wrong');
      return { ok: false, error: '验证码不正确。', attemptsLeft: Math.max(0, 3 - a.attempts), circuit: guard.circuitState() };
    }
  }

  // 因子二：人脸识别（沙箱模拟）
  if (required.includes('face') && input.face !== true) {
    store.save(true);
    return { ok: false, error: '该操作为红色级别，需通过人脸识别（沙箱可点“模拟人脸识别”通过）。', needFace: true, requiredFactors: required };
  }

  // 显式确认语（用户也可能在对话里直接回"确认"）
  if (input.confirmText !== undefined && !/^(确认|确定|同意|yes|ok|继续)$/i.test(String(input.confirmText).trim())) {
    return { ok: false, error: '需要明确回复"确认"才能执行。' };
  }

  const executor = EXECUTORS[a.type];
  if (!executor) return { ok: false, error: `不支持的动作类型：${a.type}` };
  a.confirmedBy = required.length ? required.join('+') : 'click'; // 先回填确认方式，供执行器写台账

  const res = executor(a, input); // 内部做二次校验 + 真实变更
  if (!res.ok) {
    a.status = 'failed';
    a.failReason = res.error;
    store.save(true);
    store.addAudit({
      action: a.type, category: 'action', riskLevel: 'high',
      amount: a.payload.amount || null, result: 'failed',
      detail: `执行失败：${res.error}`, request: a.id,
      reason: '执行前的二次校验未通过，未发生资金变动',
      tier: a.tier, decisionChain: a.decisionChain,
    });
    guard.recordFailure('exec_failed');
    return { ok: false, error: res.error, action: a, circuit: guard.circuitState() };
  }

  res.revertInfo ? (a.revertInfo = res.revertInfo) : null; // 供“回退上一步”使用
  a.status = 'done';
  a.doneAt = Date.now();
  a.receipt = res.receipt;
  store.save(true);
  store.addAudit({
    action: a.type, category: 'action', riskLevel: 'high',
    amount: a.payload.amount || null, result: 'success',
    detail: res.auditDetail || res.receipt, request: a.id,
    reason: required.length ? `用户通过多因子（${required.join('+')}）确认后执行` : '用户点击确认后执行',
    requiresConfirm: true,
    tier: a.tier, decisionChain: a.decisionChain,
  });
  return { ok: true, action: a, receipt: res.receipt, receiptData: res.receiptData || null };
}

/* ============================== 各动作的真实执行 ============================== */
const EXECUTORS = {};

/** 转账：真实扣减余额 + 记流水 + 记转账台账 */
EXECUTORS.transfer = (a) => {
  const s = ensureState();
  const p = a.payload;
  const card = s.cards.find((c) => c.id === p.cardId);
  const payee = s.payees.find((x) => x.id === p.payeeId);
  if (!card) return { ok: false, error: '付款卡不存在。' };
  if (!payee) return { ok: false, error: '收款人不存在，无法执行。' };
  if (card.status !== 'active') return { ok: false, error: `付款卡状态为「${card.status}」，无法转出。` };
  const amount = Number(p.amount);
  if (!(amount > 0)) return { ok: false, error: '金额无效。' };
  if (Number(card.available) < amount) return { ok: false, error: `余额不足：可用 ${money(card.available)}，本次需 ${money(amount)}。` };
  if (amount > Number(card.singleLimit || Infinity)) return { ok: false, error: `超过单笔限额 ${money(card.singleLimit)}。` };

  if (card.kind === 'debit') {
    card.balance = Number((card.balance - amount).toFixed(2));
    card.available = Number((card.available - amount).toFixed(2));
  } else {
    card.usedCredit = Number(((card.usedCredit || 0) + amount).toFixed(2));
    card.available = Number(((card.creditLimit || 0) - card.usedCredit).toFixed(2));
  }

  const txnId = `T${String(s.transactions.length + 1).padStart(5, '0')}${Math.floor(Math.random() * 90 + 10)}`;
  const txn = {
    id: txnId, cardId: card.id, ts: nowText(), timestamp: Date.now(),
    direction: 'out', amount, merchant: `转账-${payee.name}`, category: '转账',
    city: s.user.city, channel: 'AI副驾·转账', anomaly: null,
    remark: p.remark || '', transferId: a.id,
  };
  s.transactions.unshift(txn);

  const transfer = {
    id: `TR${String(s.transfers.length + 1).padStart(4, '0')}`,
    at: nowText(), actionId: a.id, txnId,
    payeeId: payee.id, payeeName: payee.name, payeeNickname: payee.nickname,
    payeeBank: payee.bank, payeeAccountMasked: payee.accountMasked,
    amount, cardId: card.id, cardName: card.name, cardTail: card.tail,
    remark: p.remark || '', status: 'done',
    confirmedBy: a.confirmedBy || (a.needsSms ? 'sms' : 'click'),
    riskDecision: a.riskDecision, hitRules: (a.hitRules || []).map((r) => r.id),
  };
  s.transfers.push(transfer);
  s.lastTransfer = transfer;
  store.save(true);

  return {
    ok: true,
    receipt: `转账成功：${payee.name}（${payee.bank} ${payee.accountMasked}）${money(amount)}，付款卡 ${card.name}（尾号 ${card.tail}），当前余额 ${money(card.available)}`,
    receiptData: { transfer, txn, balance: card.available, card: { id: card.id, name: card.name, tail: card.tail } },
    revertInfo: { kind: 'transfer', transferId: transfer.id },
    auditDetail: `向 ${payee.name} 转账 ${money(amount)}（${payee.bank} ${payee.accountMasked}），付款卡尾号 ${card.tail}，扣款后可用 ${money(card.available)}`,
  };
};

/** 定时转账：创建计划（不立即动资金，但属于对未来扣款的授权） */
EXECUTORS.schedule = (a) => {
  const s = ensureState();
  const p = a.payload;
  const payee = s.payees.find((x) => x.id === p.payeeId);
  const card = s.cards.find((c) => c.id === p.cardId);
  if (!payee) return { ok: false, error: '收款人不存在，无法创建定时转账。' };
  if (!card) return { ok: false, error: '付款卡不存在。' };

  const plan = {
    id: `PL${String(s.plans.length + 1).padStart(4, '0')}`,
    type: p.cycle === 'monthly' ? 'monthly' : 'once',
    cycle: p.cycle || 'once',
    monthlyDay: p.monthlyDay || null,
    date: p.date || null,
    payeeId: payee.id, payeeName: payee.name, payeeNickname: payee.nickname,
    payeeBank: payee.bank, payeeAccountMasked: payee.accountMasked,
    amount: Number(p.amount), cardId: card.id, cardTail: card.tail,
    remark: p.remark || '',
    nextRunAt: p.date || (p.monthlyDay ? `每月 ${p.monthlyDay} 日` : ''),
    status: 'active', createdAt: nowText(), actionId: a.id,
  };
  s.plans.push(plan);
  store.save(true);
  return {
    ok: true,
    receipt: `定时转账已创建：${plan.cycle === 'monthly' ? `每月 ${plan.monthlyDay} 日` : plan.date} 向 ${payee.name} 转 ${money(plan.amount)}（付款卡尾号 ${card.tail}），共 1 条计划生效中`,
    receiptData: { plan },
    auditDetail: `创建定时转账计划 ${plan.id}：${plan.nextRunAt} 向 ${payee.name} 转 ${money(plan.amount)}`,
  };
};

/** AA 拆分收款：生成待收明细 */
EXECUTORS.aa = (a) => {
  const s = ensureState();
  const p = a.payload;
  const participants = (p.participants || []).map((x) => {
    const payee = s.payees.find((y) => y.id === x.payeeId);
    return { payeeId: x.payeeId, name: payee ? payee.name : x.name, nickname: payee ? payee.nickname : x.name, amount: Number(x.amount), status: 'pending' };
  });
  if (!participants.length) return { ok: false, error: '没有可发起收款的参与人。' };
  const split = {
    id: `AA${String(s.aaSplits.length + 1).padStart(4, '0')}`,
    at: nowText(), actionId: a.id,
    total: Number(p.total), people: Number(p.people || participants.length + 1),
    perHead: Number(p.perHead), myShare: Number(p.perHead),
    participants, remark: p.remark || '', status: 'collecting',
  };
  s.aaSplits.push(split);
  store.save(true);
  const list = participants.map((x) => `${x.nickname} ${money(x.amount)}`).join('；');
  return {
    ok: true,
    receipt: `AA 收款请求已生成：总额 ${money(split.total)} / ${split.people} 人，每人 ${money(split.perHead)}；待收：${list}`,
    receiptData: { split },
    auditDetail: `创建 AA 拆分收款 ${split.id}：总额 ${money(split.total)}，每人 ${money(split.perHead)}，参与人 ${participants.map((x) => x.name).join('、')}`,
  };
};

/** 撤销最近一笔转账：T+0 可撤回，资金原路返回 */
EXECUTORS.undo = (a) => {
  const s = ensureState();
  const target = a.payload.transferId
    ? s.transfers.find((t) => t.id === a.payload.transferId)
    : [...s.transfers].reverse().find((t) => t.status === 'done');
  if (!target) return { ok: false, error: '没有可撤销的转账记录。' };
  if (target.status !== 'done') return { ok: false, error: `该笔转账当前状态为 ${target.status}，无法撤销。` };
  if (!String(target.at).startsWith(todayKey())) {
    return { ok: false, error: `该笔转账发生在 ${String(target.at).slice(0, 10)}，T+0 撤销仅支持当日转账，请通过客服申请撤销。` };
  }
  const card = s.cards.find((c) => c.id === target.cardId);
  if (!card) return { ok: false, error: '原付款卡不存在，无法撤销。' };

  if (card.kind === 'debit') {
    card.balance = Number((card.balance + target.amount).toFixed(2));
    card.available = Number((card.available + target.amount).toFixed(2));
  } else {
    card.usedCredit = Number((Math.max(0, (card.usedCredit || 0) - target.amount)).toFixed(2));
    card.available = Number(((card.creditLimit || 0) - card.usedCredit).toFixed(2));
  }
  target.status = 'reversed';
  target.reversedAt = nowText();

  const txnId = `T${String(s.transactions.length + 1).padStart(5, '0')}${Math.floor(Math.random() * 90 + 10)}`;
  s.transactions.unshift({
    id: txnId, cardId: card.id, ts: nowText(), timestamp: Date.now(),
    direction: 'in', amount: target.amount, merchant: `撤销转账-${target.payeeName}`, category: '转账',
    city: s.user.city, channel: 'AI副驾·撤销', anomaly: null,
    remark: `撤销 ${target.id}`, transferId: target.id,
  });
  if (s.lastTransfer && s.lastTransfer.id === target.id) s.lastTransfer = { ...target };
  store.save(true);
  return {
    ok: true,
    receipt: `已撤销 ${target.id}：${target.payeeName} ${money(target.amount)} 已原路返回，付款卡可用余额恢复为 ${money(card.available)}`,
    receiptData: { transfer: target, balance: card.available, card: { id: card.id, name: card.name, tail: card.tail } },
    auditDetail: `撤销转账 ${target.id}（${target.payeeName} ${money(target.amount)}），资金原路返回，恢复后可用 ${money(card.available)}`,
  };
};

/** 取消订阅：把订阅状态置为 cancelled，后续不再扣费 */
EXECUTORS.subscription_cancel = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const sub = s.subscriptions.find((x) => x.id === p.subscriptionId);
  if (!sub) return { ok: false, error: '订阅不存在。' };
  if ((sub.status || 'active') !== 'active') return { ok: false, error: `该订阅当前状态为 ${sub.status}，无需重复取消。` };
  sub.status = 'cancelled';
  sub.cancelledAt = nowText();
  sub.cancelActionId = a.id;
  store.save(true);
  return {
    ok: true,
    receipt: `已取消「${sub.merchant}」的自动续费（原 ${money(sub.amount)}/${sub.cycle === 'monthly' ? '月' : '年'}，原定 ${sub.nextChargeDate} 扣费），从今天起不会再自动扣费`,
    receiptData: { subscription: sub },
    revertInfo: { kind: 'subscription', id: sub.id },
    auditDetail: `取消订阅 ${sub.id}「${sub.merchant}」，原金额 ${money(sub.amount)}，原下次扣费日 ${sub.nextChargeDate}`,
  };
};

/** 理财申购：适当性已在工具层拦一道，这里再做执行前二次校验 */
EXECUTORS.product_purchase = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const product = s.products.find((x) => x.id === p.productId);
  const card = s.cards.find((c) => c.id === p.cardId);
  const amount = Number(p.amount);
  if (!product) return { ok: false, error: '产品不存在。' };
  if (!card) return { ok: false, error: '扣款卡不存在。' };
  if (card.status !== 'active') return { ok: false, error: `扣款卡状态为「${card.status}」，无法申购。` };
  if (!(amount > 0)) return { ok: false, error: '金额无效。' };
  if (amount < Number(product.minAmount)) return { ok: false, error: `该产品起购金额为 ${money(product.minAmount)}，本次 ${money(amount)} 低于起购线。` };
  if (Number(card.available) < amount) return { ok: false, error: `可用余额不足：可用 ${money(card.available)}，本次需 ${money(amount)}。` };

  const wealth = require('./wealthEngine');
  if (!wealth.isSuitable(s.user.riskLevel, product)) {
    return { ok: false, error: `适当性校验未通过：${product.name}（${product.riskLevel}）超出你的风险等级 ${s.user.riskLevel}（${s.user.riskLevelName}），不能申购。` };
  }

  if (card.kind === 'debit') {
    card.balance = Number((card.balance - amount).toFixed(2));
    card.available = Number((card.available - amount).toFixed(2));
  } else {
    card.usedCredit = Number(((card.usedCredit || 0) + amount).toFixed(2));
    card.available = Number(((card.creditLimit || 0) - card.usedCredit).toFixed(2));
  }
  if (!Array.isArray(s.holdings)) s.holdings = [];
  const holding = {
    id: `H${String(s.holdings.length + 1).padStart(4, '0')}`,
    productId: product.id, code: product.code, name: product.name,
    riskLevel: product.riskLevel, riskName: product.riskName, type: product.type,
    expectedReturn: product.expectedReturn, term: product.term, liquidity: product.liquidity,
    amount, purchasedAt: nowText(), cardId: card.id, cardTail: card.tail,
    status: 'holding', actionId: a.id,
  };
  s.holdings.push(holding);

  const txnId = `T${String(s.transactions.length + 1).padStart(5, '0')}${Math.floor(Math.random() * 90 + 10)}`;
  s.transactions.unshift({
    id: txnId, cardId: card.id, ts: nowText(), timestamp: Date.now(),
    direction: 'out', amount, merchant: `理财申购-${product.name}`, category: '理财',
    city: s.user.city, channel: 'AI副驾·理财', anomaly: null, remark: product.code,
  });
  store.save(true);
  return {
    ok: true,
    receipt: `申购成功：${product.name}（${product.riskLevel} ${product.riskName}）${money(amount)}，业绩比较基准 ${product.expectedReturn}%/年，期限 ${product.term}；扣款卡 ${card.name}（尾号 ${card.tail}）可用余额 ${money(card.available)}`,
    receiptData: { holding, txnId, balance: card.available, card: { id: card.id, name: card.name, tail: card.tail }, product: { name: product.name, riskLevel: product.riskLevel, expectedReturn: product.expectedReturn, term: product.term } },
    auditDetail: `申购 ${product.name}（${product.riskLevel}）${money(amount)}，扣款卡尾号 ${card.tail}，扣款后可用 ${money(card.available)}`,
  };
};

/** 理财赎回：沙箱按 T+0 到账（真实环境为 T+1） */
EXECUTORS.product_redeem = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const holding = (s.holdings || []).find((h) => h.id === p.holdingId);
  const card = s.cards.find((c) => c.id === (holding && holding.cardId)) || s.cards.find((c) => c.kind === 'debit');
  const amount = Number(p.amount);
  if (!holding) return { ok: false, error: '未找到该持仓。' };
  if (holding.status !== 'holding') return { ok: false, error: '该持仓已赎回或已关闭。' };
  if (!(amount > 0)) return { ok: false, error: '金额无效。' };
  if (amount > Number(holding.amount)) return { ok: false, error: `赎回金额 ${money(amount)} 超过持有金额 ${money(holding.amount)}。` };
  if (!card) return { ok: false, error: '到账卡不存在。' };

  holding.amount = Number((holding.amount - amount).toFixed(2));
  holding.status = holding.amount > 0 ? 'holding' : 'closed';
  holding.lastRedeemAt = nowText();

  if (card.kind === 'debit') {
    card.balance = Number((card.balance + amount).toFixed(2));
    card.available = Number((card.available + amount).toFixed(2));
  } else {
    card.usedCredit = Number((Math.max(0, (card.usedCredit || 0) - amount)).toFixed(2));
    card.available = Number(((card.creditLimit || 0) - card.usedCredit).toFixed(2));
  }
  const txnId = `T${String(s.transactions.length + 1).padStart(5, '0')}${Math.floor(Math.random() * 90 + 10)}`;
  s.transactions.unshift({
    id: txnId, cardId: card.id, ts: nowText(), timestamp: Date.now(),
    direction: 'in', amount, merchant: `理财赎回-${holding.name}`, category: '理财',
    city: s.user.city, channel: 'AI副驾·理财', anomaly: null, remark: holding.code,
  });
  store.save(true);
  return {
    ok: true,
    receipt: `赎回成功：${holding.name} ${money(amount)}，已回款至 ${card.name}（尾号 ${card.tail}），可用余额 ${money(card.available)}${holding.status === 'closed' ? '；该持仓已全部赎回' : `；剩余持有 ${money(holding.amount)}`}`,
    receiptData: { holding, txnId, balance: card.available, card: { id: card.id, name: card.name, tail: card.tail } },
    auditDetail: `赎回 ${holding.name} ${money(amount)}，回款卡尾号 ${card.tail}，回款后可用 ${money(card.available)}（沙箱按 T+0 到账）`,
  };
};

/* ---- 卡片业务 ---- */
EXECUTORS.card_apply = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  if (!Array.isArray(s.cardRequests)) s.cardRequests = [];
  const req = {
    id: `CR${String(s.cardRequests.length + 1).padStart(4, '0')}`,
    cardType: p.cardType || '信用卡·金卡', level: p.level || '金卡',
    applicant: s.user.name, status: 'under_review', createdAt: nowText(), actionId: a.id,
    estimate: '1–3 个工作日',
  };
  s.cardRequests.push(req);
  store.save(true);
  return {
    ok: true,
    receipt: `卡片申请已受理：${req.cardType}，受理编号 ${req.id}，预计 ${req.estimate} 出审核结果；审核通过后新卡将寄送至预留地址（${s.user.city}）`,
    receiptData: { request: req },
    auditDetail: `提交卡片申请 ${req.id}：${req.cardType}`,
  };
};

EXECUTORS.limit_adjust = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId);
  const newLimit = Number(p.newLimit);
  if (!card) return { ok: false, error: '卡片不存在。' };
  if (card.kind !== 'credit') return { ok: false, error: '仅信用卡支持额度调整。' };
  if (!(newLimit > 0)) return { ok: false, error: '额度无效。' };
  if (newLimit >= 200000) return { ok: false, error: '单卡额度上限为 ¥200,000。' };
  if (newLimit < Number(card.usedCredit || 0)) return { ok: false, error: `新额度不得低于已用额度 ${money(card.usedCredit)}。` };
  const before = card.creditLimit;
  if (Number(before) === newLimit) return { ok: false, error: `当前额度已经是 ${money(newLimit)}。` };
  card.creditLimit = Number(newLimit.toFixed(2));
  card.available = Number((card.creditLimit - Number(card.usedCredit || 0)).toFixed(2));
  store.save(true);
  return {
    ok: true,
    receipt: `${newLimit > before ? '提额' : '降额'}成功：${card.name}（尾号 ${card.tail}）额度 ${money(before)} → ${money(newLimit)}，可用额度 ${money(card.available)}`,
    receiptData: { card: { id: card.id, name: card.name, tail: card.tail, creditLimit: card.creditLimit, available: card.available, usedCredit: card.usedCredit }, before, after: card.creditLimit },
    revertInfo: { kind: 'limit', cardId: card.id, before: { creditLimit: before } },
    auditDetail: `${card.name}（尾号 ${card.tail}）额度调整 ${money(before)} → ${money(newLimit)}`,
  };
};

EXECUTORS.card_limit = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId);
  if (!card) return { ok: false, error: '卡片不存在。' };
  const single = p.singleLimit === undefined || p.singleLimit === null ? Number(card.singleLimit) : Number(p.singleLimit);
  const daily = p.dailyLimit === undefined || p.dailyLimit === null ? Number(card.dailyLimit) : Number(p.dailyLimit);
  if (!(single > 0) || !(daily > 0)) return { ok: false, error: '限额必须大于 0。' };
  if (single > 50000) return { ok: false, error: '单笔限额上限为 ¥50,000（超过请到柜面办理）。' };
  if (daily < single) return { ok: false, error: '日限额不能小于单笔限额。' };
  const before = { singleLimit: card.singleLimit, dailyLimit: card.dailyLimit };
  card.singleLimit = single;
  card.dailyLimit = daily;
  store.save(true);
  return {
    ok: true,
    receipt: `交易限额已更新：${card.name}（尾号 ${card.tail}）单笔 ${money(before.singleLimit)} → ${money(single)}，日累计 ${money(before.dailyLimit)} → ${money(daily)}`,
    receiptData: { card: { id: card.id, name: card.name, tail: card.tail, singleLimit: card.singleLimit, dailyLimit: card.dailyLimit }, before },
    revertInfo: { kind: 'card_limit', cardId: card.id, before },
    auditDetail: `${card.name}（尾号 ${card.tail}）限额调整：单笔 ${money(before.singleLimit)}→${money(single)}，日累计 ${money(before.dailyLimit)}→${money(daily)}`,
  };
};

EXECUTORS.card_lock = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId);
  if (!card) return { ok: false, error: '卡片不存在。' };
  if (p.action === 'unfreeze') {
    if (card.lost) return { ok: false, error: '该卡已办理挂失，不能自助解冻，请到柜面补卡。' };
    if (card.status === 'active') return { ok: false, error: '该卡当前状态正常，无需解冻。' };
    card.status = 'active';
    card.frozenReason = null;
    store.save(true);
    return { ok: true, receipt: `已解冻：${card.name}（尾号 ${card.tail}）恢复交易，单笔限额 ${money(card.singleLimit)}`, receiptData: { card: { id: card.id, name: card.name, tail: card.tail, status: card.status } }, auditDetail: `解冻 ${card.name}（尾号 ${card.tail}）` };
  }
  if (card.status === 'frozen') return { ok: false, error: '该卡已处于冻结状态。' };
  card.status = 'frozen';
  card.frozenReason = p.reason || '用户主动限制交易';
  card.frozenAt = nowText();
  store.save(true);
  return { ok: true, receipt: `已限制交易（冻结）：${card.name}（尾号 ${card.tail}），该卡将无法发生任何支出，可随时解冻`, receiptData: { card: { id: card.id, name: card.name, tail: card.tail, status: card.status } }, revertInfo: { kind: 'card_lock', cardId: card.id, action: 'freeze' }, auditDetail: `冻结 ${card.name}（尾号 ${card.tail}）：${card.frozenReason}` };
};

EXECUTORS.card_loss = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId);
  if (!card) return { ok: false, error: '卡片不存在。' };
  if (card.lost) return { ok: false, error: '该卡已办理过挂失。' };
  card.status = 'frozen';
  card.lost = true;
  card.lostAt = nowText();
  card.frozenReason = '已挂失';
  store.save(true);
  return {
    ok: true,
    receipt: `挂失成功，卡片已立即冻结：${card.name}（尾号 ${card.tail}）；受理编号 ${a.id}，受理时间 ${nowText()}；补卡将寄送至预留地址（${s.user.city}）；卡内未出账单仍需正常还款；客服热线 95588`,
    receiptData: { card: { id: card.id, name: card.name, tail: card.tail, status: card.status, lost: true }, receiptNo: a.id, at: nowText() },
    auditDetail: `挂失 ${card.name}（尾号 ${card.tail}），卡片已冻结，受理编号 ${a.id}`,
  };
};

/** 跨场景联动：锁定资金 → 下单 → 释放余额 → 建提醒（原子执行） */
EXECUTORS.gift_booking = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId) || s.cards.find((c) => c.kind === 'debit');
  const budget = Number(p.budget);
  const items = Array.isArray(p.items) ? p.items : [];
  if (!card) return { ok: false, error: '付款卡不存在。' };
  if (card.status !== 'active') return { ok: false, error: `付款卡状态为「${card.status}」，无法支付。` };
  if (!(budget > 0) || !items.length) return { ok: false, error: '预订方案不完整。' };
  if (Number(card.available) < budget) return { ok: false, error: `可用余额不足：预算 ${money(budget)}，可用 ${money(card.available)}。` };

  const total = round2(items.reduce((x, it) => x + Number(it.price), 0));
  if (total > budget) return { ok: false, error: `方案合计 ${money(total)} 超出预算 ${money(budget)}。` };

  if (!Array.isArray(s.frozenFunds)) s.frozenFunds = [];
  if (!Array.isArray(s.bookings)) s.bookings = [];

  // 1) 锁定资金
  card.available = Number((card.available - budget).toFixed(2));
  const lockId = `FF${String(s.frozenFunds.length + 1).padStart(4, '0')}`;
  const lock = {
    id: lockId, cardId: card.id, cardTail: card.tail, amount: budget, used: total,
    purpose: `${p.occasion}·${p.recipient}`, at: nowText(), status: 'locked', actionId: a.id,
  };
  s.frozenFunds.push(lock);

  // 2) 逐笔下单（真实扣减余额）
  const booked = [];
  for (const it of items) {
    card.balance = Number((card.balance - Number(it.price)).toFixed(2));
    const bk = {
      id: `BK${String(s.bookings.length + 1).padStart(4, '0')}`,
      serviceId: it.id, type: it.type, name: it.name, price: Number(it.price),
      deliveryDate: p.deliveryDate, deliveryWindow: p.deliveryWindow,
      recipient: p.recipient, recipientName: p.recipientName, occasion: p.occasion,
      status: 'confirmed', at: nowText(), lockId, actionId: a.id,
      orderNo: `SO${Date.now().toString().slice(-8)}${s.bookings.length + 1}`,
    };
    s.bookings.push(bk);
    booked.push(bk);

    const txnId = `T${String(s.transactions.length + 1).padStart(5, '0')}${Math.floor(Math.random() * 90 + 10)}`;
    s.transactions.unshift({
      id: txnId, cardId: card.id, ts: nowText(), timestamp: Date.now(),
      direction: 'out', amount: Number(it.price), merchant: `${it.type}·${it.name}`,
      category: '生活服务', city: s.user.city, channel: 'AI副驾·跨场景', anomaly: null, remark: `${p.occasion}礼物`,
    });
  }

  // 3) 释放未用完的预算
  const left = round2(budget - total);
  card.available = Number((card.available + left).toFixed(2));
  lock.status = 'settled';
  lock.settledAt = nowText();
  lock.released = left;

  // 4) 建提醒（提前一天确认配送）
  if (!Array.isArray(s.reminders)) s.reminders = [];
  const remindAt = p.deliveryDate ? new Date(new Date(p.deliveryDate + 'T09:00:00+08:00').getTime() - 86400000).toISOString().slice(0, 10) : null;
  const reminder = {
    id: `RM${String(s.reminders.length + 1).padStart(4, '0')}`,
    at: remindAt, text: `${p.occasion}提醒：确认 ${p.recipientName}（${p.recipient}）的 ${booked.map((b) => b.type).join('+')} 配送信息`,
    createdAt: nowText(), related: booked.map((b) => b.id),
  };
  s.reminders.push(reminder);

  // 5) 草稿归位
  if (s.giftDraft && s.giftDraft.id === p.draftId) {
    s.giftDraft.stage = 'done';
    s.giftDraft.doneAt = nowText();
  }
  store.save(true);

  const names = booked.map((b) => `${b.name} ${money(b.price)}`).join('；');
  return {
    ok: true,
    receipt: `已完成 ${p.occasion}安排：锁定预算 ${money(budget)} → 下单 ${booked.length} 笔（${names}）共 ${money(total)} → 释放剩余 ${money(left)}；送达时间 ${p.deliveryDate} ${p.deliveryWindow}；已生提醒 ${reminder.at}；订单号 ${booked.map((b) => b.orderNo).join('、')}`,
    receiptData: { bookings: booked, locked: { id: lockId, amount: budget, used: total, released: left }, reminder, card: { id: card.id, name: card.name, tail: card.tail, balance: card.balance, available: card.available } },
    auditDetail: `${p.occasion}安排：锁定 ${money(budget)}、下单 ${booked.length} 笔共 ${money(total)}、释放 ${money(left)}，送达 ${p.deliveryDate}`, 
  };
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ---- 新增：密码修改 / 解挂 / 虚拟卡（赛题点名） ---- */
EXECUTORS.password_change = (a, input = {}) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId);
  if (!card) return { ok: false, error: '卡片不存在。' };
  const pwd = input.values && input.values.newPassword ? String(input.values.newPassword) : '';
  if (!/^\d{6}$/.test(pwd)) return { ok: false, error: '新交易密码必须为 6 位数字（在确认卡片中设置）。' };
  // 沙箱：不保存密码明文，仅记录修改事件与长度
  card.passwordUpdatedAt = nowText();
  card.passwordDigits = 6;
  store.save(true);
  return {
    ok: true,
    receipt: `密码修改成功：${card.name}（尾号 ${card.tail}）交易密码已更新（6 位），生效时间 ${nowText()}；沙箱环境**不保存密码明文**，仅记录修改事件与位数`,
    receiptData: { card: { id: card.id, name: card.name, tail: card.tail, passwordUpdatedAt: card.passwordUpdatedAt } },
    auditDetail: `修改 ${card.name}（尾号 ${card.tail}）交易密码（多因子：短信验证码 + 人脸识别）`,
  };
};

EXECUTORS.card_unfreeze = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId);
  if (!card) return { ok: false, error: '卡片不存在。' };
  if (card.status === 'active' && !card.lost) return { ok: false, error: '该卡当前状态正常，无需解挂。' };
  card.status = 'active';
  card.lost = false;
  card.frozenReason = null;
  card.unfrozenAt = nowText();
  store.save(true);
  return {
    ok: true,
    receipt: `解挂成功：${card.name}（尾号 ${card.tail}）已恢复正常交易，单笔限额 ${money(card.singleLimit)}；解挂已记录受理编号 ${a.id}，建议尽快更换卡片以确保用卡安全`,
    receiptData: { card: { id: card.id, name: card.name, tail: card.tail, status: card.status, lost: false }, receiptNo: a.id },
    auditDetail: `解挂 ${card.name}（尾号 ${card.tail}）（多因子确认）`,
  };
};

/** 虚拟卡申请：即时发卡（黄色级别，赛题点名） */
EXECUTORS.virtual_card = (a) => {
  const s = ensureState();
  if (!Array.isArray(s.cards)) s.cards = [];
  const n = s.cards.filter((c) => c.kind === 'virtual').length + 1;
  const tail = String(Math.floor(1000 + Math.random() * 9000));
  const card = {
    id: `CARD_V${n}`, kind: 'virtual', name: `银枢虚拟卡·${n}`, brand: '银联', level: '虚拟卡',
    numberMasked: `6288 **** **** ${tail}`, tail, currency: 'CNY',
    creditLimit: 5000, usedCredit: 0, available: 5000, status: 'active',
    singleLimit: 2000, dailyLimit: 5000, color: 'teal', issuedAt: nowText(), virtual: true,
    note: '虚拟卡可随时冻结/解冻，适合线上支付',
  };
  s.cards.push(card);
  store.save(true);
  return {
    ok: true,
    receipt: `虚拟卡已开通：${card.numberMasked}，额度 ${money(card.creditLimit)}（单笔 ${money(card.singleLimit)} / 日累计 ${money(card.dailyLimit)}），已自动绑定到你的账户；可随时冻结或解冻`,
    receiptData: { card: { id: card.id, name: card.name, tail: card.tail, creditLimit: card.creditLimit, available: card.available, status: card.status, virtual: true } },
    auditDetail: `开通虚拟卡 ${card.numberMasked}，额度 ${money(card.creditLimit)}`,
  };
};

/** 将决策链路回填到已创建的动作上（供执行时写入审计） */
function attachChain(id, chain) {
  const a = getAction(id);
  if (!a || !chain) return null;
  a.decisionChain = chain;
  store.save(true);
  return a;
}

/** 跨场景联动（赛题语义）：第一步只锁定资金 + 创建预约，生日前 2 天再自动下单 */
EXECUTORS.gift_lock = (a) => {
  const s = ensureState();
  const p = a.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId) || s.cards.find((c) => c.kind === 'debit');
  const budget = Number(p.budget);
  if (!card) return { ok: false, error: '付款卡不存在。' };
  if (card.status !== 'active') return { ok: false, error: `付款卡状态为「${card.status}」，无法锁定资金。` };
  if (!(budget > 0)) return { ok: false, error: '预算无效。' };
  if (Number(card.available) < budget) return { ok: false, error: `可用余额不足：预算 ${money(budget)}，可用 ${money(card.available)}。` };

  if (!Array.isArray(s.frozenFunds)) s.frozenFunds = [];
  if (!Array.isArray(s.scheduledTasks)) s.scheduledTasks = [];

  card.available = Number((card.available - budget).toFixed(2));
  const lockId = `FF${String(s.frozenFunds.length + 1).padStart(4, '0')}`;
  s.frozenFunds.push({
    id: lockId, cardId: card.id, cardTail: card.tail, amount: budget, used: 0,
    purpose: `${p.occasion}·${p.recipient}`, at: nowText(), status: 'locked', actionId: a.id,
  });

  const executeAt = p.executeAt || null;
  const task = {
    id: `ST${String(s.scheduledTasks.length + 1).padStart(4, '0')}`,
    type: 'gift_fulfill', executeAt, eventDate: p.eventDate, status: 'scheduled',
    createdAt: nowText(), lockId, actionId: a.id,
    payload: {
      budget, items: p.items, total: p.total, leftover: p.leftover,
      deliveryWindow: p.deliveryWindow, recipient: p.recipient, recipientName: p.recipientName,
      occasion: p.occasion, cardId: card.id,
    },
  };
  s.scheduledTasks.push(task);
  if (s.giftDraft && s.giftDraft.id === p.draftId) { s.giftDraft.stage = 'locked'; s.giftDraft.lockId = lockId; }
  store.save(true);
  return {
    ok: true,
    receipt: `已锁定资金：${money(budget)}（从 ${card.name} 尾号 ${card.tail} 活期可用中冻结，当前可用 ${money(card.available)}）；预约下单时间 **${executeAt}**（${p.eventDate} 生日前 2 天），到时自动下单：${(p.items || []).map((i) => i.name).join(' + ')} 共 ${money(p.total)}，剩余 ${money(p.leftover)} 将自动释放`,
    receiptData: { locked: { id: lockId, amount: budget }, task: { id: task.id, executeAt }, card: { id: card.id, name: card.name, tail: card.tail, available: card.available } },
    revertInfo: { kind: 'gift_lock', taskId: task.id, lockId },
    auditDetail: `锁定 ${money(budget)} 并预约 ${executeAt} 下单（${p.occasion}·${p.recipient}）`,
  };
};

/** 预约到期执行（沙箱由 /api/sandbox/tick 或对话触发）：逐笔下单 + 释放剩余 + 建提醒 */
function fulfillGiftTask(task, s) {
  const p = task.payload || {};
  const card = s.cards.find((c) => c.id === p.cardId) || s.cards.find((c) => c.kind === 'debit');
  const lock = (s.frozenFunds || []).find((f) => f.id === task.lockId);
  if (!card) return { ok: false, error: '付款卡不存在。' };
  if (!lock || lock.status !== 'locked') return { ok: false, error: '锁定资金不存在或已结算。' };

  const total = round2((p.items || []).reduce((x, it) => x + Number(it.price), 0));
  if (Number(lock.amount) < total) return { ok: false, error: '锁定金额不足以支付方案。' };

  const booked = [];
  for (const it of p.items || []) {
    card.balance = Number((card.balance - Number(it.price)).toFixed(2));
    const bk = {
      id: `BK${String((s.bookings || []).length + 1).padStart(4, '0')}`,
      serviceId: it.id, type: it.type, name: it.name, price: Number(it.price),
      deliveryDate: task.eventDate, deliveryWindow: p.deliveryWindow,
      recipient: p.recipient, recipientName: p.recipientName, occasion: p.occasion,
      status: 'confirmed', at: nowText(), lockId: lock.id, actionId: task.actionId,
      orderNo: `SO${Date.now().toString().slice(-8)}${(s.bookings || []).length + 1}`,
    };
    if (!Array.isArray(s.bookings)) s.bookings = [];
    s.bookings.push(bk);
    booked.push(bk);
    const txnId = `T${String(s.transactions.length + 1).padStart(5, '0')}${Math.floor(Math.random() * 90 + 10)}`;
    s.transactions.unshift({
      id: txnId, cardId: card.id, ts: nowText(), timestamp: Date.now(),
      direction: 'out', amount: Number(it.price), merchant: `${it.type}·${it.name}`,
      category: '生活服务', city: s.user.city, channel: 'AI副驾·跨场景', anomaly: null, remark: `${p.occasion}礼物`,
    });
  }
  const left = round2(Number(lock.amount) - total);
  card.available = Number((card.available + left).toFixed(2));
  lock.used = total; lock.status = 'settled'; lock.settledAt = nowText(); lock.released = left;

  if (!Array.isArray(s.reminders)) s.reminders = [];
  const remindAt = task.eventDate ? new Date(new Date(task.eventDate + 'T09:00:00+08:00').getTime() - 86400000).toISOString().slice(0, 10) : null;
  s.reminders.push({ id: `RM${String(s.reminders.length + 1).padStart(4, '0')}`, at: remindAt, text: `${p.occasion}提醒：确认 ${p.recipientName}（${p.recipient}）的 ${booked.map((b) => b.type).join('+')} 配送信息`, createdAt: nowText(), related: booked.map((b) => b.id) });
  if (s.giftDraft && s.giftDraft.lockId === lock.id) s.giftDraft.stage = 'done';
  return { ok: true, booked, locked: lock, left };
}

/** 执行到期预约任务（沙箱：可手动触发） */
EXECUTORS.gift_fulfill = (a) => {
  const s = ensureState();
  const target = a.payload && a.payload.taskId
    ? (s.scheduledTasks || []).filter((t) => t.id === a.payload.taskId)
    : (s.scheduledTasks || []).filter((t) => t.status === 'scheduled');
  if (!target.length) return { ok: false, error: '没有待执行的预约任务。' };
  const results = [];
  for (const t of target) {
    const r = fulfillGiftTask(t, s);
    if (r.ok) { t.status = 'done'; t.doneAt = nowText(); results.push(r); }
  }
  if (!results.length) return { ok: false, error: '预约任务执行失败（可能锁定资金已结算）。' };
  store.save(true);
  const b = results[0].booked;
  return {
    ok: true,
    receipt: `预约已到期，自动完成下单：${b.map((x) => `${x.name} ${money(x.price)}`).join('；')}（送达 ${b[0].deliveryDate} ${b[0].deliveryWindow}）；锁定资金已结算，释放剩余 ${money(results[0].left)}；已生成配送提醒`,
    receiptData: { bookings: b, locked: { amount: results[0].locked.amount, used: results[0].locked.used, released: results[0].left }, reminder: results.length },
    auditDetail: `预约到期自动下单 ${b.length} 笔，共 ${money(results[0].locked.used)}，释放 ${money(results[0].left)}`,
  };
};

/** 操作回退：按上一笔可回退动作的类型反向恢复 */
EXECUTORS.revert = (a) => {
  const s = ensureState();
  const info = a.payload && a.payload.revertInfo;
  if (!info) return { ok: false, error: '该操作不支持回退。' };
  if (info.kind === 'gift_lock') {
    const lock = (s.frozenFunds || []).find((f) => f.id === info.lockId);
    if (!lock) return { ok: false, error: '未找到对应的锁定资金记录。' };
    const card = s.cards.find((c) => c.id === lock.cardId);
    if (!card) return { ok: false, error: '付款卡不存在。' };
    if (!lock || lock.status !== 'locked') return { ok: false, error: '锁定资金已结算，无法回退。' };
    card.available = Number((card.available + Number(lock.amount)).toFixed(2));
    lock.status = 'released'; lock.releasedAt = nowText();
    const task = (s.scheduledTasks || []).find((t) => t.id === info.taskId);
    if (task) { task.status = 'cancelled'; task.cancelledAt = nowText(); }
    if (s.giftDraft) s.giftDraft.stage = 'done';
    store.save(true);
    return { ok: true, receipt: `已回退：解除锁定 ${money(lock.amount)}并取消预约，当前可用 ${money(card.available)}`, receiptData: { card: { id: card.id, name: card.name, tail: card.tail, available: card.available } }, auditDetail: `回退锁定资金 ${money(lock.amount)}，取消预约 ${info.taskId}` };
  }
  if (info.kind === 'subscription') {
    const sub = s.subscriptions.find((x) => x.id === info.id);
    if (!sub) return { ok: false, error: '订阅不存在。' };
    if ((sub.status || 'active') === 'active') return { ok: false, error: '该订阅已处于生效状态。' };
    sub.status = 'active'; sub.restoredAt = nowText();
    store.save(true);
    return { ok: true, receipt: `已回退：恢复「${sub.merchant}」自动续费，下次扣费日 ${sub.nextChargeDate}`, receiptData: { subscription: sub }, auditDetail: `恢复订阅 ${sub.id}「${sub.merchant}」` };
  }
  if (info.kind === 'card_lock') {
    const card = s.cards.find((c) => c.id === info.cardId);
    if (!card) return { ok: false, error: '卡片不存在。' };
    if (info.action === 'freeze') { card.status = 'active'; card.frozenReason = null; card.unfrozenAt = nowText(); }
    else { card.status = 'frozen'; card.frozenReason = '用户主动限制交易'; }
    store.save(true);
    return { ok: true, receipt: `已回退：${card.name}（尾号 ${card.tail}）当前状态 ${card.status === 'active' ? '正常' : '已冻结'}`, receiptData: { card: { id: card.id, name: card.name, tail: card.tail, status: card.status } }, auditDetail: `回退卡片状态：${card.name}（尾号 ${card.tail}）` };
  }
  if (info.kind === 'limit' || info.kind === 'card_limit') {
    const card = s.cards.find((c) => c.id === info.cardId);
    if (!card) return { ok: false, error: '卡片不存在。' };
    if (info.kind === 'limit') {
      card.creditLimit = Number(info.before.creditLimit);
      card.available = Number((card.creditLimit - Number(card.usedCredit || 0)).toFixed(2));
    } else {
      card.singleLimit = Number(info.before.singleLimit);
      card.dailyLimit = Number(info.before.dailyLimit);
    }
    store.save(true);
    return { ok: true, receipt: `已回退：${card.name}（尾号 ${card.tail}）额度/限额恢复为调整前的值`, receiptData: { card: { id: card.id, name: card.name, tail: card.tail, creditLimit: card.creditLimit, singleLimit: card.singleLimit, dailyLimit: card.dailyLimit } }, auditDetail: `回退 ${info.kind}：${card.name}（尾号 ${card.tail}）` };
  }
  return { ok: false, error: `不支持回退的类型：${info.kind}` };
};

module.exports = {
  createAction, getAction, listPending, recentActions, cancelAction, executeAction, EXECUTORS, attachChain,
};
