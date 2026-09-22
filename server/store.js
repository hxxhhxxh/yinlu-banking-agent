'use strict';
/**
 * 状态仓库：内存态 + 落盘（data/runtime-state.json），支持一键重置回演示初始态。
 * 所有变更都必须经过 store.mutate()，以便统一写操作日志（全程留痕）。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { buildSeedState, fmtDateTime } = require('./data/mockdata');

let state = null;
let saveTimer = null;
const EPHEMERAL = process.env.YINLU_EPHEMERAL === '1'; // 自测/脚本模式：不落盘，避免污染演示数据

function ensureDir() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function buildFresh() {
  return buildSeedState();
}

function load() {
  ensureDir();
  try {
    if (fs.existsSync(config.STATE_FILE)) {
      const raw = fs.readFileSync(config.STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // 种子不匹配（数据结构升级）时自动重建
      if (parsed && parsed.meta && parsed.meta.seed === 20260922 && Array.isArray(parsed.transactions)) {
        state = parsed;
        syncCounters();
        return state;
      }
    }
  } catch (e) {
    console.warn('[store] 读取运行时状态失败，将重建：', e.message);
  }
  state = buildFresh();
  save(true);
  return state;
}

/** 进程重启后从已落盘数据恢复自增计数，避免审计编号重复 */
function syncCounters() {
  auditSeq = 0;
  if (state && Array.isArray(state.auditLog)) {
    for (const a of state.auditLog) {
      const n = parseInt(String(a.id || '').replace(/^A/, ''), 10);
      if (!isNaN(n) && n > auditSeq) auditSeq = n;
    }
  }
}

function get() {
  if (!state) load();
  return state;
}

function save(immediate = false) {
  if (EPHEMERAL) return;
  if (immediate) {
    ensureDir();
    try {
      fs.writeFileSync(config.STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      console.warn('[store] 落盘失败：', e.message);
    }
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save(true);
  }, 250);
}

function reset() {
  state = buildFresh();
  save(true);
  return state;
}

/* ------------------------------ 便捷查询 ------------------------------ */
const byId = (arr, id) => arr.find((x) => x.id === id) || null;

function findCard(id) { return byId(get().cards, id); }
function findPayee(id) { return byId(get().payees, id); }
function findProduct(id) { return byId(get().products, id); }
function findSubscription(id) { return byId(get().subscriptions, id); }

/** 按姓名 / 昵称 / 手机号尾号 / 备注模糊查收款人 */
function findPayeeByText(text) {
  if (!text) return null;
  const t = String(text).trim();
  const all = get().payees;
  let hit = all.find((p) => p.name === t || p.nickname === t);
  if (hit) return hit;
  hit = all.find((p) => t.includes(p.name) || t.includes(p.nickname));
  if (hit) return hit;
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 4) {
    hit = all.find((p) => p.phone.replace(/\D/g, '').endsWith(digits) || p.accountMasked.replace(/\D/g, '').endsWith(digits));
  }
  return hit || null;
}

/* ------------------------------ 审计日志（全程留痕） ------------------------------ */
let auditSeq = 0;
function addAudit(entry) {
  const s = get();
  auditSeq += 1;
  const rec = {
    id: `A${String(auditSeq).padStart(6, '0')}`,
    at: fmtDateTime(new Date()),
    actor: 'AI副驾',
    ...entry,
  };
  s.auditLog.push(rec);
  if (s.auditLog.length > 2000) s.auditLog.splice(0, s.auditLog.length - 2000);
  save(true); // 审计日志立即落盘：留痕不允许因防抖而丢失
  return rec;
}

function auditTail(n = 50) {
  const s = get();
  return s.auditLog.slice(-n).reverse();
}

/* ------------------------------ 对话记录（刷新后仍保留） ------------------------------ */
function appendConversation(role, text, meta) {
  const s = get();
  if (!Array.isArray(s.conversation)) s.conversation = [];
  s.conversation.push({ role, text: String(text == null ? '' : text).slice(0, 4000), at: fmtDateTime(new Date()), ...(meta || {}) });
  if (s.conversation.length > 60) s.conversation.splice(0, s.conversation.length - 60);
  save(true); // 立即落盘：刷新/重启后能恢复对话
}

function clearConversation() {
  const s = get();
  s.conversation = [];
  save(true);
}

