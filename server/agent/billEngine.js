'use strict';
/**
 * 账单分析引擎（阶段 3）——全部由真实流水现算，不依赖数据里预埋的标记。
 *
 * 三块能力：
 *  1) analyze()      消费分类统计 + 环比 + 商户榜 + 时段分布 + 月度/年度报告
 *  2) detectAnomalies()  异常交易识别（评分制，可解释）：深夜 / 异地 / 金额突增 / 境外 / 超大额
 *  3) subscriptions()   从流水中自动识别周期性扣费，并与已登记订阅合并、算续费倒计时
 */
const store = require('../store');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const hourOf = (ts) => Number(String(ts).slice(11, 13));

function inRange(t, from, to) {
  if (from && t.timestamp < Date.parse(from)) return false;
  if (to && t.timestamp >= Date.parse(to)) return false;
  return true;
}

/** 按条件取流水 */
function pick(range = {}, category = null) {
  const s = store.get();
  return s.transactions.filter((t) => inRange(t, range.from, range.to) && (!category || t.category === category));
}

function prevRange(range) {
  if (!range.from || !range.to) return {};
  const f = Date.parse(range.from), t = Date.parse(range.to);
  const span = t - f;
  return { from: new Date(f - span).toISOString(), to: new Date(f).toISOString() };
}

