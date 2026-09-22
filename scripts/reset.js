'use strict';
/** 恢复演示初始数据：node scripts/reset.js */
const store = require('../server/store');
const s = store.reset();
console.log('已重置演示数据：');
console.log(`  卡号 ${s.cards.length} 张 / 账单 ${s.transactions.length} 条 / 收款人 ${s.payees.length} 个 / 订阅 ${s.subscriptions.length} 个 / 理财 ${s.products.length} 款`);
