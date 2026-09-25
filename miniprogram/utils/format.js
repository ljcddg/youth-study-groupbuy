// utils/format.js — 状态字典与格式化工具

// 拼团状态
const GROUP_STATUS = {
  ongoing: '进行中',
  closed: '已关闭',
};
const GROUP_STATUS_CLASS = {
  ongoing: 'st-ongoing',
  closed: 'st-closed',
};

// 付款状态（需求文档第 6 节）
const PAY_STATUS = {
  unpaid: '未付款',
  pending: '待确认',
  confirmed: '已确认',
  rejected: '已驳回',
  cancelled: '已取消',
};
const PAY_STATUS_CLASS = {
  unpaid: 'st-unpaid',
  pending: 'st-pending',
  confirmed: 'st-confirmed',
  rejected: 'st-rejected',
  cancelled: 'st-cancelled',
};

// 成团申请状态
const APPLY_STATUS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已撤回',
};
const APPLY_STATUS_CLASS = {
  pending: 'st-pending',
  approved: 'st-confirmed',
  rejected: 'st-rejected',
  cancelled: 'st-cancelled',
};

// 成员参与的套餐：价格固定，由成员自己选（年票 / 次票），团长不参与定价
const PLANS = [
  { key: 'year', name: '年票', title: '包年年卡', price: 698, desc: '全年 48 场活动，每周六一场' },
  { key: 'once', name: '次票', title: '单次体验', price: 99, desc: '任选一场活动体验一次' },
];
const PLAN_MAP = {};
PLANS.forEach(function (p) { PLAN_MAP[p.key] = p; });

// 由套餐 key 或金额反查套餐（兼容未存 planKey 的历史成员记录）
function planOf(key, amount) {
  if (key && PLAN_MAP[key]) return PLAN_MAP[key];
  const n = Number(amount || 0);
  for (let i = 0; i < PLANS.length; i++) {
    if (PLANS[i].price === n) return PLANS[i];
  }
  return null;
}

// 金额：数字 → 保留两位的字符串（不带千分位，便于计算展示）
function money(n) {
  const v = Number(n || 0);
  if (!isFinite(v)) return '0.00';
  return v.toFixed(2);
}

// 时间戳/日期 → 2026-09-24 20:18
function datetime(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

// 时间戳/日期 → 2026-09-24
function date(ts) {
  const s = datetime(ts);
  return s ? s.slice(0, 10) : '';
}

// 今天（用于日期选择器默认值）
function today() {
  return date(new Date());
}

// 给列表数据补齐展示字段
function decorateGroup(g, config) {
  const confirmedAmount = Number(g.confirmedAmount || 0);
  return Object.assign({}, g, {
    statusLabel: GROUP_STATUS[g.status] || g.status,
    statusClass: GROUP_STATUS_CLASS[g.status] || 'st-gray',
    confirmedAmountText: money(confirmedAmount),
    unitAmountText: money(g.unitAmount),
    createdAtText: datetime(g.createdAt),
  });
}

function decorateMember(m) {
  const plan = planOf(m.planKey, m.amount);
  return Object.assign({}, m, {
    payStatusLabel: PAY_STATUS[m.payStatus] || m.payStatus,
    payStatusClass: PAY_STATUS_CLASS[m.payStatus] || 'st-gray',
    amountText: money(m.amount),
    planKey: m.planKey || (plan ? plan.key : ''),
    planName: plan ? plan.name : '',
    planText: plan ? plan.name + ' · ¥' + plan.price : '¥' + money(m.amount),
    createdAtText: datetime(m.createdAt),
    payTimeText: datetime(m.payTime),
  });
}

module.exports = {
  PLANS,
  PLAN_MAP,
  planOf,
  GROUP_STATUS,
  GROUP_STATUS_CLASS,
  PAY_STATUS,
  PAY_STATUS_CLASS,
  APPLY_STATUS,
  APPLY_STATUS_CLASS,
  money,
  datetime,
  date,
  today,
  decorateGroup,
  decorateMember,
};
