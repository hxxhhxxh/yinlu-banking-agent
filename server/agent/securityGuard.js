'use strict';
/**
 * 安全守卫（阶段 7 / 赛题对齐）—— 分级授权 + 注入防御 + 异常熔断 + 决策链路留痕。
 *
 * 对齐赛题「三、核心技术要求」：
 *   1) 权限分级：绿色（自动）/ 黄色（用户确认）/ 红色（多因子强验证）
 *   2) 安全机制：幻觉防护 / 注入防御 / 操作审计 / 异常熔断 / 沙箱
 *   3) 任务规划：DAG 拆解、中断、回退、人工接管（见 orchestrator 与 planner）
 */
const store = require('../store');
const config = require('../config');

const SEC = config.security;

/* ============================== 1. 权限分级 ============================== */

/** 红色操作集合（赛题明确点名：大额转账、密码修改、挂失/解挂、理财申购） */
const RED_ACTIONS = new Set([
  'change_password',      // 密码修改
  'report_card_loss',     // 卡片挂失
  'report_card_unfreeze', // 解挂
  'product_purchase',     // 理财申购
  'product_redeem',       // 理财赎回
  'adjust_credit_limit',  // 额度调整
]);

/** 黄色操作集合（赛题明确点名：小额转账、订阅取消、虚拟卡申请） */
const YELLOW_ACTIONS = new Set([
  'transfer_money',
  'schedule_transfer',
  'split_aa_collect',
  'cancel_subscription',
  'apply_card',
  'set_card_limit',
  'undo_last_transfer',
  'gift_booking',
]);

/**
 * 判定操作风险级别。
 * 转账按"**当日累计**"判定（赛题口径）：日累计 ≤ ¥1,000 → 黄色；> ¥1,000 → 红色。
 * @returns {{tier:'green'|'yellow'|'red', label:string, reason:string, requiredFactors:string[]}}
 */
function classifyTier(toolName, args = {}, ctx = {}) {
  const tool = require('./tools').get(toolName);
  const category = tool ? tool.category : 'action';
  const amount = Number(args.amount || 0);
  const todayOut = Number(ctx.todayOut || 0);

  // 绿色：纯查询
  if (category === 'query' || toolName.startsWith('query_') || ['preview_transfer', 'analyze_bills', 'detect_anomalies', 'list_subscriptions', 'recommend_products', 'query_holdings', 'assess_risk'].includes(toolName)) {
    return { tier: 'green', label: '绿色·自动执行', reason: '纯查询类操作，不改变账户与资金', requiredFactors: [] };
  }

  // 转账类：按当日累计
  if (['transfer_money', 'schedule_transfer', 'undo_last_transfer'].includes(toolName)) {
    const cumulative = todayOut + amount;
    if (cumulative > SEC.yellowDailyMax) {
      return {
        tier: 'red', label: '红色·多因子强验证',
        reason: `当日累计转账 ${fmt(cumulative)} 超过 ¥${SEC.yellowDailyMax.toLocaleString('zh-CN')}（本笔 ${fmt(amount)} + 今日已转 ${fmt(todayOut)}）`,
        requiredFactors: SEC.redFactors.slice(),
      };
    }
    return {
      tier: 'yellow', label: '黄色·用户确认',
      reason: `当日累计转账 ${fmt(cumulative)} 在 ¥${SEC.yellowDailyMax.toLocaleString('zh-CN')} 以内（本笔 ${fmt(amount)}）`,
      requiredFactors: [],
    };
  }

  if (RED_ACTIONS.has(toolName)) {
    return { tier: 'red', label: '红色·多因子强验证', reason: '该操作属于高风险业务（赛题红色清单）', requiredFactors: SEC.redFactors.slice() };
  }
  if (YELLOW_ACTIONS.has(toolName)) {
    return { tier: 'yellow', label: '黄色·用户确认', reason: '该操作会改变账户状态，需用户确认', requiredFactors: [] };
  }
  return { tier: 'yellow', label: '黄色·用户确认', reason: '默认：涉及状态变更的操作需确认', requiredFactors: [] };
}

