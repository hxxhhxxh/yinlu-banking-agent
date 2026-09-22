'use strict';
/**
 * 中文口语解析工具：金额、时间、人名、分类等。
 * 用于"本地意图引擎"（离线演示模式），也可作为大模型输出缺失时的兜底。
 */
const CN_NUM = { 零: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

/** 中文数字 → 阿拉伯数字（支持 两千 / 一万五 / 三千二 / 十五） */
function cnToNumber(s) {
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0, section = 0, num = 0;
  for (const ch of s) {
    if (CN_NUM[ch] !== undefined) { num = CN_NUM[ch]; continue; }
    const unit = CN_UNIT[ch];
    if (unit !== undefined) {
      if (unit >= 10000) { section = (section + (num || 0)) * unit; total += section; section = 0; }
      else { section += (num || 1) * unit; }
      num = 0;
      continue;
    }
  }
  let v = total + section + num;
  // 处理"一万五"这类省略：一万五 = 15000
  if (/万[一二两三四五六七八九]$/.test(s)) v += 0; // 已由 num 承载个位，单位万已在 total
  return v;
}

/** 从口语中提取金额：支持 2000 / 2,000 / 两千 / 1.5万 / 两万五 / 2000块
 *  注意：会先剔除“尾号/卡号/账号/手机号”后面的数字，避免把账号当成金额。 */
function parseAmount(text) {
  if (!text) return null;
  // 0) 剔除账号类数字（尾号7742 / 卡号 1234 5678 / 手机号138…），
  //    若数字后面紧跟"元/块"等金额单位，则不剔除（那是金额不是账号）
  let t = String(text).replace(
    /(尾号|卡号|账号|账户|手机号|手机|电话|工号)([\s:：]*)([0-9＊*]{4,}(?:\s[0-9＊*]{4,})*)(?!\s*(?:元|块|块钱))/g,
    ' '
  );
  // 0b) 剔除日期/时间/人数等非金额数字（"每月1号"的 1、"4个人"的 4 都不是金额）
  t = t
    .replace(/(\d{1,2})\s*月\s*(\d{1,2})?\s*[日号]?/g, ' ')
    .replace(/(\d{1,2})\s*[日号]/g, ' ')
    .replace(/(\d{1,2})\s*(点|点钟|时)/g, ' ')
    .replace(/(\d{1,2})\s*(周|星期)/g, ' ')
    .replace(/(\d+)\s*个?\s*人/g, ' ');

  // 1) 阿拉伯数字 + 可选 w/万/千 单位
  let m = t.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(万|w|W|千|k|K)?\s*(?:元|块|块钱|人民币|rmb)?/);
  if (m) {
    let v = Number(m[1].replace(/,/g, ''));
    const unit = m[2];
    if (unit === '万' || unit === 'w' || unit === 'W') v *= 10000;
    if (unit === '千' || unit === 'k' || unit === 'K') v *= 1000;
    if (!isNaN(v) && v > 0) return v;
  }
  // 2) 纯中文数字
  m = t.match(/([零一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖]+)\s*(?:元|块|块钱)?/);
  if (m) {
    const v = cnToNumber(m[1]);
    if (!isNaN(v) && v > 0) return v;
  }
  return null;
}

/** 提取"上个月/这个月/近三个月/今年"等时间范围 */
function parseTimeRange(text) {
  const t = String(text || '');
  const now = new Date('2026-09-22T12:00:00+08:00');
  const y = now.getFullYear(), mo = now.getMonth();
  const mk = (label, from, to) => ({ label, from, to });
  if (/上上?个?月|上月/.test(t)) {
    const f = new Date(y, mo - 1, 1), to = new Date(y, mo, 1);
    return mk('上个月', f.toISOString(), to.toISOString());
  }
  if (/这个月|本月|当月/.test(t)) {
    return mk('本月', new Date(y, mo, 1).toISOString(), new Date(y, mo + 1, 1).toISOString());
  }
  if (/近三?个月|最近三?个月|三个月/.test(t)) {
    return mk('近三个月', new Date(y, mo - 3, 1).toISOString(), new Date(y, mo + 1, 1).toISOString());
  }
  if (/近半?年|六个月/.test(t)) {
    return mk('近六个月', new Date(y, mo - 6, 1).toISOString(), new Date(y, mo + 1, 1).toISOString());
  }
  if (/今年|年度|全年/.test(t)) {
    return mk('今年以来', new Date(y, 0, 1).toISOString(), new Date(y + 1, 0, 1).toISOString());
  }
  if (/去年/.test(t)) {
    return mk('去年', new Date(y - 1, 0, 1).toISOString(), new Date(y, 0, 1).toISOString());
  }
  if (/上周/.test(t)) {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return mk('上周', d.toISOString(), now.toISOString());
  }
  if (/这周|本周/.test(t)) {
    const d = new Date(now); d.setDate(d.getDate() - now.getDay() + 1);
    return mk('本周', d.toISOString(), now.toISOString());
  }
  if (/今天|今日/.test(t)) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return mk('今天', d.toISOString(), now.toISOString());
  }
  return null;
}

