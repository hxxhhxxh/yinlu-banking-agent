'use strict';
/**
 * 理财引擎（阶段 4）——风险测评、适当性管理、产品推荐与对比、持仓计算。
 * 适当性判定以产品数据的 suitableFor（白名单）为权威依据，等级比较作为兜底。
 */
const store = require('../store');

const RISK_ORDER = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };
const CLIENT_LEVELS = ['C1', 'C2', 'C3', 'C4', 'C5'];
const LEVEL_NAME = { C1: '保守型', C2: '稳健型', C3: '平衡型', C4: '成长型', C5: '进取型' };
const RISK_NAME = { R1: '低风险', R2: '中低风险', R3: '中风险', R4: '中高风险', R5: '高风险' };
const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 风险测评问卷（5 题，A~E 对应 1~5 分） */
const QUESTIONNAIRE = [
  {
    id: 'Q1', title: '您的年龄区间是？',
    options: [{ k: 'A', t: '60 岁以上', s: 1 }, { k: 'B', t: '50–60 岁', s: 2 }, { k: 'C', t: '35–50 岁', s: 3 }, { k: 'D', t: '25–35 岁', s: 4 }, { k: 'E', t: '18–25 岁', s: 4 }],
  },
  {
    id: 'Q2', title: '您的年收入水平（税前）？',
    options: [{ k: 'A', t: '10 万以下', s: 1 }, { k: 'B', t: '10–20 万', s: 2 }, { k: 'C', t: '20–50 万', s: 3 }, { k: 'D', t: '50–100 万', s: 4 }, { k: 'E', t: '100 万以上', s: 5 }],
  },
  {
    id: 'Q3', title: '这笔投资资金占您可投资资产的比例？',
    options: [{ k: 'A', t: '基本是全部', s: 1 }, { k: 'B', t: '50% 以上', s: 2 }, { k: 'C', t: '30%–50%', s: 3 }, { k: 'D', t: '10%–30%', s: 4 }, { k: 'E', t: '10% 以内', s: 5 }],
  },
  {
    id: 'Q4', title: '您的投资经验？',
    options: [{ k: 'A', t: '只有存款', s: 1 }, { k: 'B', t: '买过货币基金/国债', s: 2 }, { k: 'C', t: '买过债券型/银行理财', s: 3 }, { k: 'D', t: '买过混合基金/股票', s: 4 }, { k: 'E', t: '做过期货/期权等杠杆交易', s: 5 }],
  },
  {
    id: 'Q5', title: '若投资一个月内亏损 20%，您会？',
    options: [{ k: 'A', t: '立即全部赎回', s: 1 }, { k: 'B', t: '赎回大部分', s: 2 }, { k: 'C', t: '继续持有观望', s: 3 }, { k: 'D', t: '小幅加仓', s: 4 }, { k: 'E', t: '大幅加仓', s: 5 }],
  },
];

/** 等级判定：总分 5~25 → C1~C5 */
function scoreToLevel(total) {
  if (total <= 8) return 'C1';
  if (total <= 12) return 'C2';
  if (total <= 16) return 'C3';
  if (total <= 20) return 'C4';
  return 'C5';
}

/** 解析答案：支持 "BCBCB" 或 "1B 2C 3B 4C 5B" */
function parseAnswers(text) {
  const t = String(text || '').toUpperCase();
  const withIndex = [...t.matchAll(/([1-5])\s*[:：]?\s*([A-E])/g)].map((m) => ({ q: Number(m[1]), a: m[2] }));
  if (withIndex.length >= 3) {
    const map = new Map(withIndex.map((x) => [x.q, x.a]));
    return QUESTIONNAIRE.map((q, i) => map.get(i + 1) || null);
  }
  const letters = [...t.replace(/[^A-E]/g, '')];
  if (letters.length >= 3) return Array.from({ length: QUESTIONNAIRE.length }, (_, i) => letters[i] || null);
  return null;
}

/** 用答案算等级 */
function assess(answersIn) {
  const answers = Array.isArray(answersIn) ? answersIn : parseAnswers(answersIn);
  if (!answers || answers.filter(Boolean).length < QUESTIONNAIRE.length) {
    return { ok: false, reason: 'incomplete', questionnaire: QUESTIONNAIRE, answered: answers ? answers.filter(Boolean).length : 0 };
  }
  const detail = QUESTIONNAIRE.map((q, i) => {
    const opt = q.options.find((o) => o.k === String(answers[i]).toUpperCase());
    return { id: q.id, question: q.title, answer: opt ? opt.k : null, answerText: opt ? opt.t : null, score: opt ? opt.s : null };
  });
  const total = detail.reduce((a, x) => a + (x.score || 0), 0);
  const level = scoreToLevel(total);
  return { ok: true, total, min: QUESTIONNAIRE.length, max: QUESTIONNAIRE.length * 5, level, levelName: LEVEL_NAME[level], detail };
}

