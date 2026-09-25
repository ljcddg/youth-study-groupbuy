// 云函数 ptAdmin — 管理端业务接口（只有管理员 / 超级管理员可调用）
// 功能：成团申请审核 / 拼团管理 / 付款凭证确认 / 台账统计与导出 / 收款配置 / 管理员管理
// 关键约束：不做分账、不做子账户、不做自动打款、不做自动结算。
// 系统职责边界：止于「店家确认收款」，之后的线下分钱不纳入系统。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const C = {
  users: 'pt_users',
  apps: 'pt_applications',
  groups: 'pt_groups',
  members: 'pt_members',
  paycfg: 'pt_pay_configs',
  admins: 'pt_admins',
  cfg: 'pt_config',
  blacklist: 'pt_blacklist',
};

const ALL_COLLECTIONS = Object.keys(C).map((k) => C[k]);

const DEFAULT_CONFIG = {
  leaderMaxGroups: 1,
  minMembers: 0,
  contactAdminTip: '',
};

// 驳回成团申请时，管理员没填原因就用这句委婉提示（用户申请页会看到）
const REJECT_DEFAULT_MSG = '很抱歉，你的申请被外星人带走啦，暂时无法通过～ 如有疑问请联系客服。';

const PAY_STATUS = { unpaid: '未付款', pending: '待确认', confirmed: '已确认', rejected: '已驳回', cancelled: '已取消' };
const GROUP_STATUS = { ongoing: '进行中', closed: '已关闭' };

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

async function safeGet(coll, where, limit) {
  try {
    const r = await db.collection(coll).where(where).limit(limit || 100).get();
    return r.data || [];
  } catch (e) {
    return [];
  }
}

