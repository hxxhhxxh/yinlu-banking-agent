'use strict';
/**
 * 跨场景联动引擎（阶段 5）——把"一句话表达的意图"拆成可执行的服务预订方案。
 *
 * 链路：听懂（谁/什么日子/预算/想要什么）→ 主动补问缺失信息 → 锁定资金 → 下单 → 生成提醒
 * 100% 本地沙箱：服务目录来自本地数据，不接任何真实商户。
 */
const store = require('../store');
const { SERVICES } = require('../data/mockdata');

const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const catalog = () => {
  const s = store.get();
  return Array.isArray(s.services) && s.services.length ? s.services : SERVICES;
};

/** 关系/场合识别 */
function detectRecipient(text) {
  const t = String(text || '');
  const map = [
    [/(我)?妈|母亲|妈妈/, '妈妈', '王丽华'],
    [/(我)?爸|父亲|爸爸/, '爸爸', '黄建国'],
    [/老婆|妻子|爱人/, '爱人', '—'],
    [/老公|丈夫/, '爱人', '—'],
    [/女朋友/, '女朋友', '—'],
    [/男朋友/, '男朋友', '—'],
    [/室友/, '室友', '李皓阳'],
  ];
  for (const [re, label, name] of map) if (re.test(t)) return { label, name };
  return { label: '家人', name: '—' };
}

function detectOccasion(text) {
  const t = String(text || '');
  if (/生日/.test(t)) return '生日';
  if (/母亲节/.test(t)) return '母亲节';
  if (/父亲节/.test(t)) return '父亲节';
  if (/纪念日/.test(t)) return '纪念日';
  if (/节日|过节/.test(t)) return '节日';
  return '生日';
}

/** 想要什么：鲜花 / 蛋糕 / 都要 */
function detectWants(text) {
  const t = String(text || '');
  const hasFlower = /花|鲜花|玫瑰|郁金香|向日葵/.test(t);
  const hasCake = /蛋糕|糕|慕斯/.test(t);
  if (hasFlower && hasCake) return 'both';
  if (hasFlower) return 'flower';
  if (hasCake) return 'cake';
  return null;
}

/**
 * 在预算内挑选方案：优先"价值最大化但不超预算"。
 * @returns {{ok:boolean, items?:Array, total?:number, leftover?:number, reason?:string, cheapest?:number}}
 */
function planGift(budget, wants) {
  const list = catalog();
  const flowers = list.filter((x) => x.type === '鲜花').sort((a, b) => b.price - a.price);
  const cakes = list.filter((x) => x.type === '蛋糕').sort((a, b) => b.price - a.price);
  const B = Number(budget);
  const mode = wants || 'both';

  if (!(B > 0)) return { ok: false, reason: 'no_budget' };

  if (mode === 'flower') {
    const pick = flowers.find((f) => f.price <= B);
    if (!pick) return { ok: false, reason: 'over_budget', cheapest: Math.min(...flowers.map((f) => f.price)) };
    return { ok: true, items: [pick], total: pick.price, leftover: round2(B - pick.price) };
  }
  if (mode === 'cake') {
    const pick = cakes.find((c) => c.price <= B);
    if (!pick) return { ok: false, reason: 'over_budget', cheapest: Math.min(...cakes.map((c) => c.price)) };
    return { ok: true, items: [pick], total: pick.price, leftover: round2(B - pick.price) };
  }

  // 都要：在预算内挑总价最高的组合
  let best = null;
  for (const f of flowers) {
    for (const c of cakes) {
      const sum = f.price + c.price;
      if (sum <= B && (!best || sum > best.total)) best = { items: [f, c], total: sum, leftover: round2(B - sum) };
    }
  }
  if (!best) {
    const cheapest = Math.min(...flowers.map((f) => f.price)) + Math.min(...cakes.map((c) => c.price));
    return { ok: false, reason: 'over_budget', cheapest };
  }
  return { ok: true, ...best };
}

/** 送达时间：活动当天上午（若活动日已过或太近则顺延） */
function deliveryPlan(dateStr, now = new Date('2026-09-22T12:00:00+08:00')) {
  const today = new Date(now);
  const target = dateStr ? new Date(dateStr + 'T09:00:00+08:00') : null;
  const feasible = target && (target - today) / 86400000 >= 1;
  return {
    date: feasible ? dateStr : null,
    window: '上午 09:00–12:00',
    leadDays: feasible ? Math.round((target - today) / 86400000) : null,
    note: feasible ? `需提前 1 天下单，当前距活动日还有 ${Math.round((target - today) / 86400000)} 天` : '活动日过近或缺失，需重新确认日期',
    feasible,
  };
}

const nlu = require('./nlu');

/**
 * 只从"像金额的说法"里取预算，避免把"帮我安排一下"的"一"当成 1 元。
 * 必须带金额标记（元/块/左右/以内/万/千）或前面有"预算/大概"等引导词。
 */
function parseBudget(text) {
  const t = String(text || '');
  const m = t.match(/((?:\d+(?:\.\d+)?)|[零一二两三四五六七八九十百千万]+)\s*(万|千|元|块|块钱|左右|以内|上下|出头)/);
  if (m) return nlu.parseAmount(m[0]);
  const m2 = t.match(/(?:预算|大概|大约|约|差不多|不超过)\s*((?:\d+(?:\.\d+)?)|[零一二两三四五六七八九十百千万]+)/);
  if (m2) return nlu.parseAmount(m2[1]);
  return null;
}

module.exports = { catalog, detectRecipient, detectOccasion, detectWants, planGift, deliveryPlan, parseBudget, money };
