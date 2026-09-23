/* ===========================================================
   银枢·AI银行副驾 —— 前端交互（原生 JS，无依赖）
   =========================================================== */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let STATE = null;
let SECURITY = null;
let BUSY = false;
let lastHighlightTxn = [];
let PANEL_FILTER = null; // { txns, label } —— 由 Agent 查询结果驱动的右侧列表筛选

/* ------------------------------ 工具函数 ------------------------------ */
const money = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyShort = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 10000) return '¥' + (v / 10000).toFixed(2) + '万';
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 轻量 Markdown 渲染：标题 / 加粗 / 列表 / 表格 / 行内代码 / 引用提示 */
function md(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let i = 0;
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  while (i < lines.length) {
    const line = lines[i];
    // 引用块 → 提示条
    if (/^\s*>\s?/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { items.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<div class="md-note">${inline(items.join(' '))}</div>`);
      continue;
    }
    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim()));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    // 标题
    let m = line.match(/^\s*(#{2,4})\s+(.*)$/);
    if (m) { out.push(`<h3>${inline(m[2])}</h3>`); i++; continue; }
    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }
    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('');
}

/* ------------------------------ 数据加载与渲染 ------------------------------ */
async function loadState() {
  try {
    const res = await fetch('/api/state');
    STATE = await res.json();
    try {
      const sec = await fetch('/api/security');
      SECURITY = await sec.json();
    } catch { /* 安全信息获取失败不影响主流程 */ }
    renderAll();
    noteSync(true);
  } catch (e) {
    noteSync(false);
    throw e;
  }
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    const badge = $('#engineBadge');
    const impl = h.tools.filter((t) => t.implemented).length;
    badge.textContent = h.engine === 'llm'
      ? `引擎：大模型 ${h.llm ? h.llm.model : ''}`
      : `引擎：本地意图引擎（离线演示）`;
    badge.title = `已接入工具 ${impl}/${h.tools.length} 项`;
  } catch { /* ignore */ }
}

function renderAll() {
  if (!STATE) return;
  renderHeader();
  renderCards();
  renderTxns(lastHighlightTxn);
  renderAudit();
  renderBills();
  renderWealth();
  renderSecurity();
  renderRiskBanner();
  renderTransfers();
  renderPendingBanner();
  renderGiftPanel();
  renderCardOps();
}

/* ------------------------------ 跨场景联动：生日/节日安排 ------------------------------ */
function renderGiftPanel() {
  const box = $('#giftPanel');
  if (!box) return;
  const draft = STATE.giftDraft;
  const bookings = STATE.bookings || [];
  const frozen = STATE.frozenFunds || [];
  const active = draft && draft.stage !== 'done';
  if (!active && !bookings.length && !frozen.length) { box.innerHTML = ''; return; }

  const head = active ? `进行中的安排：${draft.occasion}·${draft.recipient}` : '已完成的安排';
  box.innerHTML = `
    <div class="gift-panel">
      <div class="gp-head"><span>🎁 ${esc(head)}</span>${active ? '<span class="gp-flag">信息收集中</span>' : ''}</div>
      <div class="gp-body">
        ${active ? `<div class="rp-line"><span>日期</span><b>${draft.date ? esc(draft.date) : '待确认'}</b></div>
          <div class="rp-line"><span>预算</span><b>${draft.budget ? money(draft.budget) : '待确认'}</b></div>
          <div class="rp-line"><span>形式</span><b>${draft.wants ? { flower: '只送鲜花', cake: '只送蛋糕', both: '鲜花 + 蛋糕' }[draft.wants] : '待确认'}</b></div>` : ''}
        ${frozen.length ? `<div class="rp-line"><span>锁定资金</span><b>${frozen.map((f) => money(f.amount) + '（' + esc(f.purpose) + '）').join('、')}</b></div>` : ''}
        ${bookings.map((b) => `<div class="gp-bk"><span class="gp-type">${esc(b.type)}</span>${esc(b.name)}<b>${money(b.price)}</b><span class="gp-date">${esc(b.deliveryDate)} ${esc(b.deliveryWindow || '')}</span></div>`).join('')}
      </div>
      ${bookings.length ? `<div class="gp-foot">订单号 ${bookings.map((b) => esc(b.orderNo)).join('、')} · 送达至 ${esc(bookings[0].recipientName)}</div>` : ''}
    </div>`;
}

/* ------------------------------ 卡片业务受理单 ------------------------------ */
function renderCardOps() {
  const box = $('#cardOps');
  if (!box) return;
  const reqs = STATE.cardRequests || [];
  const hint = $('#cardOpsHint');
  if (hint) hint.textContent = reqs.length ? `${reqs.length} 笔受理中` : '';
  if (!reqs.length) {
    box.innerHTML = '<div class="txn-empty">暂无卡片业务。可以试试说「我想办一张白金卡」。</div>';
    return;
  }
  box.innerHTML = reqs.map((r) => `<div class="sub-row">
    <div class="sub-main">
      <div class="sub-name">${esc(r.cardType)}<span class="sub-tag soon">审核中</span></div>
      <div class="sub-sub">受理编号 ${esc(r.id)} · 申请时间 ${esc(r.createdAt)} · 预计 ${esc(r.estimate || '1–3 个工作日')}</div>
    </div>
  </div>`).join('');
}

/* ------------------------------ 连接状态提示 ------------------------------ */
let failStreak = 0;
function noteSync(okFlag) {
  const box = $('#syncBanner');
  if (!box) return;
  failStreak = okFlag ? 0 : failStreak + 1;
  if (failStreak >= 2) {
    box.innerHTML = '<div class="sync-banner">⚠️ 与后端连接中断，界面数据可能不是最新的。请确认服务在运行（项目目录执行 <b>npm start</b>），恢复后会自动重连。</div>';
  } else if (okFlag && box.innerHTML) {
    box.innerHTML = '';
  }
}

/* ------------------------------ 最近转账 ------------------------------ */
function renderTransfers() {
  const box = $('#transferList');
  if (!box) return;
  const list = STATE.transfers || [];
  $('#transferHint').textContent = list.length ? `共 ${list.length} 笔（最近 10 笔）` : '';
  if (!list.length) {
    box.innerHTML = '<div class="txn-empty">还没有转账记录。试试说「给我妈转两千块交物业费」。</div>';
    return;
  }
  box.innerHTML = list.map((t, i) => {
    const revoked = t.status !== 'done';
    const canUndo = !revoked && i === 0;
    return `<div class="tr-row${revoked ? ' revoked' : ''}">
      <div class="tr-main">
        <div class="tr-name">${esc(t.payeeName)}<span class="tr-nick">${esc(t.payeeNickname || '')}</span>${revoked ? '<span class="tr-tag">已撤销</span>' : ''}</div>
        <div class="tr-sub">${esc(String(t.at).slice(5, 16))} · ${esc(t.cardName || '')} 尾号${esc(String(t.cardTail || ''))} · ${t.confirmedBy === 'sms' ? '短信验证码确认' : '点击确认'}</div>
      </div>
      <div class="tr-right">
        <span class="tr-amt">-${money(t.amount)}</span>
        ${canUndo ? '<button class="link-btn" data-undo="1">撤销</button>' : ''}
      </div>
    </div>`;
  }).join('');
}

/* ------------------------------ 待确认操作横幅 ------------------------------ */
function renderPendingBanner() {
  const box = $('#pendingBanner');
  if (!box) return;
  const pend = STATE.pendingActions || [];
  if (!pend.length) { box.innerHTML = ''; return; }
  const a = pend[pend.length - 1];
  box.innerHTML = `<div class="pend-banner">
    <span class="pb-icon">🔐</span>
    <span class="pb-text">有 <b>${pend.length}</b> 个待确认操作：${esc(a.title)}</span>
    <span class="pb-flag">${a.needsSms ? '需短信验证码' : '点击确认即可'}</span>
    <button class="link-btn" data-goto-confirm="1">去确认</button>
  </div>`;
}

function renderHeader() {
  const u = STATE.user;
  $('#userName').textContent = `${u.name}　${u.city}`;
  $('#userMeta').textContent = `${u.level}客户 · 风险等级 ${u.riskLevel}（${u.riskLevelName}） · ${u.phone}`;
  $('#userAvatar').textContent = u.name.slice(-1);
  $('#totalAssets').textContent = money(STATE.totals.totalAssets);
  $('#txnCountHint').textContent = `共 ${STATE.totals.txnCount} 笔历史账单`;
}

function renderCards(focusIds = []) {
  const box = $('#cardsCarousel');
  box.innerHTML = STATE.cards.map((c) => {
    const focused = focusIds.includes(c.id) ? ' focused' : '';
    const frozen = c.status === 'frozen' ? ' frozen' : '';
    const amount = c.kind === 'debit'
      ? `<div class="card-amount">${money(c.balance)}<small>账户余额</small></div>`
      : `<div class="card-amount">${money(c.available)}<small>可用额度 / ${money(c.creditLimit)}</small></div>`;
    const state = c.status === 'active'
      ? (c.kind === 'credit' ? `账单日 ${c.billDay} 日 · 还款日 ${c.repayDay} 日` : `单笔限额 ${moneyShort(c.singleLimit)}`)
      : (c.lost ? `已挂失 · 不可恢复${c.lostAt ? '（' + String(c.lostAt).slice(5, 16) + '）' : ''}` : `已冻结${c.frozenReason && c.frozenReason !== '已挂失' ? ' · ' + c.frozenReason : ''}`);
    return `<div class="card-item${focused}${frozen}" data-color="${c.color}" data-card-id="${c.id}">
      <div class="card-top"><span>${esc(c.level)}</span><span>${esc(c.brand)}</span></div>
      <div class="card-name">${esc(c.name)}</div>
      <div class="card-num">${esc(c.numberMasked)}</div>
      ${amount}
      <div class="card-state">${esc(state)}</div>
    </div>`;
  }).join('');
  if (focusIds.length) {
    setTimeout(() => {
      const el = box.querySelector('.card-item.focused');
      if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }, 80);
  }
}

function renderTxns(highlightIds = []) {
  // Agent 指定了查询结果集时，右侧直接展示同一批数据（"查到什么就显示什么"）
  const source = PANEL_FILTER ? PANEL_FILTER.txns : STATE.recentTransactions;
  if (!source.length) {
    $('#txnList').innerHTML = '<div class="txn-empty">暂无交易记录。</div>';
    return;
  }
  const head = PANEL_FILTER
    ? `<div class="txn-filter">已按「${esc(PANEL_FILTER.label)}」展示 ${source.length} 笔 <button class="link-btn" id="btnClearFilter">显示全部</button></div>`
    : '';
  $('#txnList').innerHTML = head + source.map((t) => {
    const hl = highlightIds.includes(t.id) ? ' hl' : '';
    const badge = t.anomaly ? `<span class="txn-badge">${esc(t.anomaly.type)}</span>` : '';
    const sub = `${t.ts.slice(5, 16)} · ${esc(t.category)}${t.city && t.city !== STATE.user.city ? ' · ' + esc(t.city) : ''}`;
    return `<div class="txn-row${hl}" data-txn-id="${t.id}">
      <div class="txn-icon">${esc(t.category.slice(0, 1))}</div>
      <div class="txn-main">
        <div class="txn-merchant">${esc(t.merchant)}${badge}</div>
        <div class="txn-sub">${sub}</div>
      </div>
      <div class="txn-amt ${t.direction === 'out' ? 'out' : 'in'}">${t.direction === 'out' ? '-' : '+'}${money(t.amount)}</div>
    </div>`;
  }).join('');
  const btn = $('#btnClearFilter');
  if (btn) btn.addEventListener('click', () => { PANEL_FILTER = null; lastHighlightTxn = []; renderTxns([]); });
}

/* ------------------------------ 账单面板（真实流水现算） ------------------------------ */
const RISK_ORDER = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

function renderBills() {
  const box = $('#billsBody');
  if (!box || !STATE || !STATE.billStats) return;
  const b = STATE.billStats;
  const an = STATE.anomalies || { scanned: 0, flagged: 0, list: [] };
  const subs = STATE.subscriptionsDetail || { items: [], upcoming: [], detected: [], activeCount: 0, monthlyTotal: 0, yearlyTotal: 0 };
  const maxCat = Math.max(...b.byCategory.map((c) => c.amount), 1);
  const maxMon = Math.max(...b.byMonth.map((m) => m.out), 1);
  const catColors = ['#0B4FA8', '#1A73E8', '#3B82F6', '#60A5FA', '#0E9384', '#7F56D9', '#DC6803', '#B42318', '#667085', '#0F766E', '#9333EA'];

  box.innerHTML = `
    <div class="stat-row">
      <div class="stat"><span>统计区间</span><b>${esc(b.rangeLabel)}</b></div>
      <div class="stat"><span>支出合计</span><b>${money(b.totalOut)}</b></div>
      <div class="stat"><span>月均支出</span><b>${money(b.monthlyAvgOut)}</b></div>
      <div class="stat"><span>上月环比</span><b class="${b.lastMonthDelta > 0 ? 'up' : 'down'}">${b.lastMonthDelta > 0 ? '+' : ''}${b.lastMonthDelta}%</b></div>
    </div>

    <div class="section-title">消费分类（近 ${b.months} 个月 · 共 ${b.txnCount} 笔）</div>
    <div class="bar-list">
      ${b.byCategory.map((c, i) => `
        <div class="bar-row">
          <span class="bar-label">${esc(c.category)}</span>
          <span class="bar-track"><i style="width:${Math.max(2, (c.amount / maxCat) * 100)}%;background:${catColors[i % catColors.length]}"></i></span>
          <span class="bar-val">${moneyShort(c.amount)}<small>${c.count}笔</small></span>
        </div>`).join('')}
    </div>

    <div class="section-title">月度支出趋势</div>
    <div class="mono-chart">
      ${b.byMonth.map((m) => `<div class="mono-col" title="${m.month} 支出 ${money(m.out)}">
        <span class="mono-bar" style="height:${Math.max(4, (m.out / maxMon) * 100)}%"></span>
        <span class="mono-x">${m.month.slice(5)}月</span>
      </div>`).join('')}
    </div>

    <div class="section-title">异常交易识别 <span class="section-hint">评分制扫描 ${an.scanned} 笔支出 · 命中 ${an.flagged} 笔</span></div>
    ${an.list.length ? an.list.map((a) => `
      <div class="anomaly-card">
        <div class="anomaly-top">
          <span class="risk-badge lv-${a.level === 'high' ? 'high' : 'mid'}">${esc(a.type)}</span>
          <b>${esc(a.merchant)}</b>
          <span class="anomaly-amt">${money(a.amount)}</span>
        </div>
        <div class="anomaly-sub">${esc(a.ts)} · ${esc(a.city)} · ${esc(a.category)} · 风险分 <b>${a.score}</b></div>
        <div class="anomaly-reason">${a.evidence.map((e) => esc(e)).join('；')}</div>
      </div>`).join('') : '<div class="txn-empty">未发现明显异常交易。</div>'}

    <div class="section-title">订阅与代扣 <span class="section-hint">活跃 ${subs.activeCount} 个 · 每月 ¥${Number(subs.monthlyTotal || 0).toFixed(2)} · 每年 ¥${Number(subs.yearlyTotal || 0).toFixed(2)}</span></div>
    ${(subs.items || []).map((x) => `
      <div class="sub-row${x.status === 'active' ? '' : ' off'}">
        <div class="sub-main">
          <div class="sub-name">${esc(x.merchant)}
            ${x.autoDetected ? '<span class="sub-tag auto">已自动识别</span>' : '<span class="sub-tag">已登记</span>'}
            ${x.status === 'active' && x.daysLeft !== null && x.daysLeft <= 7 && x.daysLeft >= 0 ? `<span class="sub-tag soon">${x.daysLeft} 天后扣费</span>` : ''}
          </div>
          <div class="sub-sub">${esc(x.cycleLabel)} ¥${Number(x.amount).toFixed(2)} · 下次 ${esc(x.nextChargeDate)}${x.detectedEvidence ? ' · ' + esc(x.detectedEvidence) : ''}</div>
        </div>
        ${x.status === 'active' && x.cancellable ? `<button class="link-btn" data-cancel-sub="${esc(x.id)}">取消订阅</button>` : (x.status === 'active' ? '' : '<span class="sub-off">已取消</span>')}
      </div>`).join('')}
    ${subs.detected && subs.detected.length ? `<div class="panel-note">自动识别依据：从真实流水中找出「金额固定 + 间隔稳定（约 30 天）」的重复扣费，共 ${subs.detected.length} 个；年度型订阅（如京东PLUS）因周期长于一年内仅扣一次，故由已登记信息提供。</div>` : ''}

    <div class="section-title">大额商户 TOP${b.topMerchants.length}</div>
    <div class="mini-list">
      ${b.topMerchants.map((m) => `<div class="mini-row"><span>${esc(m.merchant)}</span><span>${m.count} 笔 · ${money(m.amount)}</span></div>`).join('')}
    </div>
    <div class="panel-note">以上数字均由后端对 ${b.txnCount} 条真实流水实时汇总，刷新页面不会变化；完整分类/异常智能解读于阶段 3 接入对话。</div>`;
}

/* ------------------------------ 理财面板（真实产品库 + 适当性计算） ------------------------------ */
function renderWealth() {
  const box = $('#wealthBody');
  if (!box || !STATE || !STATE.products) return;
  const pf = STATE.portfolio || { count: 0, holdings: [] };
  const myLevel = RISK_ORDER[STATE.user.riskLevel] || 2;
  const lvName = { R1: '低风险', R2: '中低风险', R3: '中风险', R4: '中高风险', R5: '高风险' };
  const blocked = STATE.products.filter((p) => (RISK_ORDER[p.riskLevel] || 0) > myLevel);

  box.innerHTML = `
    ${pf && pf.count ? `<div class="section-title">我的持仓 <span class="section-hint">${pf.count} 笔 · 投入 ¥${Number(pf.totalAmount).toFixed(2)} · 估算收益 ¥${Number(pf.totalReturn).toFixed(2)}</span></div>
    ${pf.holdings.map((h) => `<div class="sub-row">
      <div class="sub-main">
        <div class="sub-name">${esc(h.name)}<span class="sub-tag">${esc(h.riskLevel)}</span></div>
        <div class="sub-sub">投入 ¥${Number(h.amount).toFixed(2)} · 持有 ${h.holdingDays} 天 · 估算收益 ${h.estimatedReturn >= 0 ? '+' : ''}¥${Number(h.estimatedReturn).toFixed(2)} · 业绩基准 ${h.expectedReturn}%/年</div>
      </div>
      <button class="link-btn" data-redeem="${esc(h.id)}">赎回</button>
    </div>`).join('')}` : ''}
    <div class="suit-banner">
      <div>你的风险测评等级：<b>${esc(STATE.user.riskLevel)}（${esc(STATE.user.riskLevelName)}）</b></div>
      <div class="panel-note" style="margin:6px 0 0">测评日期 ${esc(STATE.user.riskAssessedAt)} · 共 ${STATE.products.length} 款产品，其中 <b>${blocked.length} 款超出你的风险承受等级</b></div>
    </div>
    <div class="section-title">产品库（按风险等级排序）</div>
    ${STATE.products.map((p) => {
      const over = (RISK_ORDER[p.riskLevel] || 0) > myLevel;
      return `<div class="prod-card${over ? ' blocked' : ''}">
        <div class="prod-top">
          <span class="risk-badge lv-${p.riskLevel.toLowerCase()}">${esc(p.riskLevel)} ${esc(lvName[p.riskLevel] || p.riskName)}</span>
          <b>${esc(p.name)}</b>
          <span class="prod-ret">${Number(p.expectedReturn).toFixed(2)}%<small>业绩基准/年</small></span>
        </div>
        <div class="prod-meta">${esc(p.type)} · ${esc(p.term)} · ${p.minAmount >= 10000 ? (p.minAmount / 10000) + '万起' : p.minAmount + '元起'} · ${esc(p.liquidity)}</div>
        <div class="prod-desc">${esc(p.desc)}</div>
        ${over
          ? `<div class="suit-block">⛔ 超出你的风险承受等级（${esc(STATE.user.riskLevel)}），本项目将<b>拒绝推荐与申购</b></div>`
          : `<div class="suit-ok">✅ 与你的风险等级匹配，可推荐</div>`}
      </div>`;
    }).join('')}
    <div class="panel-note">产品与风险等级来自本地沙箱数据；风险匹配为实时计算。一键申购/赎回与风险朗读于阶段 4 接入对话。</div>`;
}

/* ------------------------------ 安全中心（真实配置 + 工具注册表 + 审计） ------------------------------ */
function renderSecurity() {
  const box = $('#securityBody');
  if (!box) return;
  if (!SECURITY) { box.innerHTML = '<div class="txn-empty">安全信息加载中…</div>'; return; }
  const S = SECURITY;
  const c = S.circuit || { locked: false, recentFailures: 0, maxFailures: 3 };
  const tiers = S.tiers || { yellowDailyMax: 1000, redFactors: ['sms', 'face'] };
  box.innerHTML = `
    <div class="stat-row">
      <div class="stat"><span>运行环境</span><b>${S.sandbox ? '沙箱（模拟数据）' : '未知'}</b></div>
      <div class="stat"><span>权限分级</span><b>🟢自动 / 🟡确认 / 🔴多因子</b></div>
      <div class="stat"><span>黄色阈值（日累计）</span><b>≤ ¥${Number(tiers.yellowDailyMax).toLocaleString('zh-CN')}</b></div>
      <div class="stat"><span>红色因子</span><b>${(tiers.redFactors || []).map((f) => (f === 'sms' ? '短信' : '人脸')).join(' + ')}</b></div>
    </div>
    <div class="stat-row" style="margin-top:8px">
      <div class="stat"><span>已留痕操作</span><b>${S.auditCount} 条</b></div>
      <div class="stat"><span>异常熔断</span><b class="${c.locked ? 'up' : 'down'}">${c.locked ? '已锁定' : '正常'}</b></div>
      <div class="stat"><span>近期失败/可疑</span><b>${c.recentFailures}/${c.maxFailures}（${c.windowMinutes} 分钟窗口）</b></div>
      <div class="stat"><span>代码执行沙箱</span><b>${S.runtimeSandbox && S.runtimeSandbox.dynamicCodeExecution ? '启用' : '无动态执行'}</b></div>
    </div>
    <div class="panel-note">${esc((S.runtimeSandbox && S.runtimeSandbox.note) || '')}</div>

    <div class="section-title">安全机制现状 <span class="section-hint">已生效 ${S.mechanisms.filter((m) => m.status === 'active').length} 项 / 已就位 ${S.mechanisms.filter((m) => m.status === 'ready').length} 项</span></div>
    <div class="mech-list">
      ${S.mechanisms.map((m) => `
        <div class="mech">
          <div class="mech-top">
            <b>${esc(m.name)}</b>
            <span class="mech-status ${m.status}">${m.status === 'active' ? '● 已生效' : '◐ 已就位'}</span>
          </div>
          <div class="mech-desc">${esc(m.desc)}</div>
          <div class="mech-ev">${esc(m.evidence)}</div>
        </div>`).join('')}
    </div>

    <div class="section-title">工具注册表 <span class="section-hint">已实现 ${S.tools.implemented}/${S.tools.total} · 需二次确认 ${S.tools.requiresConfirm} 个</span></div>
    <div class="mini-list">
      ${S.tools.implementedNames.map((n) => `<div class="mini-row"><span>${esc(n)}</span><span class="ok-tag">已接入</span></div>`).join('')}
    </div>

    <div class="section-title">涉诈黑名单（模拟反诈数据 ${S.blacklist.length} 条）</div>
    ${S.blacklist.map((b) => `<div class="bl-row"><span class="risk-badge lv-high">黑名单</span><span>${esc(b.account)}</span><span class="bl-reason">${esc(b.reason)}</span></div>`).join('')}`;
}

/* ------------------------------ 风控预检面板（真实判定结果） ------------------------------ */
function renderRiskBanner(pf) {
  const box = $('#riskBanner');
  if (!box) return;
  const p = pf || (STATE && STATE.lastPreflight);
  if (!p) { box.innerHTML = ''; return; }
  const cls = { allow: 'ok', confirm: 'warn', reject: 'danger', block: 'danger' }[p.decision] || 'warn';
  box.innerHTML = `
    <div class="risk-panel ${cls}">
      <div class="rp-head">
        <span class="rp-title">🛡 转账风控预检</span>
        <span class="rp-decision">${esc(p.decisionLabel || p.decision)}</span>
      </div>
      <div class="rp-body">
        <div class="rp-line"><span>收款人</span><b>${p.payee ? esc(p.payee.nickname + '·' + p.payee.name + '｜' + p.payee.bank + ' ' + p.payee.accountMasked) : '未找到（' + esc(p.payeeResolution ? p.payeeResolution.query : '') + '）'}</b></div>
        <div class="rp-line"><span>金额</span><b>${p.amount ? money(p.amount) : '—'}</b></div>
        <div class="rp-line"><span>付款卡</span><b>${p.card ? esc(p.card.name + ' 尾号' + p.card.tail) : '—'}</b></div>
        <div class="rp-line"><span>规则</span><b>命中 ${p.hitRules.length} 条 / 共 ${p.allRules.length} 条</b></div>
      </div>
      ${p.hitRules.length ? `<div class="rp-rules">${p.hitRules.map((r) => `<span class="rp-rule">${esc(r.id)} ${esc(r.name)}</span>`).join('')}</div>` : '<div class="rp-rules"><span class="rp-rule ok">全部通过</span></div>'}
      <div class="rp-foot">预检时间 ${esc(p.at || '')} · 本预检不划转资金</div>
    </div>`;
}

function renderAudit() {
  const rows = (STATE.auditTail || []);
  if (!rows.length) {
    $('#auditList').innerHTML = '<div class="audit-row"><span class="a-left">暂无操作记录，执行一次查询后这里会留下痕迹</span></div>';
    return;
  }
  $('#auditList').innerHTML = rows.map((a) => `<div class="audit-row">
    <span class="a-left">${esc(a.action)} · ${esc((a.detail || '').slice(0, 40))}</span>
    <span class="a-time">${esc(a.at.slice(5, 16))}</span>
  </div>`).join('');
}

/* ------------------------------ 对话 ------------------------------ */
const chatScroll = () => $('#chatScroll');
function scrollBottom() {
  const el = chatScroll();
  el.scrollTop = el.scrollHeight;
}

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="avatar">我</div><div class="bubble">${md(text)}</div>`;
  chatScroll().appendChild(div);
  scrollBottom();
}

function createTurn() {
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `
    <div class="trace"></div>
    <div class="msg agent" style="display:none">
      <div class="avatar">银</div>
      <div class="bubble"></div>
    </div>`;
  chatScroll().appendChild(turn);
  scrollBottom();
  return {
    root: turn,
    trace: turn.querySelector('.trace'),
    bubbleWrap: turn.querySelector('.msg.agent'),
    bubble: turn.querySelector('.bubble'),
    text: '',
    steps: new Map(),
  };
}

/* ------------------------------ 待确认卡片 ------------------------------ */
function renderConfirmCard(turn, action) {
  const el = document.createElement('div');
  el.className = 'confirm-card';
  el.dataset.actionId = action.id;
  const hit = (action.hitRules || []).map((r) => `<span class="cf-rule">${esc(r.id)} ${esc(r.name)}</span>`).join('');
  const tier = action.tier || 'yellow';
  const factors = action.requiredFactors || (action.needsSms ? ['sms'] : []);
  el.innerHTML = `
    <div class="cf-head tier-${tier}">
      <span class="cf-title">${tier === 'red' ? '🔴 红色·多因子强验证' : (tier === 'green' ? '🟢 绿色·自动执行' : '🟡 黄色·用户确认')}</span>
      <span class="cf-id">${esc(action.id)}</span>
      <span class="cf-flag ${factors.length ? 'need' : ''}">${factors.length ? '需 ' + factors.map((f) => (f === 'sms' ? '短信' : (f === 'face' ? '人脸' : f))).join(' + ') : '点击确认即可'}</span>
    </div>
    <div class="cf-body">${esc(action.title || '')}</div>
    ${action.tierReason ? `<div class="cf-tierreason">分级依据：${esc(action.tierReason)}</div>` : ''}
    ${action.summary ? `<div class="cf-sub">${esc(action.summary)}</div>` : ''}
    ${hit ? `<div class="cf-rules">${hit}</div>` : ''}
    ${action.riskDisclosure ? `<div class="cf-risk"><b>⚠️ 风险提示</b>${esc(action.riskDisclosure)}
      <button class="link-btn" data-tts="${esc(action.riskDisclosure)}" type="button">🔊 朗读风险提示</button></div>` : ''}
    ${action.payloadInput ? `<div class="cf-field"><label>${esc(action.payloadInput.label || action.payloadInput.key)}</label>
      <input class="cf-input" data-key="${esc(action.payloadInput.key)}" type="${action.payloadInput.type === 'password' ? 'password' : 'text'}" maxlength="${Number(action.payloadInput.maxLength) || 20}" placeholder="${esc(action.payloadInput.hint || '')}"></div>` : ''}
    ${action.needsSms && action.sandboxCode ? `<div class="cf-sms">沙箱演示验证码：<b>${esc(action.sandboxCode)}</b>（真实环境由短信下发，不回显）</div>` : ''}
    ${factors.includes('sms') ? `<div class="cf-field"><label>短信验证码</label><input class="cf-code" maxlength="6" inputmode="numeric" placeholder="输入 6 位验证码"></div>` : ''}
    ${factors.includes('face') ? `<div class="cf-field"><label>人脸识别</label><button class="btn-ghost sm cf-face" type="button">模拟人脸识别</button><span class="cf-face-state">未通过</span></div>` : ''}
    <div class="cf-form">
      <button class="btn-primary sm cf-ok" disabled>确认执行</button>
      <button class="btn-ghost sm cf-cancel">取消</button>
    </div>
    <div class="cf-result"></div>`;
  const refresh = () => {
    const okBtn = el.querySelector('.cf-ok');
    if (!okBtn) return;
    const codeEl = el.querySelector('.cf-code');
    const payEl = el.querySelector('.cf-input');
    const codeOk = !factors.includes('sms') || /^\d{6}$/.test((codeEl && codeEl.value) || '');
    const faceOk = !factors.includes('face') || el.dataset.face === '1';
    const payOk = !action.payloadInput || ((payEl && payEl.value) || '').length >= 4;
    okBtn.disabled = !(codeOk && faceOk && payOk);
  };
  el.addEventListener('input', refresh);
  const faceBtn = el.querySelector('.cf-face');
  if (faceBtn) {
    faceBtn.addEventListener('click', () => {
      el.dataset.face = '1';
      faceBtn.textContent = '✅ 人脸已通过';
      faceBtn.disabled = true;
      const st = el.querySelector('.cf-face-state');
      if (st) st.textContent = '已通过（沙箱模拟）';
      refresh();
    });
  }
  refresh();
  turn.root.appendChild(el);
  scrollBottom();
  return el;
}

async function doAction(el, mode) {
  const id = el.dataset.actionId;
  const resultBox = el.querySelector('.cf-result');
  const codeInput = el.querySelector('.cf-code');
  const fieldInput = el.querySelector('.cf-input');
  const values = {};
  if (fieldInput) values[fieldInput.dataset.key] = fieldInput.value;
  el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  if (resultBox) resultBox.innerHTML = '<span class="cf-pending">处理中…</span>';
  try {
    const body = mode === 'cancel' ? { actionId: id } : {
      actionId: id,
      code: codeInput ? codeInput.value.trim() : undefined,
      face: el.dataset.face === '1',
      values: Object.keys(values).length ? values : undefined,
    };
    const res = await fetch(mode === 'cancel' ? '/api/action/cancel' : '/api/action/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (resultBox) {
      resultBox.innerHTML = `<div class="cf-outcome ${data.ok ? 'ok' : 'bad'}">${md(data.message || data.error || '')}</div>`;
    }
    if (data.ok && data.state) { STATE = data.state; renderAll(); }
    else { loadState().catch(() => {}); }
    // 把结果作为一个 Agent 消息追加到对话（与服务端持久化记录一致）
    const div = document.createElement('div');
    div.className = 'msg agent';
    div.innerHTML = `<div class="avatar">银</div><div class="bubble">${md(data.message || data.error || '')}</div>`;
    chatScroll().appendChild(div);
    scrollBottom();
  } catch (e) {
    if (resultBox) resultBox.innerHTML = `<div class="cf-outcome bad">${esc('处理失败：' + e.message)}</div>`;
  }
}

const KIND_ICON = { think: '🧠', intent: '🎯', plan: '🗺', tool_call: '🔧', tool_result: '✅', risk: '🛡', confirm: '🔐', system: '⚙️' };
function renderStep(turn, evt) {
  const existing = turn.steps.get(evt.id);
  const why = evt.meta && evt.meta.why;
  const html = `
    <div class="step-title">${KIND_ICON[evt.kind] || '•'} ${esc(evt.title || '')}
      ${evt.meta && evt.meta.tool ? `<span class="step-tag">${esc(evt.meta.tool)}</span>` : ''}
    </div>
    ${evt.detail ? `<div class="step-detail">${esc(evt.detail)}</div>` : ''}
    ${why ? `<div class="why-wrap"><button class="why-toggle" type="button">为什么这么做？</button><div class="step-why" hidden>${esc(why)}</div></div>` : ''}`;
  if (existing) {
    existing.innerHTML = html;
    existing.dataset.status = evt.status || 'done';
    existing.classList.toggle('running', evt.status === 'running');
  } else {
    const div = document.createElement('div');
    div.className = 'step' + (evt.status === 'running' ? ' running' : '');
    div.dataset.kind = evt.kind;
    div.dataset.status = evt.status || 'done';
    div.innerHTML = html;
    turn.trace.appendChild(div);
    turn.steps.set(evt.id, div);
  }
  // 步骤完成后自动折叠历史过程，保持界面清爽
  const steps = Array.from(turn.trace.children);
  if (steps.length > 14) steps.slice(0, steps.length - 14).forEach((s) => { s.style.display = 'none'; });
  scrollBottom();
}

function applyUiPatch(patch) {
  if (!patch) return;
  // 手机端：需要看界面联动时，自动拉出底部银行面板
  if ((patch.scrollTo || patch.focusCards || patch.highlightTxnIds || patch.panelTxns || patch.panelGift || patch.panelSubscriptions || patch.riskPanel) && typeof window.touchPanelAutoOpen === 'function') {
    window.touchPanelAutoOpen();
  }
  if (patch.focusCards) renderCards(patch.focusCards);
  if (patch.panelTxns) {
    PANEL_FILTER = { txns: patch.panelTxns, label: patch.panelLabel || '本次查询' };
    lastHighlightTxn = patch.highlightTxnIds || [];
    renderTxns(lastHighlightTxn);
  } else if (patch.highlightTxnIds) {
    lastHighlightTxn = patch.highlightTxnIds;
    renderTxns(lastHighlightTxn);
  }
  if (patch.riskPanel) {
    if (STATE) STATE.lastPreflight = patch.riskPanel;
    renderRiskBanner(patch.riskPanel);
  }
  if (patch.panelGift) switchTab('cards');
  if (patch.highlightAnomalyIds) {
    renderBills();
    setTimeout(() => {
      const el = document.querySelector('.anomaly-card');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  }
  if (patch.panelSubscriptions) switchTab('bills');
  if (patch.scrollTo) {
    if (patch.scrollTo === 'cards' || patch.scrollTo === 'transactions' || patch.scrollTo === 'transfers') switchTab('cards');
    if (patch.scrollTo === 'audit' || patch.scrollTo === 'profile' || patch.scrollTo === 'security') switchTab('security');
  }
  if (patch.refresh) {
    setTimeout(() => { loadState().catch(() => {}); }, 120);
  }
}

async function send(text) {
  const msg = String(text || '').trim();
  if (BUSY || !msg) return;
  if (msg.length > 500) {
    addUserMsg(msg.slice(0, 500) + '…');
    const t = createTurn();
    t.bubbleWrap.style.display = '';
    t.bubble.innerHTML = md('单条消息请控制在 **500 字**以内（当前 ' + msg.length + ' 字）。这是输入长度保护，避免审计日志与界面被超长文本刷屏。');
    return;
  }
  BUSY = true;
  $('#btnSend').disabled = true;
  addUserMsg(msg);
  const turn = createTurn();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch { /* 非 JSON 响应 */ }
      throw new Error(`HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        handleEvent(evt, turn);
      }
    }
  } catch (e) {
    turn.bubbleWrap.style.display = '';
    turn.bubble.innerHTML = md('⚠️ **请求失败**：' + e.message + '\n\n可能原因：后端服务未启动或已退出。重启方式是在项目目录执行 `npm start`。）');
  } finally {
    BUSY = false;
    $('#btnSend').disabled = false;
    loadState().catch(() => {});
  }
}

function handleEvent(evt, turn) {
  switch (evt.type) {
    case 'step': renderStep(turn, evt); break;
    case 'delta':
      turn.bubbleWrap.style.display = '';
      turn.text += evt.text;
      turn.bubble.innerHTML = md(turn.text);
      scrollBottom();
      break;
    case 'ui': applyUiPatch(evt.patch); break;
    case 'confirm':
      if (evt.action) renderConfirmCard(turn, evt.action);
      break;
    case 'done':
      if (!turn.text) { turn.bubbleWrap.style.display = ''; turn.bubble.innerHTML = md('（本轮未产生回复）'); }
      break;
    default: break;
  }
}

/* ------------------------------ 交互绑定 ------------------------------ */
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
}

function bind() {
  $('#composer').addEventListener('submit', (e) => {    e.preventDefault();
    const input = $('#input');
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    input.style.height = 'auto';
    send(v);
  });

  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    const n = input.value.length;
    $('#counter').textContent = n > 400 ? `${n}/500` : '';
    $('#counter').style.color = n > 500 ? 'var(--danger)' : 'var(--ink-400)';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#btnClearFilter')) return; // 已单独绑定
    const okBtn = e.target.closest('.cf-ok');
    if (okBtn) { doAction(okBtn.closest('.confirm-card'), 'confirm'); return; }
    const cancelBtn = e.target.closest('.cf-cancel');
    if (cancelBtn) { doAction(cancelBtn.closest('.confirm-card'), 'cancel'); return; }
    const ttsBtn = e.target.closest('[data-tts]');
    if (ttsBtn) {
      const text = ttsBtn.getAttribute('data-tts') || '';
      try {
        if (!('speechSynthesis' in window)) { window.alert('当前浏览器不支持语音朗读'); return; }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.0;
        window.speechSynthesis.speak(u);
      } catch (err) { /* 忽略朗读失败 */ }
      return;
    }
    const redeemBtn = e.target.closest('[data-redeem]');
    if (redeemBtn) {
      const id = redeemBtn.dataset.redeem;
      const h = (STATE && STATE.portfolio ? STATE.portfolio.holdings : []).find((x) => x.id === id);
      send(`把${h ? h.name : id}全部赎回`);
      return;
    }
    const undoBtn = e.target.closest('[data-undo]');
    if (undoBtn) { send('撤销最近一笔转账'); return; }
    const cancelSub = e.target.closest('[data-cancel-sub]');    if (cancelSub) {
      const id = cancelSub.dataset.cancelSub;
      const sub = (STATE && STATE.subscriptionsDetail ? STATE.subscriptionsDetail.items : []).find((x) => x.id === id) || (STATE && STATE.subscriptions || []).find((x) => x.id === id);
      send(`把「${sub ? sub.merchant : id}」的自动续费关了`);
      return;
    }
    const gotoConfirm = e.target.closest('[data-goto-confirm]');
    if (gotoConfirm) {
      const card = document.querySelector('.confirm-card:not([data-done])');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else send('我有哪些待确认的操作');
      return;
    }
    const why = e.target.closest('.why-toggle');
    if (why) {
      const box = why.parentElement.querySelector('.step-why');
      if (box) {
        box.hidden = !box.hidden;
        why.textContent = box.hidden ? '为什么这么做？' : '收起解释';
      }
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) { send(chip.dataset.q); return; }
    const quick = e.target.closest('.quick');
    if (quick) { send(quick.dataset.q); return; }
    const tab = e.target.closest('.tab');
    if (tab) { switchTab(tab.dataset.tab); return; }
  });

  const toggle = $('#panelToggle');
  const backdrop = $('#panelBackdrop');
  const bankPanel = document.querySelector('.bank-panel');
  window.touchPanelAutoOpen = () => {
    if (!bankPanel) return;
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    bankPanel.classList.add('open');
    if (backdrop) backdrop.classList.add('show');
    if (toggle) toggle.textContent = '✕ 收起';
  };
  if (toggle && bankPanel) {
    toggle.addEventListener('click', () => {
      const open = !bankPanel.classList.contains('open');
      bankPanel.classList.toggle('open', open);
      if (backdrop) backdrop.classList.toggle('show', open);
      toggle.textContent = open ? '✕ 收起' : '🏦 银行面板';
    });
    if (backdrop) backdrop.addEventListener('click', () => {
      bankPanel.classList.remove('open');
      backdrop.classList.remove('show');
      toggle.textContent = '🏦 银行面板';
    });
  }

  $('#btnClear').addEventListener('click', async () => {
    chatScroll().innerHTML = '';
    lastHighlightTxn = [];
    PANEL_FILTER = null;
    renderTxns([]);
    try { await fetch('/api/conversation/clear', { method: 'POST' }); } catch { /* 忽略 */ }
    if (STATE) STATE.conversation = [];
  });

  $('#btnReset').addEventListener('click', async () => {
    const res = await fetch('/api/reset', { method: 'POST' });
    const data = await res.json();
    STATE = data.state;
    lastHighlightTxn = [];
    PANEL_FILTER = null;
    renderAll();
  });
}

/* ------------------------------ 恢复刷新前的对话（服务端持久化） ------------------------------ */
function restoreConversation() {
  const conv = (STATE && STATE.conversation) || [];
  if (!conv.length) {
    // 首屏问候（根据本地时间与用户名，带点人味）
    const h = new Date().getHours();
    const tod = h < 5 ? '凌晨好' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    const name = (STATE && STATE.user && STATE.user.name) || '你';
    const box = chatScroll();
    const div = document.createElement('div');
    div.className = 'msg agent';
    div.innerHTML = `<div class="avatar">银</div><div class="bubble">${md(`**${tod}，${name}！** 我是 **银枢·AI银行副驾** 😊\n\n你可以像跟人说话一样直接说需求——转账、看账单、查订阅、买理财、安排生日都行。涉及钱的每一步，我都会先把关键信息和风险讲清楚，**你点头我才动**。\n\n想试试的话：`)}</div>`;
    box.appendChild(div);
    scrollBottom();
  }
  const box = chatScroll();
  const divider = document.createElement('div');
  divider.className = 'chat-divider';
  divider.textContent = `以下为刷新前的对话记录（共 ${conv.length} 条，由服务端持久化恢复）`;
  box.appendChild(divider);
  for (const m of conv) {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.role === 'user' ? 'user' : 'agent');
    div.innerHTML = `<div class="avatar">${m.role === 'user' ? '我' : '银'}</div><div class="bubble">${md(m.text)}</div>`;
    box.appendChild(div);
  }
  scrollBottom();
}

/* ------------------------------ 启动 ------------------------------ */
(async function boot() {
  bind();
  await loadHealth();
  try { await loadState(); }
  catch (e) { console.error(e); }
  restoreConversation();
  setInterval(() => { loadState().catch(() => {}); }, 15000);
})();
