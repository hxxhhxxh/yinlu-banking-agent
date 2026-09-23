'use strict';
/**
 * 本地模拟数据（沙箱）—— 不接任何真实银行/支付接口。
 * 使用确定性随机种子，保证每次启动/重置后数据完全一致，方便现场演示复现。
 */
const { security } = require('../config');

/* ------------------------------ 确定性随机 ------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const between = (rng, min, max) => min + rng() * (max - min);
const intBetween = (rng, min, max) => Math.floor(between(rng, min, max + 1));
const round2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------ 静态字典 ------------------------------ */
// 演示用户：稳健型（C2）。正是"不能推荐高风险产品"的关键演示点。
const DEMO_USER = {
  id: 'U20260001',
  name: '黄鑫',
  phone: '138****6621',
  city: '南京',
  level: '钻石',
  riskLevel: 'C2',
  riskLevelName: '稳健型',
  riskAssessedAt: '2026-03-18',
  riskAssessmentValid: true,
};

const CARDS = [
  {
    id: 'CARD_D1', kind: 'debit', name: '银枢储蓄卡', brand: '银联', level: '金葵花',
    numberMasked: '6225 **** **** 6688', tail: '6688', currency: 'CNY',
    balance: 128640.35, available: 128640.35, status: 'active',
    dailyLimit: 50000, singleLimit: 20000, monthlyLimit: 200000,
    issuedAt: '2019-08-12', color: 'blue',
  },
  {
    id: 'CARD_C1', kind: 'credit', name: '银枢信用卡·金卡', brand: '银联/Visa', level: '金卡',
    numberMasked: '6225 **** **** 2317', tail: '2317', currency: 'CNY',
    creditLimit: 50000, usedCredit: 12340.62, available: 37659.38, status: 'active',
    billDay: 5, repayDay: 25, dailyLimit: 30000, singleLimit: 30000, color: 'teal',
  },
  {
    id: 'CARD_C2', kind: 'credit', name: '银枢信用卡·白金卡', brand: '银联/MasterCard', level: '白金卡',
    numberMasked: '6225 **** **** 8890', tail: '8890', currency: 'CNY',
    creditLimit: 80000, usedCredit: 23110.4, available: 56889.6, status: 'active',
    billDay: 12, repayDay: 2, dailyLimit: 50000, singleLimit: 50000, color: 'indigo',
  },
];

// 5 个常用收款人（"常用名单"是风控白名单，阶段2使用）
const PAYEES = [
  { id: 'P1', name: '王丽华', nickname: '妈', phone: '139****3382', bank: '中国工商银行', accountMasked: '6222 **** **** 4213', relation: 'family', usual: true, remarkHint: ['物业费', '买菜', '生活费'] },
  { id: 'P2', name: '黄建国', nickname: '爸', phone: '137****9014', bank: '中国建设银行', accountMasked: '6217 **** **** 8830', relation: 'family', usual: true, remarkHint: ['生活费'] },
  { id: 'P3', name: '李皓阳', nickname: '室友', phone: '151****2265', bank: '招商银行', accountMasked: '6214 **** **** 6672', relation: 'friend', usual: true, remarkHint: ['AA', '房租', '聚餐'] },
  { id: 'P4', name: '张伟', nickname: '房东', phone: '138****5510', bank: '中国银行', accountMasked: '6216 **** **** 3391', relation: 'other', usual: true, remarkHint: ['房租'] },
  { id: 'P5', name: '王增祥', nickname: '同学', phone: '186****7745', bank: '交通银行', accountMasked: '6222 **** **** 1174', relation: 'friend', usual: true, remarkHint: ['AA', '还款'] },
];

// 4 个订阅/代扣（其中"轻拍云相册"是"老扣我钱的会员"演示标的）
const SUBSCRIPTIONS = [
  { id: 'S1', merchant: '腾讯视频VIP', category: '视频会员', amount: 25, cycle: 'monthly', cardId: 'CARD_C1', nextChargeDate: '2026-09-26', autopay: true, cancellable: true, startedAt: '2024-06-11', payChannel: '微信支付代扣' },
  { id: 'S2', merchant: '网易云音乐·黑胶VIP', category: '音乐会员', amount: 18, cycle: 'monthly', cardId: 'CARD_C1', nextChargeDate: '2026-09-28', autopay: true, cancellable: true, startedAt: '2023-11-02', payChannel: '支付宝代扣' },
  { id: 'S3', merchant: '京东PLUS会员', category: '电商会员', amount: 149, cycle: 'yearly', cardId: 'CARD_C2', nextChargeDate: '2026-11-15', autopay: true, cancellable: true, startedAt: '2024-11-15', payChannel: '京东金融代扣' },
  { id: 'S4', merchant: '轻拍云相册·专业版', category: '工具会员', amount: 30, cycle: 'monthly', cardId: 'CARD_C1', nextChargeDate: '2026-09-25', autopay: true, cancellable: true, startedAt: '2026-03-24', payChannel: '银联免密代扣', note: '余额宝自动续费，已连续扣费 6 次' },
];

