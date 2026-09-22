'use strict';
/**
 * 全链路彩排（阶段 6）：一条命令把 6 个场景按演示顺序跑一遍并计时。
 *
 *   npm run rehearsal        # 需先 npm start
 *
 * 输出：每个场景的实际指令、系统反应、耗时，并生成 docs/彩排报告.md
 * 说明：这里测的是"系统响应与正确性"；现场的 180 秒主要由演讲人的口播占用，
 *      脚本里的预估口播时长用于核对总时长是否可控。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'docs', '彩排报告.md');

const tally = { ok: 0, bad: 0 };
const results = [];
let scenarioNo = 0;

const j = async (u, o) => (await fetch(u, o)).json();
const post = (u, b) => j(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

async function chat(message) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  });
  const rd = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ } }
    }
  }
  return { events, ms: Date.now() - t0, text: events.filter((e) => e.type === 'delta').map((e) => e.text).join('') };
}

function check(label, cond, extra = '') {
  if (cond) { tally.ok++; console.log(`    ✓ ${label}${extra ? ' — ' + extra : ''}`); }
  else { tally.bad++; console.log(`    ✗ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

function scenario(name, say, expectTalkSec, ms) {
  scenarioNo++;
  results.push({ no: scenarioNo, name, say, expectTalkSec, ms });
  console.log(`\n[场景 ${scenarioNo}] ${name}　（口播预估 ${expectTalkSec}s）`);
}

(async () => {
  const st0 = await post(BASE + '/api/reset', {});
  console.log('='.repeat(64));
  console.log('  银枢·AI银行副驾 · 全链路彩排');
  console.log('='.repeat(64));
  console.log(`  起始状态：余额 ¥${st0.state.totals.totalAssets} | 订阅 ${st0.state.subscriptionsDetail.activeCount} | 异常 ${st0.state.anomalies.flagged} | 账单 ${st0.state.billStats.txnCount} 条`);

  /* ---------- 场景① 智能转账 + 风控拦截 ---------- */
  scenario('智能转账 + 风控拦截', '给我妈转两千块交物业费 → 确认；再问可疑转账', 30, 0);
  let t = Date.now();
  const a1 = await chat('给我妈转两千块交物业费');
  console.log(`    你说：「给我妈转两千块交物业费」（${a1.ms}ms）`);
  check('生成待确认单（未确认不扣款）', a1.events.some((e) => e.type === 'confirm'));
  const ce1 = a1.events.find((e) => e.type === 'confirm');
  const bal1 = (await j(BASE + '/api/state')).totals.totalAssets;
  const done1 = await post(BASE + '/api/action/confirm', { actionId: ce1.action.id, code: ce1.action.sandboxCode });
  check('确认后真实扣款 2000', done1.state.totals.totalAssets === bal1 - 2000, `${bal1} → ${done1.state.totals.totalAssets}`);
  const a2 = await chat('给陈小雨转两万，尾号7742，有没有风险');
  console.log(`    你说：「给陈小雨转两万，尾号7742，有没有风险」（${a2.ms}ms）`);
  check('★高光A 涉诈黑名单已拦截', a2.text.includes('已拦截'), '不生成确认入口');
  check('未生成待确认单（拦截级不放行）', !a2.events.some((e) => e.type === 'confirm'));
  const a3 = await chat('撤销最近一笔转账');
  const ce3 = a3.events.find((e) => e.type === 'confirm');
  const up = await post(BASE + '/api/action/confirm', { actionId: ce3.action.id, code: ce3.action.sandboxCode });
  check('撤销后资金原路返回', up.state.totals.totalAssets === bal1, `→ ${up.state.totals.totalAssets}`);
  results[results.length - 1].ms = Date.now() - t;

  /* ---------- 场景② 账单分析 + 异常识别 ---------- */
  scenario('账单分析 + 异常识别', '上个月的钱都花哪了？有没有不对劲的？', 18, 0);
  t = Date.now();
  const b1 = await chat('上个月的钱都花哪了？有没有不对劲的？');
  console.log(`    你说：「上个月的钱都花哪了？有没有不对劲的？」（${b1.ms}ms）`);
  const toolsB = b1.events.filter((e) => e.type === 'step' && e.meta && e.meta.tool).map((e) => e.meta.tool);
  check('一句话触发两步规划（账单 + 异常）', toolsB.includes('analyze_bills') && toolsB.includes('detect_anomalies'), toolsB.join('+'));
  check('回答含分类统计与风险分', b1.text.includes('支出合计') && b1.text.includes('风险分'));
  results[results.length - 1].ms = Date.now() - t;

  /* ---------- 场景③ 订阅管理 ---------- */
  scenario('订阅/代扣管理', '有哪些订阅在扣我钱 → 把那个老扣我钱的会员关了', 15, 0);
  t = Date.now();
  const c1 = await chat('有哪些订阅在扣我钱');
  console.log(`    你说：「有哪些订阅在扣我钱」（${c1.ms}ms）`);
  check('自动识别周期性扣费', c1.text.includes('自动识别'));
  check('给出续费提前提醒', c1.text.includes('续费提醒'));
  const c2 = await chat('把那个老扣我钱的会员关了');
  const ce5 = c2.events.find((e) => e.type === 'confirm');
  check('模糊表述定位到具体订阅', Boolean(ce5), ce5 ? ce5.action.title.slice(0, 24) : '');
  const cc = await post(BASE + '/api/action/confirm', { actionId: ce5.action.id });
  check('取消后活跃订阅 4 → 3', cc.state.subscriptionsDetail.activeCount === 3);
  results[results.length - 1].ms = Date.now() - t;

  /* ---------- 场景④ 理财 + 适当性 ---------- */
  scenario('理财推荐与适当性拦截', '拿一万块买理财挑收益最高的 → 拿五千块买现金宝', 18, 0);
  t = Date.now();
  const d1 = await chat('拿一万块买理财，帮我挑个收益最高的');
  console.log(`    你说：「拿一万块买理财，帮我挑个收益最高的」（${d1.ms}ms）`);
  check('★题眼：明确屏蔽超等级产品', d1.text.includes('已按适当性屏蔽'));
  const d2 = await chat('申购成长先锋1000块');
  check('高风险产品被拒（无确认入口）', !d2.events.some((e) => e.type === 'confirm') && (d2.text.includes('超出你的风险等级') || d2.text.includes('没有执行')));
  const d3 = await chat('拿五千块买现金宝');
  const ce6 = d3.events.find((e) => e.type === 'confirm');
  check('待确认单带风险提示文本（可朗读）', Boolean(ce6 && ce6.action.riskDisclosure));
  const db = (await j(BASE + '/api/state')).totals.totalAssets;
  const dp = await post(BASE + '/api/action/confirm', { actionId: ce6.action.id, code: ce6.action.sandboxCode });
  check('≥¥5,000 验证码确认后扣款建仓', dp.ok === true && dp.state.portfolio.count === 1, `余额 ${db} → ${dp.state.totals.totalAssets}`);
  results[results.length - 1].ms = Date.now() - t;

  /* ---------- 场景⑤ 卡片挂失 ---------- */
  scenario('卡片挂失（立即冻结 + 回执）', '我那张白金卡找不到了，先挂失', 15, 0);
  t = Date.now();
  const e1 = await chat('我那张白金卡找不到了，先挂失');
  const ce7 = e1.events.find((e) => e.type === 'confirm');
  check('挂失需二次确认（含验证码）', Boolean(ce7 && ce7.action.needsSms));
  const lf = await post(BASE + '/api/action/confirm', { actionId: ce7.action.id, code: ce7.action.sandboxCode });
  const lostCard = lf.state.cards.find((c) => c.name.includes('白金'));
  check('卡片立即冻结并标记已挂失', lostCard.status === 'frozen' && lostCard.lost === true);
  check('返回含受理编号的回执', String(lf.receipt || lf.message).includes('受理编号'));
  results[results.length - 1].ms = Date.now() - t;

  /* ---------- 场景⑥ 跨场景联动（高光 B） ---------- */
  scenario('跨场景联动：一句话安排生日（★高光B）', '下周我妈生日帮我安排 → 下周三五百左右花和蛋糕都要', 44, 0);
  t = Date.now();
  const f1 = await chat('下周我妈生日，帮我安排一下');
  console.log(`    你说：「下周我妈生日，帮我安排一下」（${f1.ms}ms）`);
  check('Agent 主动补问（日期/预算/形式）', f1.text.includes('预算') && !f1.events.some((e) => e.type === 'confirm'));
  const f2 = await chat('下周三，五百左右，花和蛋糕都要');
  console.log(`    你说：「下周三，五百左右，花和蛋糕都要」（${f2.ms}ms）`);
  check('上下文承接为补充信息', f2.events.some((e) => e.type === 'step' && String(e.title).includes('上下文续问')));
  check('方案合计 ¥486（预算内留 ¥14）', f2.text.includes('486'));
  const ce8 = f2.events.find((e) => e.type === 'confirm');
  const fb = (await j(BASE + '/api/state')).totals.totalAssets;
  const fd = await post(BASE + '/api/action/confirm', { actionId: ce8.action.id, code: ce8.action.sandboxCode });
  check('生成 2 笔真实订单', fd.state.bookings.length === 2);
  check('余额净扣 486', fd.state.totals.totalAssets === fb - 486, `${fb} → ${fd.state.totals.totalAssets}`);
  check('生成配送提醒', fd.state.reminders.length === 1);
  check('锁定资金已结算（无悬挂）', fd.state.frozenFunds.length === 0);
  results[results.length - 1].ms = Date.now() - t;

  /* ---------- 汇总 ---------- */
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  const talkSec = results.reduce((a, r) => a + r.expectTalkSec, 0);
  console.log('\n' + '='.repeat(64));
  console.log('  彩排结果');
  console.log('='.repeat(64));
  console.log('  场景'.padEnd(34) + '口播预估'.padEnd(10) + '系统耗时');
  for (const r of results) {
    console.log(`  ${String(r.no)}. ${r.name}`.padEnd(34) + `${r.expectTalkSec}s`.padEnd(10) + `${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log('-'.repeat(64));
  console.log(`  系统总耗时 ${(totalMs / 1000).toFixed(1)}s ｜ 口播预估合计 ${talkSec}s ｜ 开场+收尾约 40s`);
  console.log(`  预计现场总时长约 ${talkSec + 40}s（目标 ≤180s）${talkSec + 40 <= 180 ? ' ✅' : ' ⚠️ 需要压缩'}`);
  console.log(`  断言：通过 ${tally.ok} 项，失败 ${tally.bad} 项`);

  // 写报告
  const lines = [];
  lines.push('# 彩排报告（自动生成）');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}（本地时区 Asia/Shanghai）`);
  lines.push(`> 命令：\`npm run rehearsal\`　起始余额：¥${st0.state.totals.totalAssets}`);
  lines.push('');
  lines.push(`**结论：断言通过 ${tally.ok} 项，失败 ${tally.bad} 项。**`);
  lines.push('');
  lines.push('| 场景 | 口播预估 | 系统耗时 |');
  lines.push('| --- | --- | --- |');
  for (const r of results) lines.push(`| ${r.no}. ${r.name} | ${r.expectTalkSec}s | ${(r.ms / 1000).toFixed(1)}s |`);
  lines.push(`| **合计** | **${talkSec}s**（+开场收尾约 40s） | **${(totalMs / 1000).toFixed(1)}s** |`);
  lines.push('');
  lines.push(`预计现场总时长约 **${talkSec + 40} 秒**，${talkSec + 40 <= 180 ? '在 180 秒目标内 ✅' : '超出 180 秒，需压缩口播 ⚠️'}`);
  lines.push('');
  lines.push('## 各场景指令与检查点');
  lines.push('');
  for (const r of results) {
    lines.push(`### 场景 ${r.no}：${r.name}`);
    lines.push('');
    lines.push(`口播：${r.say}`);
    lines.push('');
  }
  lines.push('## 说明');
  lines.push('');
  lines.push('1. 本脚本直接打后端真实接口（对话 → 待确认 → 确认执行），全部金额变动都来自真实账本。');
  lines.push('2. 系统耗时含 Agent 刻意的流式节奏（让评委看清思考过程），现场由口播覆盖，用户无等待感。');
  lines.push('3. 每次彩排都会先 `reset` 到演示初始态，可反复运行。');
  try {
    fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
    console.log(`  报告已写入：${path.relative(ROOT, REPORT)}`);
  } catch (e) { console.log('  报告写入失败：' + e.message); }

  await post(BASE + '/api/reset', {});
  console.log('  演示数据已复位。');
  console.log('='.repeat(64));
  process.exit(tally.bad ? 1 : 0);
})().catch((e) => { console.error('彩排异常：', e); process.exit(2); });
