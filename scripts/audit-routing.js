'use strict';
/**
 * 意图路由审计：npm run audit
 *
 * 覆盖：① 现场演示脚本原话 ② 常见口语变体 ③ 历史上容易冲突的成对表达
 * 目的：确保"一句话被错误意图抢走"不再发生（历史上修过 5 类冲突）。
 * 注意：比对 intent（意图名）而非工具名——虚拟卡与实体卡共用 apply_card 工具，但意图必须区分。
 */
process.env.YINLU_EPHEMERAL = '1';
const local = require('../server/agent/localEngine');
const tools = require('../server/agent/tools');
const isImpl = (t) => { const x = tools.get(t); return Boolean(x && x.implemented); };

const CASES = [
  // ===== 现场演示脚本原话（3 分钟剧本） =====
  ['储蓄卡还有多少钱', 'query_balance'],
  ['我有几张卡，额度分别多少', 'query_cards'],
  ['给陈小雨转两万，卡号尾号7742，她催得挺急', 'transfer_money'],
  ['帮我看看给陈小雨转两万，尾号7742，有没有风险', 'preview_transfer'],
  ['上个月的钱都花哪了，有没有不对劲的', 'analyze_bills'],
  ['有哪些订阅在扣我钱', 'list_subscriptions'],
  ['把那个老扣我钱的会员关了', 'cancel_subscription'],
  ['拿一万块买理财，帮我挑个收益最高的', 'recommend_products'],
  ['我那张白金卡找不到了，先挂失', 'report_card_loss'],
  ['下周我妈生日，帮我安排一下', 'gift_concierge'],
  ['给我妈转八百块交物业费', 'transfer_money'],
  ['撤销最近一笔转账', 'undo_last_transfer'],
  ['拿五千块买现金宝', 'purchase_product'],
  ['模拟到期，把生日安排执行了', 'run_scheduled'],
  // ===== 口语变体 =====
  ['帮我看看我的卡', 'query_cards'],
  ['我的可用额度有多少', 'query_cards'],
  ['信用卡还能刷多少', 'query_cards'],
  ['卡里还有多少钱', 'query_balance'],
  ['我这个月花了多少', 'analyze_bills'],
  ['帮我统计一下上个月的开销', 'analyze_bills'],
  ['看一下今年的年度账单', 'analyze_bills'],
  ['有没有异常交易', 'detect_anomalies'],
  ['我的卡是不是被盗刷了', 'detect_anomalies'],
  ['帮我把房租转给房东', 'transfer_money'],
  ['我妈转两万没问题吧', 'preview_transfer'],
  ['帮我看看这笔转账有没有风险', 'preview_transfer'],
  ['看看我的转账记录', 'query_transfers'],
  ['每月1号给房东转2200房租', 'schedule_transfer'],
  ['我们四个人吃饭花了800，跟室友和同学AA', 'split_aa_collect'],
  ['帮我取消腾讯视频的自动续费', 'cancel_subscription'],
  ['退订网易云音乐', 'cancel_subscription'],
  ['我的理财赚了多少', 'query_holdings'],
  ['帮我做个风险评估', 'assess_risk'],
  ['帮我做风险测评', 'assess_risk'],
  ['把现金宝全部赎回', 'redeem_product'],
  ['我想办一张白金卡', 'apply_card'],
  ['帮我办一张虚拟卡', 'apply_virtual_card'],
  ['把白金卡解挂', 'report_card_unfreeze'],
  ['把储蓄卡的交易密码改一下', 'change_password'],
  ['密码忘了怎么办', 'change_password'],
  ['回退上一步', 'undo_last_action'],
  // ===== 易冲突成对表达 =====
  ['把金卡额度提到六万', 'adjust_credit_limit'],
  ['帮我把额度降到三万', 'adjust_credit_limit'],
  ['额度能不能提高一点', 'adjust_credit_limit'],
  ['把信用卡单笔限额降到 5000', 'set_card_limit'],
  ['帮我把这张卡冻结', 'set_card_limit'],
  ['卡片锁了，帮我解开', 'set_card_limit'],
  ['把卡解冻', 'set_card_limit'],
  ['你好', 'smalltalk'],
  ['在吗', 'smalltalk'],
  ['谢谢', 'smalltalk'],
  // ===== 应当识别不了（走兜底引导，绝不瞎猜） =====
  ['阿巴阿巴随便说说', null],
  ['帮我', null],
];

let bad = 0;
const lines = [];
for (const [text, expect] of CASES) {
  const r = local.resolveIntent(text, isImpl);
  const got = r.rule ? r.rule.intent : null;
  const pass = got === expect;
  if (!pass) bad++;
  lines.push(`${pass ? '  OK  ' : '  FAIL'} 「${text}」 → ${got || '(未识别)'}${pass ? '' : '　期望：' + (expect || '(未识别)')}`);
}
console.log('意图路由审计 · 共 %d 句', CASES.length);
console.log(lines.join('\n'));
console.log('\n结果：通过 %d，不符合期望 %d', CASES.length - bad, bad);
process.exit(bad ? 1 : 0);