// 6 款不同风险等级理财产品（R1~R5，与用户 C2 稳健型的适当性匹配是演示重点）
const PRODUCTS = [
  { id: 'W1', name: '银枢现金宝·货币基金', code: 'YLMMF', riskLevel: 'R1', riskName: '低风险', type: '货币基金', expectedReturn: 1.85, term: '随存随取', minAmount: 1, fee: 0, liquidity: 'T+0', desc: '投资于短期货币工具，本金波动极小，适合存放待用资金。', suitableFor: ['C1', 'C2', 'C3', 'C4', 'C5'] },
  { id: 'W2', name: '稳健添利·固收类理财', code: 'YLFIX90', riskLevel: 'R2', riskName: '中低风险', type: '固定收益类', expectedReturn: 3.25, term: '90 天', minAmount: 1000, fee: 0.2, liquidity: 'T+1', desc: '以债券等固收资产为主，历史回撤小，收益相对稳定。', suitableFor: ['C2', 'C3', 'C4', 'C5'] },
  { id: 'W3', name: '安心存·大额存单（20万起）', code: 'YLCD36', riskLevel: 'R2', riskName: '中低风险', type: '大额存单', expectedReturn: 2.6, term: '3 年', minAmount: 200000, fee: 0, liquidity: '可转让', desc: '存款类产品，受存款保险保障（50 万以内本息全额保障）。', suitableFor: ['C1', 'C2', 'C3', 'C4', 'C5'] },
  { id: 'W4', name: '均衡配置·混合型基金', code: 'YLBLD', riskLevel: 'R3', riskName: '中风险', type: '混合型基金', expectedReturn: 5.8, term: '建议持有 1 年以上', minAmount: 100, fee: 0.6, liquidity: 'T+1', desc: '股债均衡配置，净值会有波动，适合能承受一定回撤的客户。', suitableFor: ['C3', 'C4', 'C5'] },
  { id: 'W5', name: '成长先锋·股票型基金', code: 'YLGROW', riskLevel: 'R4', riskName: '中高风险', type: '股票型基金', expectedReturn: 8.6, term: '建议持有 2 年以上', minAmount: 100, fee: 0.8, liquidity: 'T+1', desc: '主要投资权益市场，净值波动较大，可能出现阶段性亏损。', suitableFor: ['C4', 'C5'] },
  { id: 'W6', name: '优选进取·权益增强策略', code: 'YLADV', riskLevel: 'R5', riskName: '高风险', type: '权益类/衍生品策略', expectedReturn: 11.5, term: '建议持有 3 年以上', minAmount: 10000, fee: 1.2, liquidity: 'T+7', desc: '含衍生品与杠杆策略，净值波动剧烈，极端行情下可能大幅亏损本金。', suitableFor: ['C5'] },
];

/* ------------------------------ 账单生成 ------------------------------ */
const MERCHANTS = {
  餐饮: [['美团外卖', 18, 68], ['瑞幸咖啡', 9, 32], ['肯德基', 25, 65], ['星巴克', 28, 55], ['海底捞', 120, 320], ['沙县小吃', 12, 25], ['麦当劳', 20, 50], ['南京大牌档', 60, 180]],
  交通: [['滴滴出行', 12, 65], ['南京地铁', 2, 8], ['中国石化', 200, 420], ['12306铁路', 40, 320], ['哈啰单车', 1.5, 4], ['停车费', 5, 30]],
  购物: [['京东商城', 60, 900], ['天猫超市', 40, 520], ['淘宝', 30, 680], ['优衣库', 99, 599], ['苏宁易购', 100, 1200], ['拼多多', 15, 260]],
  生活缴费: [['国家电网', 60, 180], ['南京水务', 25, 70], ['港华燃气', 30, 90], ['中国移动', 39, 129], ['物业费', 120, 260]],
  娱乐: [['猫眼电影', 35, 90], ['Steam', 30, 298], ['剧本杀', 88, 168], ['KTV', 120, 380], ['哔哩哔哩', 15, 148]],
  医疗: [['南京鼓楼医院', 80, 460], ['益丰大药房', 25, 160], ['口腔门诊', 200, 1200]],
  教育: [['得到App', 29, 199], ['中国大学MOOC', 39, 299], ['考研资料', 60, 400]],
  住房: [['房租-张伟', 2200, 2200], ['自如服务费', 120, 180]],
  通讯数码: [['Apple Store', 129, 1800], ['京东数码', 199, 2600]],
};
const DEBIT_CATEGORIES = new Set(['生活缴费', '住房', '餐饮', '交通', '医疗', '通讯数码']);
const INCOME_SOURCES = [['工资-银枢科技', 12000, 12000], ['奖学金', 800, 3000], ['兼职收入', 500, 2500], ['退款', 20, 300]];

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 跨场景联动：可预订的本地生活服务（沙箱商品，不接真实商户）
const SERVICES = [
  { id: 'SV-FL1', type: '鲜花', name: '厄瓜多尔玫瑰礼盒（11 支）', price: 268, delivery: '次日达', desc: '含贺卡，可指定送达时间', tags: ['hot', 'mom'] },
  { id: 'SV-FL2', type: '鲜花', name: '向日葵 + 满天星花束', price: 188, delivery: '次日达', desc: '明亮系，适合送给长辈', tags: ['mom'] },
  { id: 'SV-FL3', type: '鲜花', name: '进口郁金香花束（20 支）', price: 388, delivery: '次日达', desc: '附礼袋与贺卡', tags: ['premium'] },
  { id: 'SV-CK1', type: '蛋糕', name: '6 寸慕斯蛋糕', price: 218, delivery: '次日达', desc: '低糖可选，含蜡烛餐具', tags: ['hot'] },
  { id: 'SV-CK2', type: '蛋糕', name: '8 寸水果奶油蛋糕', price: 298, delivery: '次日达', desc: '现做，需提前 1 天下单', tags: [] },
  { id: 'SV-CK3', type: '蛋糕', name: '6 寸冰淇淋蛋糕', price: 258, delivery: '当日达（限市区）', desc: '冷链配送', tags: [] },
];

