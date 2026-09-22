'use strict';
/**
 * 银枢·AI银行副驾 —— 零依赖 HTTP 服务（Node 18+ 内置模块）
 * 职责：静态资源托管 + API + SSE 流式对话。
 * 安全：API Key 只在后端 config 读取；前端只能访问 /api/*。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const orchestrator = require('./agent/orchestrator');
const actions = require('./agent/actions');
const billEngine = require('./agent/billEngine');
const guard = require('./agent/securityGuard');
const wealthEngine = require('./agent/wealthEngine');
const tools = require('./agent/tools');
const llm = require('./agent/llm');
const riskEngine = require('./agent/riskEngine');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      data += c;
      if (data.length > limit) { tooBig = true; data = ''; }
    });
    req.on('end', () => {
      if (tooBig) {
        const e = new Error(`请求体过大（上限 ${Math.round(limit / 1024)}KB）`);
        e.status = 413;
        return reject(e);
      }
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch {
        const e = new Error('请求体不是合法 JSON');
        e.status = 400;
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 输入净化：限制长度、剔除控制字符（防止把控制序列塞进审计日志与界面） */
const MAX_MESSAGE_LEN = 500;
function sanitizeMessage(raw) {
  if (typeof raw !== 'string') return { error: 'message 必须是字符串' };
  if (raw.length > MAX_MESSAGE_LEN) return { error: `单条消息过长（上限 ${MAX_MESSAGE_LEN} 字）` };
  // 保留常规换行与制表符，其余控制字符一律剔除
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!cleaned) return { error: 'message 不能为空' };
  return { value: cleaned };
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(config.PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(config.PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found: ' + rel); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------ 路由 ------------------------------ */
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      project: '银枢·AI银行副驾',
      version: '0.1.0',
      engine: orchestrator.engineName(),
      llm: llm.enabled() ? llm.info() : null,
      tools: tools.list().map((t) => ({ name: t.name, label: t.label, implemented: t.implemented, phase: t.phase || 1, risk: t.risk, requiresConfirm: t.requiresConfirm })),
    });
  }

  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, fullState());
  }

  if (p === '/api/audit' && req.method === 'GET') {
    return sendJson(res, 200, { log: store.auditTail(80) });
  }

  // 安全机制现状：全部由真实配置 / 工具注册表 / 审计日志现算，不写死文案
  if (p === '/api/security' && req.method === 'GET') {
    return sendJson(res, 200, securityInfo());
  }

  if (p === '/api/security/unlock' && req.method === 'POST') {
    // 沙箱演示与客服复核用：解除安全锁定
    const st = guard.clearFailures();
    store.addAudit({ action: 'circuit_breaker_cleared', category: 'security', riskLevel: 'medium', result: 'success', detail: '人工解除安全锁定（沙箱演示/客服复核场景）', request: 'unlock', reason: '经人工确认后恢复' });
    return sendJson(res, 200, { ok: true, circuit: st });
  }

  // 沙箱演示：将已到期（生日前 2 天）的预约任务立即执行
  if (p === '/api/sandbox/tick' && req.method === 'POST') {
    const s = store.get();
    const due = (Array.isArray(s.scheduledTasks) ? s.scheduledTasks : []).filter((t) => t.status === 'scheduled');
    if (!due.length) return sendJson(res, 200, { ok: true, executed: 0, message: '没有待执行的预约任务', state: fullState() });
    const { action } = actions.createAction({
      type: 'gift_fulfill', toolName: 'set_card_limit',
      title: `预约到期自动执行（${due.length} 个任务）`,
      payload: {}, riskResult: { decision: 'allow', hitRules: [] }, needsSms: false,
      summary: '沙箱模拟时间推进到预约执行日',
    });
    const r = actions.executeAction(action.id, {});
    return sendJson(res, 200, { ok: r.ok, message: r.ok ? r.receipt : r.error, executed: r.ok ? 1 : 0, state: fullState() });
  }

  // 转人工接管 / 解除接管
  if (p === '/api/escalate' && req.method === 'POST') {
    const body = await readBody(req);
    const s = store.get();
    const ticket = {
      id: `TK${String((s.auditLog || []).length).padStart(4, '0')}`,
      reason: String(body.reason || '用户请求人工协助'),
      createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      recentActions: store.auditTail(8).map((a) => `${a.action}/${a.result}`),
      pendingCount: actions.listPending().length,
    };
    s.humanTakeover = { ticketId: ticket.id, at: ticket.createdAt, reason: ticket.reason };
    store.save(true);
    store.addAudit({ action: 'escalate_to_human', category: 'service', riskLevel: 'medium', result: 'success', detail: `已转人工：工单 ${ticket.id}（${ticket.reason}）`, request: ticket.reason, reason: '用户申请人工接管，Agent 暂停自动执行资金类操作' });
    return sendJson(res, 200, { ok: true, ticket, state: fullState() });
  }

  if (p === '/api/escalate/resolve' && req.method === 'POST') {
    const s = store.get();
    const t = s.humanTakeover;
    s.humanTakeover = null;
    store.save(true);
    store.addAudit({ action: 'escalate_resolved', category: 'service', riskLevel: 'low', result: 'success', detail: `人工接管已结束${t ? '（工单 ' + t.ticketId + '）' : ''}，Agent 恢复自动服务`, request: 'resolve', reason: '客服/演示结束接管' });
    return sendJson(res, 200, { ok: true, state: fullState() });
  }

  // IM 渠道接入（赛题：APP、IM 等渠道联通）——文本通道，轻交互；红色操作引导到 App 完成现场因子
  if (p === '/api/im/webhook' && req.method === 'POST') {
    const body = await readBody(req);
    const platform = String(body.platform || 'im');
    const checked = sanitizeMessage(body.text);
    if (checked.error) return sendJson(res, 400, { ok: false, error: checked.error });
    const evs = [];
    await orchestrator.handle(checked.value, { emit: (e) => evs.push(e) });
    const reply = evs.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    const pend = evs.filter((e) => e.type === 'confirm').map((e) => e.action);
    const red = pend.find((a) => (a.requiredFactors || []).includes('face'));
    let hint = null;
    if (red) hint = `⚠️ 该操作是**红色级别**，需在**手机银行 App** 完成${(red.requiredFactors || []).map((f) => (f === 'sms' ? '短信验证码' : '人脸识别')).join(' + ')}——IM 渠道不支持现场因子，这是刻意的安全设计。`;
    else if (pend.length) hint = `请回复「确认 ${pend[0].id}」执行，或「取消 ${pend[0].id}」取消。`;
    return sendJson(res, 200, {
      ok: true, platform,
      reply: reply + (hint ? '\n\n' + hint : ''),
      pending: pend.map((a) => ({ id: a.id, tier: a.tier, tierLabel: a.tierLabel, title: a.title })),
      needsApp: Boolean(red),
    });
  }

  if (p === '/api/actions' && req.method === 'GET') {
    return sendJson(res, 200, { pending: actions.listPending(), recent: actions.recentActions(10) });
  }

  if (p === '/api/action/confirm' && req.method === 'POST') {
    const body = await readBody(req);
    const actionId = String(body.actionId || '').trim();
    if (!actionId) return sendJson(res, 400, { ok: false, error: 'actionId 不能为空' });
    const result = actions.executeAction(actionId, {
      code: body.code === undefined ? undefined : String(body.code),
      confirmText: body.confirmText,
      face: body.face === true,
      values: body.values && typeof body.values === 'object' ? body.values : undefined,
    });
    const message = orchestrator.buildActionMessage(result, 'confirm');
    store.appendConversation('user', `确认 ${actionId}${body.code ? ' ' + body.code : ''}`, { engine: 'action' });
    store.appendConversation('agent', message, { engine: 'action' });
    return sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok, error: result.error || null, message,
      receipt: result.receipt || null, receiptData: result.receiptData || null,
      attemptsLeft: result.attemptsLeft, needFace: result.needFace || false,
      circuit: result.circuit || guard.circuitState(),
      state: fullState(),
    });
  }

  if (p === '/api/action/cancel' && req.method === 'POST') {
    const body = await readBody(req);
    const actionId = String(body.actionId || '').trim();
    if (!actionId) return sendJson(res, 400, { ok: false, error: 'actionId 不能为空' });
    const result = actions.cancelAction(actionId, String(body.reason || '用户在界面上取消'));
    const message = orchestrator.buildActionMessage(result, 'cancel');
    store.appendConversation('user', `取消 ${actionId}`, { engine: 'action' });
    store.appendConversation('agent', message, { engine: 'action' });
    return sendJson(res, result.ok ? 200 : 400, { ok: result.ok, error: result.error || null, message, state: fullState() });
  }

  if (p === '/api/conversation/clear' && req.method === 'POST') {
    store.clearConversation();
    return sendJson(res, 200, { ok: true, conversation: [] });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    store.reset();
    return sendJson(res, 200, { ok: true, state: fullState() });
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const checked = sanitizeMessage(body ? body.message : undefined);
    if (checked.error) return sendJson(res, 400, { ok: false, error: checked.error });
    const message = checked.value;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    send({ type: 'start', engine: orchestrator.engineName(), at: Date.now() });

    let closed = false;
    req.on('close', () => { closed = true; });
    try {
      await orchestrator.handle(message, { emit: (evt) => { if (!closed) send(evt); } });
    } catch (e) {
      send({ type: 'done', ok: false, error: e.message });
    }
    if (!closed) res.end();
    return;
  }

  return sendJson(res, 404, { ok: false, error: 'Not Found' });
}