/* ------------------------------ 账单统计（全部由真实流水现算） ------------------------------ */
function billStats() {
  const s = get();
  const outs = s.transactions.filter((t) => t.direction === 'out');

  const catMap = new Map();
  for (const t of outs) {
    const cur = catMap.get(t.category) || { category: t.category, amount: 0, count: 0 };
    cur.amount += t.amount; cur.count += 1;
    catMap.set(t.category, cur);
  }
  const byCategory = Array.from(catMap.values())
    .map((x) => ({ ...x, amount: Number(x.amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);

  const monMap = new Map();
  for (const t of s.transactions) {
    const m = t.ts.slice(0, 7);
    const cur = monMap.get(m) || { month: m, out: 0, in: 0 };
    if (t.direction === 'out') cur.out += t.amount; else cur.in += t.amount;
    monMap.set(m, cur);
  }
  const byMonth = Array.from(monMap.values())
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((x) => ({ month: x.month, out: Number(x.out.toFixed(2)), in: Number(x.in.toFixed(2)) }));

  const merMap = new Map();
  for (const t of outs) {
    const cur = merMap.get(t.merchant) || { merchant: t.merchant, amount: 0, count: 0 };
    cur.amount += t.amount; cur.count += 1;
    merMap.set(t.merchant, cur);
  }
  const topMerchants = Array.from(merMap.values())
    .map((x) => ({ ...x, amount: Number(x.amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  const anomalies = s.transactions.filter((t) => t.anomaly).map((t) => ({
    id: t.id, ts: t.ts, merchant: t.merchant, amount: t.amount, city: t.city,
    cardId: t.cardId, category: t.category,
    type: t.anomaly.type, level: t.anomaly.level, reason: t.anomaly.reason,
  }));

  const months = byMonth.length;
  const totalOut = Number(outs.reduce((a, t) => a + t.amount, 0).toFixed(2));
  const totalIn = Number(s.transactions.filter((t) => t.direction === 'in').reduce((a, t) => a + t.amount, 0).toFixed(2));
  const last = byMonth[byMonth.length - 1] || { out: 0 };
  const prev = byMonth[byMonth.length - 2] || { out: 0 };

  return {
    txnCount: s.transactions.length,
    months,
    rangeLabel: byMonth.length ? `${byMonth[0].month} ~ ${byMonth[byMonth.length - 1].month}` : '',
    totalOut,
    totalIn,
    monthlyAvgOut: months ? Number((totalOut / months).toFixed(2)) : 0,
    lastMonthOut: last.out,
    lastMonthDelta: prev.out ? Number((((last.out - prev.out) / prev.out) * 100).toFixed(1)) : 0,
    byCategory,
    byMonth,
    topMerchants,
    anomalyCount: anomalies.length,
    anomalies,
  };
}

/* ------------------------------ 摘要 / 脱敏（给前端与模型） ------------------------------ */
function cardSummary(c) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    tail: c.tail,
    numberMasked: c.numberMasked,
    level: c.level,
    color: c.color,
    status: c.status,
    lost: Boolean(c.lost),
    lostAt: c.lostAt || null,
    frozenReason: c.frozenReason || null,
    frozenAt: c.frozenAt || null,
    currency: c.currency,
    balance: c.kind === 'debit' ? c.balance : undefined,
    available: c.available,
    creditLimit: c.creditLimit,
    usedCredit: c.usedCredit,
    dailyLimit: c.dailyLimit,
    singleLimit: c.singleLimit,
    billDay: c.billDay,
    repayDay: c.repayDay,
  };
}

function stateSummary() {
  const s = get();
  return {
    meta: s.meta,
    user: s.user,
    cards: s.cards.map(cardSummary),
    totals: {
      totalAssets: Number(s.cards.filter((c) => c.kind === 'debit').reduce((a, c) => a + c.balance, 0).toFixed(2)),
      totalCreditUsed: Number(s.cards.filter((c) => c.kind === 'credit').reduce((a, c) => a + (c.usedCredit || 0), 0).toFixed(2)),
      totalCreditLimit: s.cards.filter((c) => c.kind === 'credit').reduce((a, c) => a + (c.creditLimit || 0), 0),
      txnCount: s.transactions.length,
      subscriptionMonthly: Number(s.subscriptions.filter((x) => x.cycle === 'monthly').reduce((a, x) => a + x.amount, 0).toFixed(2)),
    },
    recentTransactions: s.transactions.slice(0, 12),
    payees: s.payees,
    products: s.products,
    subscriptions: s.subscriptions,    lastPreflight: s.lastPreflight || null,
    pendingActions: (Array.isArray(s.pendingActions) ? s.pendingActions : []).filter((a) => a.status === 'pending').map((a) => ({
      id: a.id, type: a.type, title: a.title, summary: a.summary, needsSms: a.needsSms,
      tier: a.tier || 'yellow', tierLabel: a.tierLabel || '', tierReason: a.tierReason || '',
      requiredFactors: a.requiredFactors || [], payloadInput: a.payloadInput || null,
      amount: a.payload ? a.payload.amount : null, createdAtText: a.createdAtText, expiresAt: a.expiresAt,
      riskDecision: a.riskDecision, hitRules: a.hitRules,
    })),
    transfers: (Array.isArray(s.transfers) ? s.transfers : []).slice(-10).reverse(),
    holdings: Array.isArray(s.holdings) ? s.holdings : [],
    cardRequests: (Array.isArray(s.cardRequests) ? s.cardRequests : []).slice(-5).reverse(),
    giftDraft: s.giftDraft || null,
    bookings: (Array.isArray(s.bookings) ? s.bookings : []).slice(-6).reverse(),
    frozenFunds: (Array.isArray(s.frozenFunds) ? s.frozenFunds : []).filter((f) => f.status === 'locked'),
    reminders: (Array.isArray(s.reminders) ? s.reminders : []).slice(-5).reverse(),
    scheduledTasks: (Array.isArray(s.scheduledTasks) ? s.scheduledTasks : []).slice(-5).reverse(),
    humanTakeover: s.humanTakeover || null,
    plans: (Array.isArray(s.plans) ? s.plans : []).slice(-5).reverse(),
    aaSplits: (Array.isArray(s.aaSplits) ? s.aaSplits : []).slice(-5).reverse(),
    billStats: billStats(),
    conversation: Array.isArray(s.conversation) ? s.conversation : [],
    auditTail: auditTail(8),
  };
}

module.exports = {
  load, get, save, reset,
  findCard, findPayee, findProduct, findSubscription, findPayeeByText, byId,
  addAudit, auditTail, cardSummary, stateSummary, billStats,
  appendConversation, clearConversation,
};