/**
 * 生成近 6 个月约 300 条账单，内置 4 笔异常交易。
 * @param {string} endDate 演示"今天"（默认 2026-09-22）
 */
function generateTransactions(endDate = new Date('2026-09-22T12:00:00+08:00')) {
  const rng = mulberry32(20260922);
  const txns = [];
  let seq = 1;
  const end = new Date(endDate.getTime());
  const start = new Date(end.getTime());
  start.setDate(start.getDate() - 183); // 约 6 个月

  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    const dow = cursor.getDay();
    const weekendBoost = dow === 0 || dow === 6 ? 1.35 : 1;
    const count = Math.max(0, Math.round(between(rng, 0.5, 2.2) * weekendBoost));
    for (let i = 0; i < count; i++) {
      const category = pick(rng, Object.keys(MERCHANTS));
      const useDebit = DEBIT_CATEGORIES.has(category) || rng() < 0.35;
      const [merchant, lo, hi] = pick(rng, MERCHANTS[category]);
      const amt = round2(between(rng, lo, hi) * (weekendBoost > 1 && category !== '生活缴费' ? 1.1 : 1));
      const hour = intBetween(rng, 7, 22);
      const minute = intBetween(rng, 0, 59);
      const ts = new Date(cursor.getTime());
      ts.setHours(hour, minute, intBetween(rng, 0, 59), 0);
      txns.push({
        id: `T${String(seq++).padStart(5, '0')}`,
        cardId: useDebit ? 'CARD_D1' : (rng() < 0.6 ? 'CARD_C1' : 'CARD_C2'),
        ts: fmtDateTime(ts),
        timestamp: ts.getTime(),
        direction: 'out',
        amount: amt,
        merchant,
        category,
        city: rng() < 0.85 ? DEMO_USER.city : pick(rng, ['上海', '杭州', '苏州']),
        channel: pick(rng, ['银联在线', '扫码支付', '云闪付', '快捷支付', 'POS 消费']),
        anomaly: null,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // ---- 固定注入的异常交易（评审演示点，必须稳定存在）----
  const anomalies = [
    {
      ts: '2026-08-14 22:40:12', cardId: 'CARD_C2', amount: 6880, merchant: '三亚·亚龙湾珠宝行',
      category: '购物', city: '三亚', channel: 'POS 消费',
      anomaly: { type: '异地交易', level: 'high', reason: '交易地点三亚距常用地南京 1600km，且为首次在该商户交易' },
    },
    {
      ts: '2026-09-05 03:12:47', cardId: 'CARD_C1', amount: 4200, merchant: '网络游戏充值（XX互娱）',
      category: '娱乐', city: '南京', channel: '快捷支付',
      anomaly: { type: '深夜大额', level: 'high', reason: '凌晨 03:12 发生 4200 元交易，远超该时段历史均值（≈38 元）' },
    },
    {
      ts: '2026-07-02 15:20:31', cardId: 'CARD_D1', amount: 12800, merchant: '数码城·某通讯经营部',
      category: '通讯数码', city: '南京', channel: 'POS 消费',
      anomaly: { type: '金额突增', level: 'medium', reason: '单笔 12800 元，为该用户近 6 个月第 2 高交易，超出同类目均值 27 倍' },
    },
    {
      ts: '2026-06-18 02:05:09', cardId: 'CARD_C1', amount: 1999, merchant: '境外网站·订阅服务',
      category: '娱乐', city: '境外', channel: '跨境线上',
      anomaly: { type: '异地交易', level: 'medium', reason: '凌晨跨境线上交易，商户为未备案境外主体' },
    },
  ];
  for (const a of anomalies) {
    const ts = new Date(a.ts.replace(' ', 'T') + '+08:00');
    txns.push({
      id: `T${String(seq++).padStart(5, '0')}`,
      cardId: a.cardId, ts: a.ts, timestamp: ts.getTime(),
      direction: 'out', amount: a.amount, merchant: a.merchant,
      category: a.category, city: a.city, channel: a.channel, anomaly: a.anomaly,
    });
  }

  // ---- 收入流水（工资 / 奖学金 / 兼职）----
  for (let m = 0; m < 6; m++) {
    const d = new Date(start.getTime());
    d.setMonth(d.getMonth() + m);
    d.setDate(10);
    if (d > end) break;
    d.setHours(10, intBetween(rng, 0, 30), 0, 0);
    const [src, lo, hi] = pick(rng, INCOME_SOURCES);
    txns.push({
      id: `T${String(seq++).padStart(5, '0')}`,
      cardId: 'CARD_D1', ts: fmtDateTime(d), timestamp: d.getTime(),
      direction: 'in', amount: round2(between(rng, lo, hi)), merchant: src,
      category: '收入', city: DEMO_USER.city, channel: '代发/转入', anomaly: null,
    });
  }

  // ---- 订阅扣费流水（与 SUBSCRIPTIONS 对齐，供"自动识别周期性扣费"使用）----
  for (const sub of SUBSCRIPTIONS) {
    const times = sub.cycle === 'monthly' ? 6 : 1;
    for (let i = 0; i < times; i++) {
      const d = new Date('2026-09-24T09:00:00+08:00');
      d.setMonth(d.getMonth() - i);
      if (sub.cycle === 'yearly') d.setMonth(d.getMonth() - 6);
      if (d > end) continue;
      d.setHours(intBetween(rng, 8, 11), intBetween(rng, 0, 59), 0, 0);
      const t = new Date(d.getTime());
      txns.push({
        id: `T${String(seq++).padStart(5, '0')}`,
        cardId: sub.cardId, ts: fmtDateTime(t), timestamp: t.getTime(),
        direction: 'out', amount: sub.amount, merchant: sub.merchant,
        category: '订阅服务', city: DEMO_USER.city, channel: sub.payChannel,
        anomaly: null, subscriptionId: sub.id, recurring: true,
      });
    }
  }

  txns.sort((a, b) => b.timestamp - a.timestamp);
  return txns;
}

/* ------------------------------ 组装初始状态 ------------------------------ */
function buildSeedState(opts = {}) {
  const endDate = opts.endDate ? new Date(opts.endDate) : new Date('2026-09-22T12:00:00+08:00');
  return {
    meta: {
      project: '银枢·AI银行副驾',
      version: '0.1.0',
      sandbox: true,
      generatedAt: fmtDateTime(endDate),
      demoToday: fmtDate(endDate),
      seed: 20260922,
    },
    user: { ...DEMO_USER },
    cards: JSON.parse(JSON.stringify(CARDS)),
    payees: JSON.parse(JSON.stringify(PAYEES)),
    subscriptions: JSON.parse(JSON.stringify(SUBSCRIPTIONS)),
    products: JSON.parse(JSON.stringify(PRODUCTS)),
    services: JSON.parse(JSON.stringify(SERVICES)),
    giftDraft: null,
    transactions: generateTransactions(endDate),
    // 以下为运行时产生的数据
    holdings: [],
    transfers: [],
    plans: [],          // 定时转账
    aaSplits: [],       // AA 收款
    cardRequests: [],   // 卡片业务
    bookings: [],       // 跨场景联动（鲜花/蛋糕等）
    frozenFunds: [],    // 锁定资金
    auditLog: [],
    // 风控黑名单（模拟公安反诈数据）
    blacklist: [
      { account: '6225 **** **** 9901', bank: '第三方支付', reason: '涉诈黑名单账户（2026-05 公安部通报）', level: 'block' },
      { account: '6217 **** **** 7742', bank: '某村镇银行', reason: '涉诈黑名单账户（2026-08 反诈中心预警）', level: 'block' },
    ],
    smsCodes: [],
    lastTransfer: null,
  };
}

module.exports = {
  buildSeedState,
  fmtDate,
  fmtDateTime,
  round2,
  CARDS,
  PAYEES,
  SUBSCRIPTIONS,
  PRODUCTS,
  SERVICES,
};