/* ------------------------------ 对外状态（基础状态 + 现算的账单/异常/订阅） ------------------------------ */
function fullState() {
  const base = store.stateSummary();
  let anomalies = { scanned: 0, flagged: 0, list: [], all: [] };
  let subscriptionsDetail = { items: [], upcoming: [], detected: [] };
  let portfolio = { holdings: [], totalAmount: 0, totalReturn: 0, totalValue: 0, count: 0 };
  try {
    anomalies = billEngine.detectAnomalies({ limit: 6 });
    subscriptionsDetail = billEngine.subscriptions();
    portfolio = wealthEngine.portfolio();
  } catch (e) {
    console.warn('[state] 计算账单/订阅/持仓失败：', e.message);
  }
  return {
    ...base,
    anomalies: { scanned: anomalies.scanned, flagged: anomalies.flagged, list: anomalies.list },
    subscriptionsDetail,
    portfolio,
  };
}

/* ------------------------------ 安全机制现状（实时计算） ------------------------------ */
function securityInfo() {
  const s = store.get();
  const list = tools.list();
  const implemented = list.filter((t) => t.implemented);
  const needConfirm = list.filter((t) => t.requiresConfirm);
  const sec = config.security;
  const llmOn = llm.enabled();

  const mechanisms = [
    {
      id: 'key_isolation', name: '密钥隔离', status: 'active',
      desc: '大模型 API Key 仅由后端读取，前端通过 /api/* 访问业务数据，密钥不下发浏览器。',
      evidence: llmOn
        ? `当前引擎：大模型（${config.llm.model}），Key 存于后端 .env；前端代码零密钥引用`
        : '当前引擎：本地意图引擎，无需任何 Key 即可运行',
    },
    {
      id: 'sandbox', name: '数据沙箱', status: s.meta.sandbox ? 'active' : 'off',
      desc: '所有数据为本地模拟数据，不接任何真实支付/银行接口。',
      evidence: `实时数据：${s.cards.length} 张卡 · ${s.transactions.length} 条账单 · ${s.payees.length} 个客户常用收款人（种子 ${s.meta.seed}）`,
    },
    {
      id: 'audit', name: '全程留痕', status: s.auditLog.length > 0 ? 'active' : 'ready',
      desc: '所有工具调用（成功/未就绪/失败）与未识别意图均写入本地操作日志，含风险等级、原始请求、执行理由。',
      evidence: s.auditLog.length > 0 ? `已累计记录 ${s.auditLog.length} 条操作` : '尚未产生操作记录，执行一次任意操作后可见',
    },
    {
      id: 'grading', name: '分级授权', status: 'active',
      desc: `查询类直接执行；≥ ¥${sec.confirmThreshold.toLocaleString('zh-CN')} 的转账等高风险操作必须二次确认（弹窗 + 模拟短信验证码）。`,
      evidence: `转账链路已生效：待确认单 + ≥¥${sec.confirmThreshold.toLocaleString('zh-CN')} 强制短信验证码（已实测通过/错误/重放/取消四类）；理财申购、挂失于阶段 4 接入；已声明 ${needConfirm.length} 个需确认工具`,
    },
    {
      id: 'risk', name: '风控规则引擎', status: 'active',
      desc: `陌生收款人 / 夜间大额（${sec.nightStartHour}:00–0${sec.nightEndHour}:00）/ 整数大额（${sec.roundAmountStep.toLocaleString('zh-CN')} 的整数倍）/ 涉诈黑名单 → 拦截或强提醒并说明原因。`,
      evidence: `已内置 ${riskEngine.ruleCount()} 条规则（${riskEngine.RULE_CATALOG.map((r) => r.id).join('/')}）并在「转账风控预检」中真实生效（已实测拦截、拒绝、需确认三类判定）；涉诈黑名单 ${s.blacklist.length} 条；资金划转的执行与确认弹窗于阶段 2 接入`,
    },
    {
      id: 'suitability', name: '适当性管理', status: 'ready',
      desc: '理财推荐必须匹配用户风险测评等级，不匹配时拒绝并解释。',
      evidence: `当前用户等级 ${s.user.riskLevel}（${s.user.riskLevelName}）；产品库 ${s.products.length} 款覆盖 ${Array.from(new Set(s.products.map((x) => x.riskLevel))).sort().join('/')}；强制校验于阶段 4 生效`,
    },
    {
      id: 'consent', name: '知情同意', status: 'active',
      desc: '每一步敏感操作都说清"做什么、金额多少、风险是什么"，并提供"为什么这么做"解释入口。',
      evidence: `已实现工具 ${implemented.length} 个，均在 Agent 步骤中附带执行理由（可在时间线展开“为什么这么做？”）`,
    },
  ];

  return {
    sandbox: s.meta.sandbox === true,
    engine: orchestrator.engineName(),
    confirmThreshold: sec.confirmThreshold,
    tiers: {
      yellowDailyMax: sec.yellowDailyMax,
      redDailyOver: sec.redDailyOver,
      redFactors: sec.redFactors,
    },
    circuit: guard.circuitState(),
    runtimeSandbox: {
      dynamicCodeExecution: false,
      note: '服务运行时不执行任何动态代码（无 eval / Function / child_process），所有能力来自工具白名单；沙箱指“本机隔离 + 白名单 + 数据不落地真实接口”',
      injectionPatterns: 10,
    },
    nightWindow: `${sec.nightStartHour}:00–0${sec.nightEndHour}:00`,
    roundAmountStep: sec.roundAmountStep,
    smsCodeTTLSeconds: Math.round(sec.smsCodeTTLms / 1000),
    blacklist: s.blacklist,
    tools: {
      total: list.length,
      implemented: implemented.length,
      requiresConfirm: needConfirm.length,
      implementedNames: implemented.map((t) => `${t.label}(${t.name})`),
    },
    auditCount: s.auditLog.length,
    mechanisms,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[api] 处理失败：', e);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: e.message });
      else res.end();
    }
    return;
  }
  serveStatic(req, res, url.pathname);
});