/* ============================== 1) 账单分析 ============================== */
function analyze(opts = {}) {
  const { range = {}, category = null, keyword = null } = opts;
  let txns = pick(range, category);
  if (keyword) txns = txns.filter((t) => (t.merchant + t.category + (t.remark || '')).includes(keyword));

  const outs = txns.filter((t) => t.direction === 'out');
  const ins = txns.filter((t) => t.direction === 'in');
  const totalOut = round2(outs.reduce((a, t) => a + t.amount, 0));
  const totalIn = round2(ins.reduce((a, t) => a + t.amount, 0));

  const catMap = new Map();
  for (const t of outs) {
    const cur = catMap.get(t.category) || { category: t.category, amount: 0, count: 0 };
    cur.amount += t.amount; cur.count++;
    catMap.set(t.category, cur);
  }
  const byCategory = Array.from(catMap.values())
    .map((x) => ({ ...x, amount: round2(x.amount), share: totalOut ? round2((x.amount / totalOut) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount);

  const monMap = new Map();
  for (const t of txns) {
    const m = String(t.ts).slice(0, 7);
    const cur = monMap.get(m) || { month: m, out: 0, in: 0, count: 0 };
    if (t.direction === 'out') cur.out += t.amount; else cur.in += t.amount;
    cur.count++;
    monMap.set(m, cur);
  }
  const byMonth = Array.from(monMap.values()).sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((x) => ({ month: x.month, out: round2(x.out), in: round2(x.in), count: x.count }));

  const merMap = new Map();
  for (const t of outs) {
    const cur = merMap.get(t.merchant) || { merchant: t.merchant, amount: 0, count: 0, category: t.category };
    cur.amount += t.amount; cur.count++;
    merMap.set(t.merchant, cur);
  }
  const topMerchants = Array.from(merMap.values()).map((x) => ({ ...x, amount: round2(x.amount) }))
    .sort((a, b) => b.amount - a.amount).slice(0, 8);

  const hourBuckets = [
    { label: '凌晨(0-6)', from: 0, to: 5 }, { label: '上午(6-11)', from: 6, to: 11 },
    { label: '下午(12-17)', from: 12, to: 17 }, { label: '夜间(18-23)', from: 18, to: 23 },
  ].map((b) => {
    const list = outs.filter((t) => { const h = hourOf(t.ts); return h >= b.from && h <= b.to; });
    return { label: b.label, amount: round2(list.reduce((a, t) => a + t.amount, 0)), count: list.length };
  });

  // 环比
  const pr = prevRange(range);
  const prevOuts = Object.keys(pr).length ? pick(pr, category).filter((t) => t.direction === 'out') : [];
  const prevTotalOut = round2(prevOuts.reduce((a, t) => a + t.amount, 0));
  const delta = prevTotalOut ? round2(((totalOut - prevTotalOut) / prevTotalOut) * 100) : null;

  const months = byMonth.length;
  const biggest = outs.length ? outs.reduce((a, b) => (b.amount > a.amount ? b : a)) : null;

  return {
    range: { from: range.from || null, to: range.to || null, months },
    category, keyword,
    txnCount: txns.length,
    outCount: outs.length,
    inCount: ins.length,
    totalOut, totalIn,
    monthlyAvgOut: months ? round2(totalOut / months) : 0,
    prevTotalOut, delta,
    avgPerTxn: outs.length ? round2(totalOut / outs.length) : 0,
    byCategory, byMonth, topMerchants, hourBuckets,
    biggest: biggest ? { merchant: biggest.merchant, amount: biggest.amount, ts: biggest.ts, category: biggest.category } : null,
    topCategory: byCategory[0] || null,
  };
}

/** 年度报告 */
function yearlyReport(year) {
  const y = Number(year) || new Date().getFullYear();
  const from = new Date(y, 0, 1).toISOString();
  const to = new Date(y + 1, 0, 1).toISOString();
  const a = analyze({ range: { from, to } });
  const peak = a.byMonth.length ? a.byMonth.reduce((x, m) => (m.out > x.out ? m : x)) : null;
  const low = a.byMonth.length ? a.byMonth.reduce((x, m) => (m.out < x.out ? m : x)) : null;
  return {
    year: y, ...a,
    peakMonth: peak, lowMonth: low,
    avgMonthly: a.byMonth.length ? round2(a.totalOut / a.byMonth.length) : 0,
    avgDaily: a.byMonth.length ? round2(a.totalOut / a.byMonth.length / 30) : 0,
  };
}

/* ============================== 2) 异常交易识别 ============================== */
/**
 * 评分制异常识别（每条都会给出可核对的证据）。
 * 分值越高越可疑；>= FLAG_SCORE 判为异常。
 */
const FLAG_SCORE = 40;

function detectAnomalies(opts = {}) {
  const { range = {}, minScore = FLAG_SCORE, limit = 10 } = opts;
  const s = store.get();
  const home = s.user.city;
  const all = pick(range).filter((t) => t.direction === 'out');

  // 分类中位数（用于"金额突增"判定）
  const catAmounts = new Map();
  for (const t of all) {
    const list = catAmounts.get(t.category) || [];
    list.push(t.amount);
    catAmounts.set(t.category, list);
  }
  const catMedian = new Map();
  for (const [c, list] of catAmounts) catMedian.set(c, median(list));

  const found = [];
  for (const t of all) {
    const score = [];
    let total = 0;
    const hour = hourOf(t.ts);

    // A1 深夜大额（23:00–06:00）
    if (hour >= 23 || hour <= 5) {
      if (t.amount >= 1000) { total += 30; score.push(`发生在 ${String(t.ts).slice(11, 16)}（深夜时段）且金额 ${money(t.amount)} ≥ ¥1,000`); }
      else if (t.amount >= 300) { total += 15; score.push(`发生在 ${String(t.ts).slice(11, 16)}（深夜时段）`); }
    }
    // A2 异地交易
    const away = t.city && t.city !== home;
    if (away) {
      if (t.city === '境外') { total += 20; score.push(`交易地点为境外`); }
      else if (t.amount >= 1000) { total += 25; score.push(`交易地点 ${t.city}，距常用地 ${home} 较远且金额 ${money(t.amount)} ≥ ¥1,000`); }
      else if (t.amount >= 300) { total += 10; score.push(`交易地点 ${t.city}（非常用地）`); }
    }
    // A3 金额突增（相对同分类中位数）
    const med = catMedian.get(t.category) || 0;
    if (med > 0 && t.amount >= med * 5 && t.amount >= 500) {
      total += 35;
      score.push(`单笔 ${money(t.amount)}，为「${t.category}」分类中位数 ${money(med)} 的 ${(t.amount / med).toFixed(1)} 倍`);
    }
    // A4 超大额
    if (t.amount >= 10000) { total += 10; score.push(`单笔金额 ${money(t.amount)} ≥ ¥10,000`); }

    if (total >= minScore) {
      const type = (hour >= 23 || hour <= 5) ? '深夜大额'
        : (t.city === '境外' ? '境外交易'
          : (away && t.amount >= 1000 ? '异地交易' : (t.amount >= (catMedian.get(t.category) || 0) * 5 ? '金额突增' : '可疑交易')));
      found.push({
        id: t.id, ts: t.ts, merchant: t.merchant, amount: t.amount, category: t.category,
        city: t.city, cardId: t.cardId, channel: t.channel,
        score: total, type, level: total >= 55 ? 'high' : 'medium',
        evidence: score, reason: score.join('；'),
        seeded: t.anomaly ? t.anomaly.type : null,
      });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return {
    scanned: all.length,
    flagged: found.length,
    home,
    minScore,
    list: found.slice(0, limit),
    all: found,
  };
}

/* ============================== 3) 订阅 / 代扣 ============================== */
/** 从流水中自动识别周期性扣费 */
function detectRecurring() {
  const s = store.get();
  const map = new Map();
  for (const t of s.transactions) {
    if (t.direction !== 'out') continue;
    const key = t.merchant;
    const cur = map.get(key) || { merchant: key, amounts: [], dates: [], category: t.category, cardId: t.cardId, channel: t.channel };
    cur.amounts.push(t.amount);
    cur.dates.push(t.timestamp);
    map.set(key, cur);
  }
  const out = [];
  for (const g of map.values()) {
    if (g.dates.length < 3) continue;                       // 至少出现 3 次
    const dates = [...g.dates].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const stableGap = gaps.every((x) => Math.abs(x - avgGap) <= 5);
    const amt = g.amounts[0];
    const stableAmt = g.amounts.every((x) => Math.abs(x - amt) < 0.01);
    if (stableGap && stableAmt && avgGap >= 25 && avgGap <= 35) {
      out.push({
        merchant: g.merchant, amount: amt, cycle: 'monthly', cycleLabel: '每月',
        occurrences: g.amounts.length, avgGapDays: avgGap,
        lastAt: new Date(dates[dates.length - 1]).toISOString().slice(0, 10),
        nextAt: new Date(dates[dates.length - 1] + avgGap * 86400000).toISOString().slice(0, 10),
        category: g.category, cardId: g.cardId, channel: g.channel,
        evidence: `近 ${g.amounts.length} 次扣费金额均为 ${money(amt)}，间隔约 ${Math.round(avgGap)} 天`,
        totalPaid: round2(amt * g.amounts.length),
      });
    }
  }
  return out.sort((a, b) => b.totalPaid - a.totalPaid);
}

const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

/** 订阅全景：已登记订阅（权威）+ 自动识别结果 + 续费倒计时 */
function subscriptions(opts = {}) {
  const { today = new Date('2026-09-22T12:00:00+08:00'), soonDays = 7 } = opts;
  const todayStr = new Date(today).toISOString().slice(0, 10);
  const s = store.get();
  const detected = detectRecurring();
  const detectedByMerchant = new Map(detected.map((d) => [d.merchant, d]));

  const items = s.subscriptions.map((sub) => {
    const d = detectedByMerchant.get(sub.merchant) || null;
    const daysLeft = sub.nextChargeDate ? daysBetween(sub.nextChargeDate, todayStr) : null;
    return {
      id: sub.id, merchant: sub.merchant, amount: sub.amount, cycle: sub.cycle,
      cycleLabel: sub.cycle === 'monthly' ? '每月' : '每年',
      category: sub.category, cardId: sub.cardId, payChannel: sub.payChannel,
      nextChargeDate: sub.nextChargeDate, daysLeft,
      status: sub.status || 'active', cancellable: sub.cancellable !== false,
      startedAt: sub.startedAt, note: sub.note || null,
      autoDetected: Boolean(d), detectedEvidence: d ? d.evidence : null,
      recurringScore: d ? d.occurrences : 0,
      yearlyCost: round2(sub.cycle === 'monthly' ? sub.amount * 12 : sub.amount),
    };
  }).filter((x) => !opts.activeOnly || x.status === 'active');

  const undetectedInLedger = detected.filter((d) => !s.subscriptions.some((sub) => sub.merchant === d.merchant));
  const upcoming = items
    .filter((x) => x.status === 'active' && x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= soonDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const activeItems = items.filter((x) => x.status === 'active');

  return {
    today: todayStr,
    items,
    activeCount: activeItems.length,
    monthlyTotal: round2(activeItems.filter((x) => x.cycle === 'monthly').reduce((a, x) => a + x.amount, 0)),
    yearlyTotal: round2(activeItems.reduce((a, x) => a + x.yearlyCost, 0)),
    detected,
    detectedCount: detected.length,
    undetectedInLedger,
    upcoming,
    soonDays,
  };
}

module.exports = { analyze, yearlyReport, detectAnomalies, detectRecurring, subscriptions, FLAG_SCORE, money };