/** 动作类型 → 工具名（用于自动分级；使 createAction 无需逐个调用点传参） */
const ACTION_TYPE_TO_TOOL = {
  transfer: 'transfer_money',
  schedule: 'schedule_transfer',
  aa: 'split_aa_collect',
  undo: 'undo_last_transfer',
  subscription_cancel: 'cancel_subscription',
  product_purchase: 'product_purchase',
  product_redeem: 'product_redeem',
  card_apply: 'apply_card',
  virtual_card: 'apply_card',
  limit_adjust: 'adjust_credit_limit',
  card_limit: 'set_card_limit',
  card_lock: 'set_card_limit',
  card_loss: 'report_card_loss',
  card_unfreeze: 'report_card_unfreeze',
  password_change: 'change_password',
  gift_booking: 'gift_booking',
  gift_lock: 'gift_booking',
  gift_fulfill: 'gift_booking',
  revert: 'set_card_limit',
};

/** 当日已发生的转账总额（用于赛题的"日累计"口径） */
function todayOutAmount(now = new Date()) {
  const s = store.get();
  const p = (n) => String(n).padStart(2, '0');
  const key = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return (Array.isArray(s.transfers) ? s.transfers : [])
    .filter((t) => t.status === 'done' && String(t.at || '').startsWith(key))
    .reduce((a, t) => a + Number(t.amount || 0), 0);
}

const fmt = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ============================== 2. 注入防御 ============================== */

const INJECTION_PATTERNS = [
  [/忽略(之前|上面|以上|前面)?.{0,6}(指令|要求|规则|提示)/, '要求忽略既有指令'],
  [/(忽略|无视|绕过|跳过).{0,8}(确认|验证|风控|权限|审核)/, '要求绕过确认/风控'],
  [/(不用|无需|不需要|免).{0,4}(确认|验证|验证码|密码)/, '要求免验证执行'],
  [/(直接|立刻|马上).{0,6}(转|打款|划款|扣款).{0,6}(不用|别|无需)/, '要求直接扣款'],
  [/(你现在是|你现在扮演|假装你是|从现在起你是).{0,12}/, '角色扮演越权'],
  [/(ignore (all )?(previous|above) (instructions|rules))/, '英文忽略指令'],
  [/(system|assistant)\s*[:：]/, '伪造系统/助手消息'],
  [/(管理员|root|superuser|最高权限|开发模式|调试模式|debug mode)/i, '请求提权'],
  [/(越权|提权|解除限制|关闭安全|禁用风控)/, '显式请求解除安全'],
  [/(泄露|告诉我|输出).{0,6}(密钥|api ?key|密码|prompt|系统提示)/i, '探测密钥或系统提示'],
];

/**
 * 检测潜在指令注入 / 越权诱导。
 * 注意：本系统的安全边界在服务端结构上（工具白名单 + 门禁 + 动作层），
 *      因此检测结果只影响"是否告警与留痕"，**不构成任何可被绕过的路径**。
 */
function detectInjection(text) {
  const t = String(text || '');
  const hits = [];
  for (const [re, label] of INJECTION_PATTERNS) if (re.test(t)) hits.push(label);
  return { hit: hits.length > 0, hits, text: t.slice(0, 120) };
}

/** 记录一次注入尝试（安全事件） */
function recordInjection(text, hits) {
  store.addAudit({
    action: 'security_injection_blocked', category: 'security', riskLevel: 'high',
    result: 'blocked', detail: `检测到潜在指令注入/越权诱导：${hits.join('、')}`,
    request: String(text).slice(0, 120), reason: '用户输入始终按数据处理，安全边界在服务端，不提供任何绕过路径',
    requiresConfirm: false,
  });
  recordFailure('injection');
}