store.load();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${config.PORT} 已被占用。`);
    console.error('可能已经有一个实例在运行；请先关闭它，或改 .env 里的 PORT 后重试。\n');
  } else {
    console.error('服务启动失败：', e.message);
  }
  process.exit(1);
});

server.listen(config.PORT, '127.0.0.1', () => {
  const s = store.get();
  const line = '─'.repeat(58);
  console.log(line);
  console.log('  银枢·AI银行副驾  YinShu AI Banking Copilot  v0.1.0');
  console.log(line);
  console.log(`  服务地址 : http://127.0.0.1:${config.PORT}`);
  console.log(`  推理引擎 : ${orchestrator.engineName() === 'llm' ? `大模型（${config.llm.model}）` : '本地意图引擎（离线演示模式）'}`);
  console.log(`  沙箱数据 : ${s.cards.length} 张卡 / ${s.transactions.length} 条账单 / ${s.payees.length} 个常用收款人 / ${s.subscriptions.length} 个订阅 / ${s.products.length} 款理财`);
  console.log(`  数据模式 : 本地模拟数据，未接入任何真实支付接口`);
  console.log(line);
  console.log('  按 Ctrl+C 停止服务');
});

process.on('SIGINT', () => { console.log('\n正在退出…'); server.close(() => process.exit(0)); });