async function getConfig() {
  try {
    const r = await db.collection(C.cfg).doc('business').get();
    return Object.assign({}, DEFAULT_CONFIG, r.data || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

// 自动创建所需集合，省去手工建表。
// 仅在「全部成功」时缓存结果；没全成功则下次调用继续重试，避免一次失败后永久失效。
let COLLECTIONS_READY = false;
async function ensureCollections() {
  if (COLLECTIONS_READY) return true;
  if (typeof db.createCollection !== 'function') return false;
  let allOk = true;
  for (const name of ALL_COLLECTIONS) {
    try {
      await db.createCollection(name);
    } catch (e) {
      const code = (e && (e.errCode || e.code)) || 0;
      const msg = String((e && (e.errMsg || e.message)) || '');
      // 已存在算成功
      if (code === -501001 || /already exist/i.test(msg)) continue;
      allOk = false;
      console.warn('[createCollection failed] ' + name + ' code=' + code + ' msg=' + msg);
    }
  }
  if (allOk) COLLECTIONS_READY = true;
  return allOk;
}

// 把数据库原始报错翻成人话，避免一长串英文糊在用户脸上
function friendlyError(err) {
  const raw = (err && (err.errMsg || err.message)) || '';
  if (/DATABASE_COLLECTION_NOT_EXIST|-502005/.test(raw)) {
    const m = raw.match(/(pt_[a-z_]+)/);
    return (
      '数据库集合尚未创建' +
      (m ? '（缺 ' + m[1] + '）' : '') +
      '。请到「云开发控制台 → 数据库」手动创建 pt_ 开头的集合后重试。'
    );
  }
  return raw || '请稍后再试';
}

// 鉴权：返回 { role, name } 或 null
async function checkAdmin(openid) {
  const r = await safeGet(C.admins, { openid, enabled: true }, 1);
  if (!r[0]) return null;
  return { role: r[0].role === 'superadmin' ? 'superadmin' : 'admin', name: r[0].name || '管理员' };
}

function summarize(members) {
  const s = {
    joinedCount: 0,
    confirmedCount: 0,
    pendingCount: 0,
    rejectedCount: 0,
    unpaidCount: 0,
    cancelledCount: 0,
    confirmedAmount: 0,
  };
  const byStatus = { unpaid: 0, pending: 0, confirmed: 0, rejected: 0, cancelled: 0 };
  (members || []).forEach((m) => {
    const st = m.payStatus || 'unpaid';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (st === 'cancelled') {
      s.cancelledCount++;
      return;
    }
    s.joinedCount++;
    if (st === 'confirmed') {
      s.confirmedCount++;
      s.confirmedAmount += Number(m.amount || 0);
    }
  });
  s.pendingCount = byStatus.pending;
  s.rejectedCount = byStatus.rejected;
  s.unpaidCount = byStatus.unpaid;
  s.confirmedAmount = round2(s.confirmedAmount);
  return s;
}

function groupStats(group, members, config) {
  return summarize(members);
}

function maskPhone(p) {
  const s = String(p || '');
  if (s.length !== 11) return s;
  return s.slice(0, 3) + '****' + s.slice(7);
}

function viewMember(m) {
  return {
    _id: m._id,
    groupId: m.groupId,
    groupName: m.groupName || '',
    leaderName: m.leaderName || '',
    name: m.name,
    phone: m.phone || '',
    maskedPhone: m.maskedPhone || maskPhone(m.phone),
    amount: round2(m.amount),
    remark: m.remark || '',
    payStatus: m.payStatus || 'unpaid',
    payStatusLabel: PAY_STATUS[m.payStatus || 'unpaid'],
    rejectReason: m.rejectReason || '',
    voucherFileID: m.voucherFileID || '',
    refName: m.refName || '',
    source: m.source || 'self',
    sourceLabel: m.sourceLabel || '自主参与',
    createdAt: m.createdAt,
    payTime: m.payTime || null,
    confirmedAt: m.confirmedAt || null,
    voucherUrl: m.voucherUrl || '',
    submitCount: m.submitCount || 0,
  };
}

function viewGroup(g) {
  return {
    _id: g._id,
    groupNo: g.groupNo,
    name: g.name,
    desc: g.desc || '',
    leaderOpenid: g.leaderOpenid || '',
    leaderName: g.leaderName || '',
    leaderPhone: g.leaderPhone || '',
    unitAmount: round2(g.unitAmount),
    targetCount: g.targetCount || 0,
    status: g.status,
    statusLabel: GROUP_STATUS[g.status] || g.status,
    createdAt: g.createdAt,
    closedAt: g.closedAt || null,
  };
}

// 批量把云存储 fileID 换成可访问的临时链接（管理员可读他人上传的凭证）
async function withTempUrls(members, field) {
  const ids = (members || []).map((m) => m[field]).filter(Boolean);
  if (!ids.length) return members;
  let urlMap = {};
  try {
    const res = await cloud.getTempFileURL({ fileList: ids });
    (res.fileList || []).forEach((f) => {
      if (f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL;
    });
  } catch (e) {
    /* 忽略，前端仍可用 fileID 直接渲染 */
  }
  return members.map((m) => Object.assign({}, m, { voucherUrl: urlMap[m[field]] || '' }));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

// ============ 入口 ============
exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;
  const action = event.action;

  // 先确保集合存在：否则下面 checkAdmin 读 pt_admins 会失败，误报「无管理员权限」
  try {
    await ensureCollections();
  } catch (e) {
    /* 忽略：按实际情况返回 */
  }

  const me = await checkAdmin(OPENID);
  if (!me) {
    return { ok: false, msg: '无管理员权限。请先在「我的 → 测试管理员功能」把自己设为管理员。' };
  }

  try {
    switch (action) {
      // ---------------- 工作台统计 ----------------
      case 'dashboard': {
        const config = await getConfig();
        let pendingApps = 0;
        let pendingPay = 0;
        let ongoing = 0;
        let total = 0;
        try {
          pendingApps = (await db.collection(C.apps).where({ status: 'pending' }).count()).total;
          pendingPay = (await db.collection(C.members).where({ payStatus: 'pending' }).count()).total;
          ongoing = (await db.collection(C.groups).where({ status: 'ongoing' }).count()).total;
          total = (await db.collection(C.groups).count()).total;
        } catch (e) {
          /* 集合尚未创建时忽略 */
        }
        const groups = await safeGet(C.groups, {}, 1000);
        const members = await safeGet(C.members, {}, 1000);
        const s = summarize(members);
        const closed = groups.filter((g) => g.status === 'closed').length;
        return {
          ok: true,
          data: {
            pendingApps,
            pendingPay,
            ongoing,
            total,
            closed,
            joinedCount: s.joinedCount,
            confirmedCount: s.confirmedCount,
            confirmedAmount: s.confirmedAmount,
            role: me.role,
            adminName: me.name,
            config,
          },
        };
      }

      // ---------------- 成团申请列表 ----------------
      case 'listApplications': {
        const { status, keyword } = event;
        const where = {};
        if (status && status !== 'all') where.status = status;
        let list;
        try {
          list = await db.collection(C.apps).where(where).orderBy('createdAt', 'desc').limit(200).get();
        } catch (e) {
          list = { data: [] };
        }
        let data = (list.data || []).map((a) => ({
          _id: a._id,
          name: a.name,
          phone: a.phone,
          maskedPhone: maskPhone(a.phone),
          groupName: a.groupName,
          desc: a.desc || '',
          unitAmount: round2(a.unitAmount),
          targetCount: a.targetCount || 0,
          remark: a.remark || '',
          status: a.status,
          reviewRemark: a.reviewRemark || '',
          groupId: a.groupId || '',
          createdAt: a.createdAt,
          reviewedAt: a.reviewedAt,
        }));
        const kw = String(keyword || '').trim();
        if (kw) {
          data = data.filter(
            (a) =>
              (a.name || '').indexOf(kw) >= 0 ||
              (a.phone || '').indexOf(kw) >= 0 ||
              (a.groupName || '').indexOf(kw) >= 0
          );
        }
        const counts = { all: data.length, pending: 0, approved: 0, rejected: 0, cancelled: 0 };
        data.forEach((a) => {
          if (counts[a.status] != null) counts[a.status]++;
        });
        return { ok: true, data: { list: data, counts } };
      }

      // ---------------- 审核成团申请 ----------------
      case 'reviewApplication': {
        const { id, approve, remark, unitAmount, blacklist } = event;
        const r = await safeGet(C.apps, { _id: id }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该申请' };
        const a = r[0];
        if (a.status !== 'pending') return { ok: false, msg: '该申请已处理过' };

        if (!approve) {
          await db.collection(C.apps).doc(id).update({
            data: {
              status: 'rejected',
              reviewRemark: String(remark || '').trim() || REJECT_DEFAULT_MSG,
              reviewedBy: me.name,
              reviewerOpenid: OPENID,
              reviewedAt: db.serverDate(),
            },
          });

          // 可选：同时把该用户加入黑名单（之后不能再申请成为团长）
          if (blacklist) {
            const already = await safeGet(C.blacklist, { openid: a.openid, status: 'active' }, 1);
            if (!already[0]) {
              await db.collection(C.blacklist).add({
                data: {
                  openid: a.openid,
                  name: a.name,
                  phone: a.phone,
                  reason: String(remark || '').trim() || '管理员拉黑',
                  byOpenid: OPENID,
                  byName: me.name,
                  status: 'active',
                  createdAt: db.serverDate(),
                  restoredAt: null,
                },
              });
            }
            return { ok: true, msg: '已驳回并加入黑名单' };
          }
          return { ok: true, msg: '已驳回该申请' };
        }

        // 审核通过：立即创建拼团，申请人成为团长（不限制团长可创建的拼团数量）
        const d = new Date();
        const p = (n) => (n < 10 ? '0' + n : '' + n);
        const groupNo =
          'PT' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + String(Math.floor(Math.random() * 9000) + 1000);

        const added = await db.collection(C.groups).add({
          data: {
            groupNo,
            name: a.groupName,
            desc: a.desc || '',
            leaderOpenid: a.openid,
            leaderName: a.name,
            leaderPhone: a.phone,
            unitAmount: unitAmount != null ? Number(unitAmount) : Number(a.unitAmount || 0),
            targetCount: Number(a.targetCount || 0),
            status: 'ongoing',
            activityName: '',
            cover: '',
            createdFrom: 'application',
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        });

        await db.collection(C.apps).doc(id).update({
          data: {
            status: 'approved',
            groupId: added._id,
            reviewRemark: String(remark || '').trim(),
            reviewedBy: me.name,
            reviewerOpenid: OPENID,
            reviewedAt: db.serverDate(),
          },
        });

        // 同步用户角色为团长
        const u = await safeGet(C.users, { openid: a.openid }, 1);
        if (u[0]) {
          await db.collection(C.users).doc(u[0]._id).update({ data: { role: 'leader', leaderName: a.name } });
        }

        return { ok: true, msg: '已通过，拼团已自动创建（编号 ' + groupNo + '）', data: { groupId: added._id, groupNo } };
      }

      // ---------------- 拼团列表（含统计） ----------------
      case 'listGroups': {
        const { status, keyword, startDate, endDate } = event;
        const where = {};
        if (status && status !== 'all') where.status = status;
        // 按创建时间范围筛选（createdAt 为 Date 类型）
        if (startDate) {
          const s = new Date(String(startDate).replace(/-/g, '/') + ' 00:00:00');
          if (!isNaN(s.getTime())) where.createdAt = _.gte(s);
        }
        if (endDate) {
          const e = new Date(String(endDate).replace(/-/g, '/') + ' 23:59:59');
          if (!isNaN(e.getTime())) {
            where.createdAt = where.createdAt ? where.createdAt.and(_.lte(e)) : _.lte(e);
          }
        }
        let list;
        try {
          list = await db.collection(C.groups).where(where).orderBy('createdAt', 'desc').limit(200).get();
        } catch (e) {
          list = { data: [] };
        }
        const config = await getConfig();
        const data = [];
        for (const g of list.data || []) {
          const members = await safeGet(C.members, { groupId: g._id }, 1000);
          data.push(Object.assign(viewGroup(g), groupStats(g, members, config)));
        }
        const kw = String(keyword || '').trim();
        const filtered = kw
          ? data.filter(
              (g) => (g.name || '').indexOf(kw) >= 0 || (g.leaderName || '').indexOf(kw) >= 0 || (g.groupNo || '').indexOf(kw) >= 0
            )
          : data;
        return { ok: true, data: { list: filtered, config } };
      }

      // ---------------- 拼团详情（含成员台账、分发记录） ----------------
      case 'groupDetail': {
        const { groupId } = event;
        const g = await safeGet(C.groups, { _id: groupId }, 1);
        if (!g[0]) return { ok: false, msg: '未找到该拼团' };
        const config = await getConfig();
        const members = await safeGet(C.members, { groupId }, 1000);
        // 台账只显示支付成功的成员；统计仍按全部成员计算
        const confirmedMembers = members.filter((m) => m.payStatus === 'confirmed');
        const withUrl = await withTempUrls(confirmedMembers, 'voucherFileID');
        return {
          ok: true,
          data: {
            group: viewGroup(g[0]),
            members: withUrl.map(viewMember).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
            stats: groupStats(g[0], members, config),
            config,
          },
        };
      }

      // ---------------- 作废参与记录 ----------------
      case 'cancelMember': {
        const { memberId, remark } = event;
        const r = await safeGet(C.members, { _id: memberId }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该记录' };
        await db.collection(C.members).doc(memberId).update({
          data: {
            payStatus: 'cancelled',
            cancelRemark: String(remark || '').trim(),
            confirmedBy: me.name,
            cancelledAt: db.serverDate(),
          },
        });
        return { ok: true, msg: '已作废该参与记录' };
      }

      // ---------------- 管理员代录成员（线下拉客补录） ----------------
      case 'addMember': {
        const { groupId, name, phone, planKey, amount, remark, sourceLabel } = event;
        if (!groupId) return { ok: false, msg: '缺少拼团' };
        if (!name || !String(name).trim()) return { ok: false, msg: '请填写姓名' };
        if (!/^1\d{10}$/.test(String(phone || ''))) return { ok: false, msg: '请填写正确的手机号' };
        const g = await safeGet(C.groups, { _id: groupId }, 1);
        if (!g[0]) return { ok: false, msg: '未找到该拼团' };
        // 套餐二选一：年票 698 / 次票 99（管理端代录同样受限）
        const PLAN_PRICE = { year: 698, once: 99 };
        const PLAN_NAME = { year: '年票', once: '次票' };
        let key = PLAN_PRICE[planKey] ? planKey : '';
        let amt = 0;
        if (key) {
          amt = PLAN_PRICE[key];
        } else {
          const n = Number(amount == null || amount === '' ? 0 : amount);
          if (n === PLAN_PRICE.year) key = 'year';
          else if (n === PLAN_PRICE.once) key = 'once';
          amt = n;
        }
        if (!key) return { ok: false, msg: '请选择套餐：年票 ¥698 或 次票 ¥99' };
        await db.collection(C.members).add({
          data: {
            groupId,
            groupName: g[0].name,
            leaderOpenid: g[0].leaderOpenid,
            leaderName: g[0].leaderName,
            openid: '',
            name: String(name).trim(),
            phone: String(phone),
            maskedPhone: maskPhone(phone),
            amount: amt,
            planKey: key,
            planName: PLAN_NAME[key],
            remark: String(remark || '').trim(),
            payStatus: 'unpaid',
            voucherFileID: '',
            refOpenid: '',
            refName: '',
            source: 'admin',
            sourceLabel: String(sourceLabel || '管理员录入').trim(),
            createdAt: db.serverDate(),
            operatorName: me.name,
          },
        });
        return { ok: true, msg: '已录入成员' };
      }

      // ---------------- 关闭拼团 ----------------
      case 'closeGroup': {
        const { groupId, remark } = event;
        const g = await safeGet(C.groups, { _id: groupId }, 1);
        if (!g[0]) return { ok: false, msg: '未找到该拼团' };
        if (g[0].status !== 'ongoing') return { ok: false, msg: '该拼团当前状态不支持关闭' };
        await db.collection(C.groups).doc(groupId).update({
          data: { status: 'closed', closedAt: db.serverDate(), closedBy: me.name, closeRemark: String(remark || '').trim() },
        });
        return { ok: true, msg: '拼团已关闭' };
      }

      // ---------------- 重新开启拼团 ----------------
      case 'reopenGroup': {
        const { groupId } = event;
        const g = await safeGet(C.groups, { _id: groupId }, 1);
        if (!g[0]) return { ok: false, msg: '未找到该拼团' };
        if (g[0].status !== 'closed') return { ok: false, msg: '只有「已关闭」的拼团可以重新开启' };
        await db.collection(C.groups).doc(groupId).update({ data: { status: 'ongoing', closedAt: null } });
        return { ok: true, msg: '拼团已重新开启' };
      }

      // ---------------- 业务配置 ----------------
      case 'saveBusinessConfig': {
        const { leaderMaxGroups, minMembers, contactAdminTip, saleEndAt } = event;
        // 保留已有浏览量（business doc 是整份覆盖，不带上会把 viewCount 清零）
        let prev = {};
        try {
          const r = await db.collection(C.cfg).doc('business').get();
          prev = r.data || {};
        } catch (e) { prev = {}; }
        const data = {
          leaderMaxGroups: Number(leaderMaxGroups != null ? leaderMaxGroups : 1),
          minMembers: Number(minMembers != null ? minMembers : 0),
          contactAdminTip: String(contactAdminTip || '').trim(),
          saleEndAt: String(saleEndAt || '').trim(),
          viewCount: Number(prev.viewCount || 0),
          updatedBy: me.name,
          updatedAt: db.serverDate(),
        };
        try {
          await db.collection(C.cfg).doc('business').set({ data });
        } catch (e) {
          await db.collection(C.cfg).add({ data: Object.assign({ _id: 'business' }, data) });
        }
        return { ok: true, msg: '业务配置已保存', data };
      }

      // ---------------- 管理员管理 ----------------
      case 'listAdmins': {
        let list;
        try {
          list = await db.collection(C.admins).orderBy('createdAt', 'desc').limit(100).get();
        } catch (e) {
          list = { data: [] };
        }
        return {
          ok: true,
          data: {
            list: (list.data || []).map((a) => ({
              _id: a._id,
              openid: a.openid,
              name: a.name || '',
              role: a.role === 'superadmin' ? 'superadmin' : 'admin',
              roleLabel: a.role === 'superadmin' ? '超级管理员' : '管理员',
              enabled: !!a.enabled,
              isMe: a.openid === OPENID,
              createdAt: a.createdAt,
            })),
          },
        };
      }

      case 'addAdmin': {
        if (me.role !== 'superadmin') return { ok: false, msg: '只有超级管理员可以添加管理员' };
        const { openid, name } = event;
        if (!openid || !String(openid).trim()) return { ok: false, msg: '请填写对方的 openid' };
        const exists = await safeGet(C.admins, { openid: String(openid).trim() }, 1);
        if (exists[0]) return { ok: false, msg: '该用户已经是管理员了' };
        await db.collection(C.admins).add({
          data: {
            openid: String(openid).trim(),
            name: String(name || '').trim() || '管理员',
            role: 'admin', // 甲方授权的都是普通管理员
            enabled: true,
            createdBy: me.name,
            createdAt: db.serverDate(),
          },
        });
        return { ok: true, msg: '已添加管理员' };
      }

      case 'toggleAdmin': {
        if (me.role !== 'superadmin') return { ok: false, msg: '只有超级管理员可以启停管理员' };
        const { id, enabled } = event;
        const r = await safeGet(C.admins, { _id: id }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该管理员' };
        if (r[0].role === 'superadmin') return { ok: false, msg: '不能停用超级管理员' };
        await db.collection(C.admins).doc(id).update({ data: { enabled: !!enabled, updatedAt: db.serverDate() } });
        return { ok: true, msg: enabled ? '已启用' : '已停用' };
      }

      case 'removeAdmin': {
        const { id } = event;
        if (me.role !== 'superadmin') return { ok: false, msg: '只有超级管理员可以删除管理员' };
        const r = await safeGet(C.admins, { _id: id }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该管理员' };
        if (r[0].role === 'superadmin') return { ok: false, msg: '不能删除超级管理员' };
        if (r[0].openid === OPENID) return { ok: false, msg: '不能删除自己' };
        await db.collection(C.admins).doc(id).remove();
        return { ok: true, msg: '已删除' };
      }

      // ---------------- 用户列表（用于找 openid 加管理员） ----------------
      case 'listUsers': {
        const { keyword } = event;
        let list;
        try {
          list = await db.collection(C.users).orderBy('createdAt', 'desc').limit(200).get();
        } catch (e) {
          list = { data: [] };
        }
        let data = (list.data || []).map((u) => ({
          _id: u._id,
          openid: u.openid,
          nickname: u.nickname || '',
          role: u.role || 'user',
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt,
        }));
        const kw = String(keyword || '').trim();
        if (kw) data = data.filter((u) => (u.openid || '').indexOf(kw) >= 0 || (u.nickname || '').indexOf(kw) >= 0);
        return { ok: true, data: { list: data, myOpenid: OPENID } };
      }

      // ---------------- 黑名单列表 ----------------
      case 'listBlacklist': {
        let list;
        try {
          list = await db.collection(C.blacklist).where({ status: 'active' }).limit(200).get();
        } catch (e) {
          list = { data: [] };
        }
        const data = (list.data || []).map((b) => ({
          _id: b._id,
          openid: b.openid,
          name: b.name || '',
          phone: b.phone || '',
          reason: b.reason || '',
          byName: b.byName || '',
          createdAt: b.createdAt,
        }));
        return { ok: true, data: { list: data } };
      }

      // ---------------- 移出黑名单 ----------------
      case 'restoreBlacklist': {
        const { id } = event;
        if (!id) return { ok: false, msg: '缺少参数' };
        await db.collection(C.blacklist).doc(id).update({
          data: { status: 'restored', restoredAt: db.serverDate(), restoredBy: me.name },
        });
        return { ok: true, msg: '已移出黑名单' };
      }

      default:
        return { ok: false, msg: '未知操作：' + action };
    }
  } catch (err) {
    console.error('[ptAdmin] action=' + action + ' error:', err);
    return { ok: false, msg: '服务异常：' + friendlyError(err) };
  }
};
