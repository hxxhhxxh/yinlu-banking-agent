'use strict';
/**
 * 配置加载：读取 .env（零依赖手写解析）+ 进程环境变量。
 * 安全约束：API Key 只在此文件（后端）被读取，前端永远拿不到。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
const get = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (fileEnv[k] || d));

const config = {
  ROOT,
  PORT: Number(get('PORT', '8787')),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR: path.join(ROOT, 'data'),
  STATE_FILE: path.join(ROOT, 'data', 'runtime-state.json'),
  llm: {
    baseUrl: get('LLM_BASE_URL', '').replace(/\/+$/, ''),
    apiKey: get('LLM_API_KEY', ''),
    model: get('LLM_MODEL', ''),
  },
  get llmEnabled() {
    return Boolean(this.llm.baseUrl && this.llm.apiKey && this.llm.model);
  },
  // 系统级安全阈值（阶段2 起逐步落地；阶段7 对齐赛题三、核心技术要求）
  security: {
    confirmThreshold: 5000,      // ≥5000 元的高风险操作必须二次确认（保留：更保守的额外门槛）
    nightStartHour: 23,          // 夜间时段起点（23:00）
    nightEndHour: 6,             // 夜间时段终点（06:00）
    roundAmountStep: 10000,      // 整数大额判定步长（10000 的整数倍）
    smsCodeTTLms: 120000,        // 模拟短信验证码有效期 2 分钟

    // ---- 赛题口径：三级权限（绿/黄/红）----
    yellowDailyMax: 1000,        // 黄色：当日累计转账 ≤ ¥1,000 → 用户确认
    redDailyOver: 1000,          // 红色：当日累计转账 > ¥1,000 → 多因子强验证
    redFactors: ['sms', 'face'], // 红色操作需同时通过的因子（沙箱模拟短信与人脸）

    // ---- 异常熔断 ----
    circuitBreaker: {
      maxFailures: 3,            // 窗口内失败/可疑次数上限
      windowMs: 10 * 60 * 1000,  // 统计窗口 10 分钟
      lockMs: 5 * 60 * 1000,     // 锁定时长 5 分钟
    },
  },
};

module.exports = config;