/** 提取"明天/后天/下周一/9月25日/每月1号"等日期 */
function parseDate(text) {
  const t = String(text || '');
  const now = new Date('2026-09-22T12:00:00+08:00');
  const d = new Date(now);
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  // 周期性日期优先判断："每月1号"不能被当成"1号"（否则会被误判为一次性转账）
  let m = t.match(/每(?:个)?月\s*(\d{1,2})\s*[日号]/);
  if (m) return { date: fmt(new Date(now.getFullYear(), now.getMonth(), Number(m[1]))), label: `每月${m[1]}日`, monthly: Number(m[1]) };
  if (/每(?:个)?月/.test(t)) return { date: null, label: '每月', monthly: now.getDate() };
  if (/今天|今日/.test(t)) return { date: fmt(d), label: '今天' };
  if (/明天/.test(t)) { d.setDate(d.getDate() + 1); return { date: fmt(d), label: '明天' }; }
  if (/后天/.test(t)) { d.setDate(d.getDate() + 2); return { date: fmt(d), label: '后天' }; }
  if (/大后天/.test(t)) { d.setDate(d.getDate() + 3); return { date: fmt(d), label: '大后天' }; }
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const x = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    return { date: fmt(x), label: `${m[1]}月${m[2]}日` };
  }
  m = t.match(/(\d{1,2})\s*[日号]/);
  if (m) {
    const x = new Date(now.getFullYear(), now.getMonth(), Number(m[1]));
    if (x < now) x.setMonth(x.getMonth() + 1);
    return { date: fmt(x), label: `${x.getMonth() + 1}月${x.getDate()}日` };
  }
  const weekMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  m = t.match(/(下|这|本)?周([一二三四五六日天])/);
  if (m) {
    const target = weekMap[m[2]];
    const cur = d.getDay() || 7;
    let delta = target - cur;
    if (m[1] === '下') delta += 7;
    if (delta <= 0) delta += 7;
    d.setDate(d.getDate() + delta);
    return { date: fmt(d), label: `${m[1] || ''}周${m[2]}` };
  }
  m = t.match(/每(?:个)?月\s*(\d{1,2})\s*[日号]/);
  if (m) return { date: fmt(new Date(now.getFullYear(), now.getMonth(), Number(m[1]))), label: `每月${m[1]}日`, monthly: Number(m[1]) };
  return null;
}
/** 消费分类关键词（口语 → 账单分类） */
const CATEGORY_HINTS = {
  餐饮: ['吃饭', '外卖', '餐厅', '下馆子', '咖啡', '奶茶', '早饭', '午饭', '晚饭', '夜宵', '聚餐', '火锅', '吃'],
  交通: ['打车', '地铁', '公交', '加油', '油费', '火车', '高铁', '出行', '停车', '单车'],
  购物: ['买东西', '购物', '网购', '京东', '淘宝', '天猫', '拼多多', '衣服'],
  生活缴费: ['缴费', '水电', '电费', '水费', '燃气', '话费', '物业费', '宽带'],
  娱乐: ['娱乐', '电影', '游戏', '唱歌', 'KTV', '剧本杀', '会员'],
  医疗: ['看病', '医院', '买药', '药房', '体检', '牙'],
  教育: ['学习', '课程', '培训', '买书', '资料', '考研'],
  住房: ['房租', '租房', '住房', '房贷'],
  通讯数码: ['手机', '数码', '电脑', '相机', '数码产品'],
  订阅服务: ['订阅', '会员', '包月', '自动续费', '扣费'],
  收入: ['工资', '收入', '进账', '到账', '奖学金', '兼职'],
};

function detectCategory(text) {
  const t = String(text || '');
  const hits = [];
  for (const [cat, kws] of Object.entries(CATEGORY_HINTS)) {
    for (const kw of kws) if (t.includes(kw)) { hits.push({ cat, kw, len: kw.length }); break; }
  }
  hits.sort((a, b) => b.len - a.len);
  return hits.length ? hits.map((h) => h.cat) : [];
}

/** 从口语里猜收款人称呼：我妈 / 爸爸 / 室友 / 房东 / 同学 / 给李皓阳 */
function detectPayeeKeyword(text) {
  const t = String(text || '');
  const map = [
    [/(我)?妈|母亲|妈妈/, '妈'],
    [/(我)?爸|父亲|爸爸/, '爸'],
    [/室友|舍友|同宿舍/, '室友'],
    [/房东/, '房东'],
    [/同学/, '同学'],
  ];
  for (const [re, nick] of map) if (re.test(t)) return nick;
  const m = t.match(/给\s*([\u4e00-\u9fa5]{2,4}?)(?=转|打|汇|发|送|付|$)/);
  if (m) return m[1];
  return null;
}

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, '');
}

module.exports = { parseAmount, parseTimeRange, parseDate, detectCategory, detectPayeeKeyword, cnToNumber, normalize };