/** 保存测评结果到用户 */
function saveAssessment(result) {
  const s = store.get();
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  s.user.riskLevel = result.level;
  s.user.riskLevelName = result.levelName;
  s.user.riskAssessedAt = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  s.user.riskScore = result.total;
  s.user.riskValidUntil = `${today.getFullYear() + 1}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  store.save(true);
  store.addAudit({
    action: 'assess_risk', category: 'wealth', riskLevel: 'low', result: 'success',
    detail: `风险测评完成：得分 ${result.total}/${result.max} → ${result.level}（${result.levelName}）`,
    request: '风险测评', reason: '理财推荐前必须完成风险测评',
  });
  return s.user;
}

/** 测评是否有效（一年有效） */
function assessmentStatus(user, now = new Date('2026-09-22T12:00:00+08:00')) {
  const at = user.riskAssessedAt ? new Date(user.riskAssessedAt) : null;
  if (!at || isNaN(at.getTime())) return { valid: false, reason: 'missing', message: '你还未做过风险测评' };
  const days = Math.floor((now - at) / 86400000);
  if (days > 365) return { valid: false, reason: 'expired', days, message: `你的风险测评已过期（${user.riskAssessedAt} 完成，已 ${days} 天）` };
  return { valid: true, days, message: `测评有效（${user.riskAssessedAt} 完成）` };
}

/** 单个产品是否与用户等级匹配 */
function isSuitable(userLevel, product) {
  if (Array.isArray(product.suitableFor) && product.suitableFor.length) return product.suitableFor.includes(userLevel);
  return (RISK_ORDER[userLevel] || 0) >= (RISK_ORDER[product.riskLevel] || 99);
}

/**
 * 推荐与对比。
 * 返回 { suitable, blocked, user, disclosure }
 */
function recommend(opts = {}) {
  const s = store.get();
  const user = s.user;
  const st = assessmentStatus(user, opts.now);
  const products = s.products.map((p) => ({
    ...p, suitable: isSuitable(user.riskLevel, p),
    riskName: RISK_NAME[p.riskLevel] || p.riskName,
    yearlyInterestPer10k: round2((p.expectedReturn / 100) * 10000),
  }));
  const suitable = products.filter((p) => p.suitable).sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel] || b.expectedReturn - a.expectedReturn);
  const blocked = products.filter((p) => !p.suitable).sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);

  const compareFields = ['name', 'type', 'riskLevel', 'expectedReturn', 'term', 'minAmount', 'liquidity'];
  const compare = suitable.map((p) => {
    const row = {};
    for (const f of compareFields) row[f] = p[f];
    return row;
  });

  return {
    assessment: st,
    user: { riskLevel: user.riskLevel, riskLevelName: user.riskLevelName, riskAssessedAt: user.riskAssessedAt, riskValidUntil: user.riskValidUntil || null },
    suitable, blocked, compare,
    suitableCount: suitable.length, blockedCount: blocked.length,
    disclosure: `理财非存款，产品有风险，投资须谨慎。理财产品的风险等级不得高于您的风险承受能力等级（当前 ${user.riskLevel} ${user.riskLevelName}）。`,
  };
}

/** 持仓与收益（沙箱按持有天数估算浮动收益） */
function portfolio(now = new Date('2026-09-22T12:00:00+08:00')) {
  const s = store.get();
  const holdings = (Array.isArray(s.holdings) ? s.holdings : []).map((h) => {
    const days = Math.max(0, Math.floor((now - new Date(h.purchasedAt)) / 86400000));
    const est = round2((h.amount * (h.expectedReturn / 100) * days) / 365);
    return { ...h, holdingDays: days, estimatedReturn: est, currentValue: round2(h.amount + est) };
  });
  const totalAmount = round2(holdings.reduce((a, h) => a + h.amount, 0));
  const totalReturn = round2(holdings.reduce((a, h) => a + h.estimatedReturn, 0));
  const byLevel = {};
  for (const h of holdings) byLevel[h.riskLevel] = round2((byLevel[h.riskLevel] || 0) + h.amount);
  return { holdings, totalAmount, totalReturn, totalValue: round2(totalAmount + totalReturn), count: holdings.length, byLevel };
}

module.exports = {
  RISK_ORDER, CLIENT_LEVELS, LEVEL_NAME, RISK_NAME, QUESTIONNAIRE,
  parseAnswers, assess, saveAssessment, assessmentStatus, isSuitable, recommend, portfolio, scoreToLevel, money,
};