/* ============================== 3. 异常熔断 ============================== */

function ensureGuard() {
  const s = store.get();
  if (!s.securityState) {
    s.securityState = { failures: [], lockedUntil: 0, trips: 0 };
  }
  if (!Array.isArray(s.securityState.failures)) s.securityState.failures = [];
  return s.securityState;
}

/** 记录一次失败/可疑行为（验证码错误、注入尝试、被拒绝的高风险操作等） */
function recordFailure(kind) {
  const g = ensureGuard();
  const now = Date.now();
  g.failures.push({ at: now, kind });
  g.failures = g.failures.filter((f) => now - f.at <= SEC.circuitBreaker.windowMs);
  if (g.failures.length >= SEC.circuitBreaker.maxFailures && now > g.lockedUntil) {
    g.lockedUntil = now + SEC.circuitBreaker.lockMs;
    g.trips += 1;
    store.save(true);
    store.addAudit({
      action: 'circuit_breaker_tripped', category: 'security', riskLevel: 'high',
      result: 'locked',
      detail: `${SEC.circuitBreaker.windowMs / 60000} 分钟内累计 ${g.failures.length} 次失败/可疑行为（${[...new Set(g.failures.map((f) => f.kind))].join('、')}），已触发安全锁定 ${SEC.circuitBreaker.lockMs / 60000} 分钟`,
      request: '异常熔断', reason: '连续失败或可疑行为触发安全锁定，保护客户资金',
    });
    return { tripped: true, lockedUntil: g.lockedUntil };
  }
  store.save(true);
  return { tripped: false, lockedUntil: g.lockedUntil };
}

/** 当前熔断状态 */
function circuitState(now = Date.now()) {
  const g = ensureGuard();
  const locked = now < g.lockedUntil;
  return {
    locked,
    lockedUntil: g.lockedUntil || 0,
    remainMs: locked ? g.lockedUntil - now : 0,
    recentFailures: g.failures.filter((f) => now - f.at <= SEC.circuitBreaker.windowMs).length,
    trips: g.trips || 0,
    windowMinutes: SEC.circuitBreaker.windowMs / 60000,
    maxFailures: SEC.circuitBreaker.maxFailures,
  };
}

function clearFailures() {
  const g = ensureGuard();
  g.failures = [];
  g.lockedUntil = 0;
  store.save(true);
  return circuitState();
}

/** 熔断锁定期间禁止红色操作 */
function assertNotLocked(tier) {
  const st = circuitState();
  if (st.locked && tier === 'red') {
    return { ok: false, error: `安全锁定中（约 ${Math.ceil(st.remainMs / 60000)} 分钟）：连续失败或可疑行为已触发熔断，红色操作暂时不可用，请稍后或联系客服。` };
  }
  return { ok: true };
}

/* ============================== 4. 决策链路留痕 ============================== */

/** 生成可落库的决策链路（规划 + 工具调用 + 判定） */
function buildDecisionChain(events = [], extra = {}) {
  const chain = [];
  for (const e of events) {
    if (e.type === 'step' && ['intent', 'plan', 'tool_call', 'tool_result', 'risk', 'confirm', 'system'].includes(e.kind)) {
      chain.push({
        kind: e.kind,
        title: String(e.title || '').slice(0, 80),
        detail: String(e.detail || '').slice(0, 200),
        tool: e.meta && e.meta.tool ? e.meta.tool : null,
        ts: e.ts || Date.now(),
      });
    }
  }
  return { steps: chain.slice(-20), ...extra };
}

module.exports = {
  classifyTier, detectInjection, recordInjection,
  recordFailure, circuitState, clearFailures, assertNotLocked,
  buildDecisionChain, todayOutAmount, ACTION_TYPE_TO_TOOL,
  RED_ACTIONS, YELLOW_ACTIONS, fmt,
};
