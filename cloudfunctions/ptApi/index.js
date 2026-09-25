// 云函数 ptApi — 用户端 / 团长端业务接口
// 业务闭环：我要成团 → 提交申请 → 管理员审核 → 自动建团 → 分享 → 成员参与 → 付款 → 提交凭证 → 管理员确认
// 关键约束：只有管理员是收款方；系统不做分账、不做子账户、不做自动打款、不做自动结算

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ============ 集合名 ============
const C = {
  users: 'pt_users',              // 用户
  apps: 'pt_applications',        // 成团申请
  groups: 'pt_groups',            // 拼团
  members: 'pt_members',          // 拼团成员（拉客 / 参与记录）
  paycfg: 'pt_pay_configs',       // 收款账户配置（历史留档）
  admins: 'pt_admins',            // 管理员白名单
  cfg: 'pt_config',               // 业务配置
  blacklist: 'pt_blacklist',      // 团长申请黑名单
};

const ALL_COLLECTIONS = Object.keys(C).map((k) => C[k]);

// ============ 微信支付配置 ============
// 商户号（微信支付子商户号）。申请到商户号后把它填进这里（字符串），
// 并在「云开发控制台 → 设置 → 全局设置 → 添加商户号」完成绑定与授权。
// 留空 = 微信支付尚未开通，下单时会返回友好提示，此时仍可用「线下付款 + 上传凭证」。
const SUB_MCH_ID = '';

// 支付结果回调云函数名（回调到本函数自己）
const PAY_CALLBACK_FN = 'ptApi';

// 业务配置默认值（可在管理端「收款配置」页调整）
const DEFAULT_CONFIG = {
  leaderMaxGroups: 1,     // 每个团长最多可创建的拼团数
  minMembers: 0,          // 最低成团人数，0 = 不限制
  contactAdminTip: '',    // 联系管理员提示文案
  saleEndAt: '',          // 限时抢购截止时间（'YYYY-MM-DD HH:mm'，空 = 不展示倒计时）
  viewCount: 0,           // 首页浏览量
};

// 管理员 openid 白名单：存于 pt_admins 集合。
// 首个管理员通过「我的 → 测试管理员功能」按钮自助授权（selfGrantAdmin），
// 之后可在管理端「收款配置与设置 → 管理员」里继续添加其他人。

// ============ 通用工具 ============
function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
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

async function getConfig() {
  try {
    const r = await db.collection(C.cfg).doc('business').get();
    return Object.assign({}, DEFAULT_CONFIG, r.data || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

async function safeGet(coll, where, limit) {
  try {
    const r = await db.collection(coll).where(where).limit(limit || 100).get();
    return r.data || [];
  } catch (e) {
    return [];
  }
}

// 判断用户角色：superadmin > admin > leader > user
async function getRole(openid) {
  let adminTotal = -1;
  try {
    const c = await db.collection(C.admins).count();
    adminTotal = c.total;
  } catch (e) {
    adminTotal = -1;
  }

  if (adminTotal > 0) {
    const r = await safeGet(C.admins, { openid, enabled: true }, 1);
    if (r[0]) return r[0].role === 'superadmin' ? 'superadmin' : 'admin';
  }

  const g = await db.collection(C.groups).where({ leaderOpenid: openid }).limit(1).get();
  if ((g.data || []).length > 0) return 'leader';
  return 'user';
}

// 「测试管理员功能」是否可用：默认关闭（fail-closed）。
// 需在「云开发控制台 → 云函数 → ptApi → 配置 → 环境变量」里显式添加 ALLOW_SELF_GRANT = 1 才生效；
// 上线前在控制台删掉该变量即永久失效，无需改代码重新部署。
// 第二道保险：系统里已有管理员时也返回 false，避免上线后忘了删变量被利用。
async function selfGrantAllowed() {
  if (process.env.ALLOW_SELF_GRANT !== '1') return false;
  try {
    const c = await db.collection(C.admins).count();
    return c.total === 0;
  } catch (e) {
    return true; // 集合不存在 = 还没有管理员，属于首次初始化
  }
}

// 由成员记录汇总拼团统计
function summarize(members) {
  const s = {
    joinedCount: 0,     // 参与人数（不含已取消）
    confirmedCount: 0,  // 已确认人数
    pendingCount: 0,    // 待确认（已提交凭证）
    rejectedCount: 0,   // 已驳回
    unpaidCount: 0,     // 未付款
    cancelledCount: 0,  // 已取消
    confirmedAmount: 0, // 已确认收款总额
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

async function loadGroupMembers(groupId) {
  return safeGet(C.members, { groupId }, 1000);
}

// 拼团统计：只记人数 + 收款（系统职责止于「店家确认收款」）
function groupStats(group, members, config) {
  return summarize(members);
}

function publicGroup(g) {
  // 对外公开的拼团信息（不含内部统计）
  return {
    _id: g._id,
    groupNo: g.groupNo,
    name: g.name,
    desc: g.desc || '',
    leaderOpenid: g.leaderOpenid,
    leaderName: g.leaderName,
    unitAmount: round2(g.unitAmount),
    targetCount: g.targetCount || 0,
    status: g.status,
    createdAt: g.createdAt,
    cover: g.cover || '',
    contactTip: g.contactTip || '',
  };
}

function publicMember(m) {
  return {
    _id: m._id,
    groupId: m.groupId,
    groupName: m.groupName || '',
    leaderName: m.leaderName || '',
    name: m.name,
    phone: m.maskedPhone || m.phone || '',
    planKey: m.planKey || '',
    planName: m.planName || '',
    amount: round2(m.amount),
    remark: m.remark || '',
    payStatus: m.payStatus,
    rejectReason: m.rejectReason || '',
    voucherFileID: m.voucherFileID || '',
    refName: m.refName || '',
    source: m.source || 'self',
    sourceLabel: m.sourceLabel || '自主参与',
    createdAt: m.createdAt,
    payTime: m.payTime || null,
    confirmedAt: m.confirmedAt || null,
  };
}

// 团长 / 管理员视角：保留完整手机号便于联系，同时标记是否已提交凭证
function managerMember(m, myOpenid) {
  const base = publicMember(m);
  return Object.assign(base, {
    phone: m.phone || '',
    hasVoucher: !!m.voucherFileID,
    // 只有本人自己的凭证才回传 fileID，避免他人因云存储权限看到空白图
    voucherFileID: m.openid && m.openid === myOpenid ? m.voucherFileID || '' : '',
  });
}

function maskPhone(p) {
  const s = String(p || '');
  if (s.length !== 11) return s;
  return s.slice(0, 3) + '****' + s.slice(7);
}

// 姓名脱敏：只保留姓氏，其余用 ** 代替（如「王**」「欧阳**」）
function maskName(n) {
  const s = String(n || '').trim();
  if (!s) return '匿名';
  const first = s.slice(0, 1);
  return s.length <= 2 ? first + '**' : first + '**';
}

// 公开报名名单（所有进入详情页的人都能看到，用于「谁已报名」的转化展示）
// 只展示姓氏 + 报名时间，不含手机号
function publicJoiner(m) {
  return {
    name: maskName(m.name),
    isMe: false, // 由调用方按 openid 补标记
    joinedAt: m.createdAt,
  };
}

function sourceInfo(refOpenid, group, refName) {
  if (!refOpenid) return { source: 'self', sourceLabel: '自主参与' };
  if (refOpenid === group.leaderOpenid) {
    return { source: 'leader_share', sourceLabel: '团长' + (group.leaderName || '') + '邀请' };
  }
  return { source: 'member_share', sourceLabel: '成员' + (refName || '') + '转发' };
}

// ============ 微信支付结果回调 ============
// 支付成功后微信会异步回调到这里；必须返回 { errcode: 0 }，否则微信会重复回调。
// 注意幂等：同一笔订单可能被回调多次，已确认的记录不再重复处理。
async function handlePayCallback(event) {
  try {
    if (event.return_code === 'SUCCESS' && event.result_code === 'SUCCESS') {
      const outTradeNo = event.out_trade_no;
      const totalFee = Number(event.total_fee || 0); // 分
      const r = await db.collection(C.members).where({ payOrderNo: outTradeNo }).limit(1).get();
      const m = (r.data || [])[0];
      if (m && m.payStatus !== 'confirmed') {
        const expectFee = Math.round(Number(m.amount || 0) * 100);
        if (totalFee !== expectFee) {
          // 金额不符：不确认，留管理员人工核对
          console.warn('[pay callback] 金额不符', outTradeNo, '回调', totalFee, '应付', expectFee);
          await db.collection(C.members).doc(m._id).update({
            data: { payError: '金额不符：回调 ' + totalFee + ' 分，应付 ' + expectFee + ' 分' },
          });
        } else {
          await db.collection(C.members).doc(m._id).update({
            data: {
              payStatus: 'confirmed',
              payMethod: 'wxpay',
              transactionId: event.transaction_id || '',
              payAmount: totalFee / 100,
              payTime: db.serverDate(),
              confirmedAt: db.serverDate(),
              confirmedBy: 'wxpay',
            },
          });
        }
      }
    }
  } catch (e) {
    console.error('[pay callback] error', e);
  }
  return { errcode: 0, errmsg: 'ok' };
}

// ============ 入口 ============
exports.main = async (event) => {
  // 微信支付结果回调（异步通知）：入参是微信支付 v2 通知参数，带 out_trade_no / return_code，无 action
  if (event && event.out_trade_no && event.return_code) {
    return handlePayCallback(event);
  }

  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;
  const action = event.action;

  try {
    // 任何 action 都先确保集合存在（首次部署后第一次调用即自动建表）
    await ensureCollections();

    switch (action) {
      // ---------------- 登录：返回身份与业务配置 ----------------
      case 'login': {
        const role = await getRole(OPENID);
        const exist = await safeGet(C.users, { openid: OPENID }, 1);
        if (exist[0]) {
          await db.collection(C.users).doc(exist[0]._id).update({
            data: { role, lastLoginAt: db.serverDate() },
          });
        } else {
          await db.collection(C.users).add({
            data: { openid: OPENID, nickname: '', role, createdAt: db.serverDate(), lastLoginAt: db.serverDate() },
          });
        }
        // 最新一条成团申请的状态（用于「我要成团」入口分流：待审核 / 已通过 / 已驳回）
        let apply = null;
        try {
          const ra = await db.collection(C.apps)
            .where({ openid: OPENID })
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();
          const a = (ra.data || [])[0];
          if (a && a.status !== 'approved') apply = { _id: a._id, status: a.status, groupId: a.groupId || '' };
        } catch (e) {
          apply = null;
        }
        const config = await getConfig();
        return {
          ok: true,
          data: {
            openid: OPENID,
            role,
            isAdmin: role === 'admin' || role === 'superadmin',
            isLeader: role === 'leader',
            apply,
            profile: {
              name: exist[0] ? exist[0].name || '' : '',
              phone: exist[0] ? exist[0].phone || '' : '',
              avatarFileID: exist[0] ? exist[0].avatarFileID || '' : '',
            },
            config,
            // 前端据此决定是否显示「测试管理员功能」入口：关闭后按钮自动消失，无需改前端代码
            selfGrantEnabled: await selfGrantAllowed(),
          },
        };
      }

      // ---------------- 业务配置 ----------------
      // ---------------- 首页统计：浏览数 / 团数人数 / 头像墙 / 最新订单 ----------------
      case 'homeStats': {
        // 浏览量 +1（doc 不存在时先建；非原子计数，浏览量场景够用）
        let viewCount = 0;
        try {
          const r0 = await db.collection(C.cfg).doc('business').get();
          viewCount = Number((r0.data || {}).viewCount || 0);
        } catch (e) { viewCount = 0; }
        viewCount += 1;
        try {
          await db.collection(C.cfg).doc('business').update({
            data: { viewCount, lastViewAt: db.serverDate() },
          });
        } catch (e) {
          try { await db.collection(C.cfg).add({ data: { _id: 'business', viewCount } }); } catch (e2) {}
        }

        // 进行中的团 / 参与人次
        const ongoing = await safeGet(C.groups, { status: 'ongoing' }, 1000);
        let joinedCount = 0;
        try {
          const c = await db.collection(C.members).where({ payStatus: _.neq('cancelled') }).count();
          joinedCount = c.total || 0;
        } catch (e) { joinedCount = 0; }

        // 头像墙：最近登录且带头像的用户，最多 21 个（3 行 × 7）
        let recentAvatars = [];
        try {
          const u = await db.collection(C.users).orderBy('lastLoginAt', 'desc').limit(100).get();
          recentAvatars = (u.data || [])
            .filter((x) => x.avatarFileID || x.avatarUrl)
            .slice(0, 21)
            .map((x) => ({ avatarFileID: x.avatarFileID || '', avatarUrl: x.avatarUrl || '' }));
        } catch (e) { recentAvatars = []; }

        // 最新订单：只展示支付成功（confirmed）的最近 5 条，含支付金额
        let recentOrders = [];
        try {
          const o = await db.collection(C.members)
            .where({ payStatus: 'confirmed' })
            .limit(100)
            .get();
          // 按支付时间倒序取前 5 条（内存排序，避免依赖 confirmedAt 索引；缺失回退 createdAt）
          const rows = (o.data || [])
            .sort((a, b) => new Date(b.confirmedAt || b.createdAt || 0) - new Date(a.confirmedAt || a.createdAt || 0))
            .slice(0, 5);
          const oids = [];
          rows.forEach((m) => { if (m.openid && oids.indexOf(m.openid) < 0) oids.push(m.openid); });
          const avatarMap = {};
          if (oids.length) {
            try {
              const us = await db.collection(C.users).where({ openid: _.in(oids) }).limit(10).get();
              (us.data || []).forEach((x) => { avatarMap[x.openid] = x.avatarFileID || x.avatarUrl || ''; });
            } catch (e2) {}
          }
          recentOrders = rows.map((m) => {
            const amt = Number(m.amount || 0);
            const nm = String(m.name || '').trim();
            const planName = m.planName || (amt === 698 ? '年票' : amt === 99 ? '次票' : '拼团');
            return {
              name: nm ? nm.slice(0, 1) + '**' : '研学家长',
              avatarFileID: avatarMap[m.openid] || '',
              planName,
              amount: amt,
              payStatus: m.payStatus || 'unpaid',
              createdAt: m.confirmedAt || m.payTime || m.createdAt, // 显示支付时间
            };
          });
        } catch (e) { recentOrders = []; }

        return {
          ok: true,
          data: {
            viewCount,
            ongoingGroups: ongoing.length,
            joinedCount,
            recentAvatars,
            recentOrders,
          },
        };
      }

      case 'getConfig': {
        return { ok: true, data: await getConfig() };
      }

      // ---------------- 测试管理员：把当前微信设为超级管理员 ----------------
      // 仅用于上线前测试：点「我的 → 测试管理员功能」即自助成为管理员。
      // 开关见 selfGrantAllowed()：默认关闭，且系统已有管理员时自动失效。
      case 'selfGrantAdmin': {
        if (!(await selfGrantAllowed())) return { ok: false, msg: '该功能未开放' };
        await db.collection(C.admins).add({
          data: {
            openid: OPENID,
            name: '超级管理员',
            role: 'superadmin',
            enabled: true,
            selfGranted: true,
            createdAt: db.serverDate(),
          },
        });
        return { ok: true, msg: '已设为管理员', data: { role: 'superadmin' } };
      }

      // ---------------- 个人资料：读取 ----------------
      case 'getProfile': {
        const u = await safeGet(C.users, { openid: OPENID }, 1);
        const p = u[0] || {};
        let avatarUrl = '';
        if (p.avatarFileID) {
          try {
            const t = await cloud.getTempFileURL({ fileList: [p.avatarFileID] });
            const f = (t.fileList || [])[0];
            if (f && f.tempFileURL) avatarUrl = f.tempFileURL;
          } catch (e) {
            /* 忽略 */
          }
        }
        return {
          ok: true,
          data: {
            name: p.name || '',
            phone: p.phone || '',
            avatarFileID: p.avatarFileID || '',
            avatarUrl,
          },
        };
      }

      // ---------------- 个人资料：保存（姓名 + 手机号 + 头像） ----------------
      case 'saveProfile': {
        const { name, phone, avatarFileID } = event;
        if (!name || !String(name).trim()) return { ok: false, msg: '请填写姓名' };
        if (phone && !/^1\d{10}$/.test(String(phone))) return { ok: false, msg: '手机号格式不正确' };

        const u = await safeGet(C.users, { openid: OPENID }, 1);
        const data = {
          name: String(name).trim(),
          phone: String(phone || '').trim(),
          updatedAt: db.serverDate(),
        };
        if (avatarFileID) data.avatarFileID = avatarFileID;

        if (u[0]) {
          await db.collection(C.users).doc(u[0]._id).update({ data });
        } else {
          // 文档不存在时直接插入；若并发下已被其他请求建好，则退化为更新
          try {
            await db.collection(C.users).add({
              data: Object.assign({ openid: OPENID, role: 'user', createdAt: db.serverDate(), lastLoginAt: db.serverDate() }, data),
            });
          } catch (e) {
            await db.collection(C.users).where({ openid: OPENID }).update({ data });
          }
        }
        // 回写一份最新资料，前端可直接用，省一次请求
        const fresh = await safeGet(C.users, { openid: OPENID }, 1);
        const f = fresh[0] || {};
        return {
          ok: true,
          msg: '已保存',
          data: {
            name: f.name || '',
            phone: f.phone || '',
            avatarFileID: f.avatarFileID || '',
          },
        };
      }

      // ---------------- 我要成团：提交申请 ----------------
      case 'submitApplication': {
        // 建团只需姓名 + 手机号；拼团名称由系统自动生成（团长之后可在拼团详情里修改）
        const { name, phone, groupName, desc, unitAmount, targetCount, remark } = event;
        if (!name || !String(name).trim()) return { ok: false, msg: '请填写姓名' };
        if (!/^1\d{10}$/.test(String(phone || ''))) return { ok: false, msg: '请填写正确的手机号' };

        // 黑名单：被拉黑的用户不允许申请成为团长
        const banned = await safeGet(C.blacklist, { openid: OPENID, status: 'active' }, 1);
        if (banned[0]) return { ok: false, msg: '你没有成为团长的权限' };

        // 已有待审核申请，不允许重复提交
        const p = await safeGet(C.apps, { openid: OPENID, status: 'pending' }, 1);
        if (p[0]) return { ok: false, msg: '你有一条申请正在审核中，请等待管理员审批' };

        // 团长可创建无限个拼团（每个拼团都需单独审批），此处不做数量上限
        const myGroups = await safeGet(C.groups, { leaderOpenid: OPENID }, 100);

        // 拼团名称：可不填，按「姓名 + 第N团」自动生成
        let gname = String(groupName || '').trim();
        if (!gname) {
          const seq = myGroups.length + 1;
          gname = String(name).trim() + '的拼团' + (seq > 1 ? '（第' + seq + '团）' : '');
        }

        await db.collection(C.apps).add({
          data: {
            openid: OPENID,
            name: String(name).trim(),
            phone: String(phone),
            groupName: gname,
            desc: String(desc || '').trim(),
            unitAmount: Number(unitAmount || 0),
            targetCount: Number(targetCount || 0),
            remark: String(remark || '').trim(),
            status: 'pending',
            groupId: '',
            reviewRemark: '',
            reviewedBy: '',
            createdAt: db.serverDate(),
            reviewedAt: null,
          },
        });
        return { ok: true, msg: '申请已提交，请等待管理员审核' };
      }

      // ---------------- 我的成团申请 ----------------
      case 'getMyApplication': {
        const r = await db.collection(C.apps)
          .where({ openid: OPENID })
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();
        const a = (r.data || [])[0];
        // 最新一条已通过 = 上一个团已建好，可继续发起新的建团申请 → 视为无待处理申请
        if (!a || a.status === 'approved') return { ok: true, data: null };
        let group = null;
        if (a.groupId) group = await safeGet(C.groups, { _id: a.groupId }, 1);
        return {
          ok: true,
          data: {
            _id: a._id,
            name: a.name,
            phone: maskPhone(a.phone),
            groupName: a.groupName,
            desc: a.desc,
            unitAmount: round2(a.unitAmount),
            targetCount: a.targetCount || 0,
            status: a.status,
            reviewRemark: a.reviewRemark || '',
            createdAt: a.createdAt,
            reviewedAt: a.reviewedAt,
            groupId: a.groupId || '',
            group: group && group[0] ? publicGroup(group[0]) : null,
          },
        };
      }

      // ---------------- 撤回待审核申请 ----------------
      case 'cancelApplication': {
        const { id } = event;
        const a = await safeGet(C.apps, { _id: id, openid: OPENID }, 1);
        if (!a[0]) return { ok: false, msg: '未找到该申请' };
        if (a[0].status !== 'pending') return { ok: false, msg: '该申请已被处理，无法撤回' };
        await db.collection(C.apps).doc(id).update({ data: { status: 'cancelled', cancelledAt: db.serverDate() } });
        return { ok: true, msg: '已撤回申请' };
      }

      // ---------------- 我的拼团（我是团长的） ----------------
      case 'getMyGroups': {
        const list = await safeGet(C.groups, { leaderOpenid: OPENID }, 100);
        const config = await getConfig();
        const data = [];
        for (const g of list) {
          const members = await loadGroupMembers(g._id);
          data.push(Object.assign(publicGroup(g), groupStats(g, members, config)));
        }
        data.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return { ok: true, data: { list: data, config } };
      }

      // ---------------- 团长维护拼团信息 ----------------
      case 'updateGroup': {
        const { groupId, name, desc, unitAmount, targetCount } = event;
        const g = await safeGet(C.groups, { _id: groupId, leaderOpenid: OPENID }, 1);
        if (!g[0]) return { ok: false, msg: '未找到你创建的该拼团' };
        if (g[0].status !== 'ongoing') return { ok: false, msg: '拼团已关闭，不能再修改' };
        const data = {};
        if (name && String(name).trim()) data.name = String(name).trim();
        if (desc != null) data.desc = String(desc).trim();
        if (unitAmount != null && Number(unitAmount) >= 0) data.unitAmount = Number(unitAmount);
        if (targetCount != null) data.targetCount = Number(targetCount || 0);
        data.updatedAt = db.serverDate();
        await db.collection(C.groups).doc(groupId).update({ data });
        return { ok: true, msg: '已保存' };
      }

      // ---------------- 团长关闭拼团 ----------------
      case 'closeGroup': {
        const { groupId } = event;
        const g = await safeGet(C.groups, { _id: groupId, leaderOpenid: OPENID }, 1);
        if (!g[0]) return { ok: false, msg: '未找到你创建的该拼团' };
        if (g[0].status !== 'ongoing') return { ok: false, msg: '该拼团当前状态不支持关闭' };
        await db.collection(C.groups).doc(groupId).update({
          data: { status: 'closed', closedAt: db.serverDate(), closedBy: 'leader' },
        });
        return { ok: true, msg: '拼团已关闭，不再接受新成员' };
      }

      // ---------------- 团长大厅：搜索 / 浏览已建成的拼团 ----------------
      // 只有管理员审核通过并已建团的拼团才会出现在这里（即 pt_groups 中的记录）
      // 支持按 拼团名称 / 团长姓名 / 团长手机号 / 拼团编号 搜索
      case 'searchHall': {
        const { keyword, status } = event;
        const config = await getConfig();
        const kw = String(keyword || '').trim();

        const base = {};
        if (status && status !== 'all') base.status = status;

        let list;
        try {
          const coll = db.collection(C.groups);
          if (kw) {
            const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const reg = db.RegExp({ regexp: safe, options: 'i' });
            list = await coll
              .where(
                _.or([
                  Object.assign({}, base, { name: reg }),
                  Object.assign({}, base, { leaderName: reg }),
                  Object.assign({}, base, { leaderPhone: reg }),
                  Object.assign({}, base, { groupNo: reg }),
                ])
              )
              .orderBy('createdAt', 'desc')
              .limit(100)
              .get();
          } else {
            list = await coll.where(base).orderBy('createdAt', 'desc').limit(100).get();
          }
        } catch (e) {
          list = { data: [] };
        }

        const rows = [];
        for (const g of list.data || []) {
          const members = await loadGroupMembers(g._id);
          const s = summarize(members);
          rows.push(
            Object.assign(publicGroup(g), {
              joinedCount: s.joinedCount,
              confirmedCount: s.confirmedCount,
              leaderPhoneMasked: maskPhone(g.leaderPhone),
              isMine: g.leaderOpenid === OPENID,
              myJoined: members.some((m) => m.openid === OPENID && m.payStatus !== 'cancelled'),
            })
          );
        }

        // 进行中的排前面，其余按创建时间倒序
        rows.sort((a, b) => {
          const pa = a.status === 'ongoing' ? 0 : 1;
          const pb = b.status === 'ongoing' ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });

        const ongoingCount = rows.filter((r) => r.status === 'ongoing').length;
        return { ok: true, data: { list: rows, total: rows.length, ongoingCount, config } };
      }

      // ---------------- 拼团详情（分享落地页） ----------------
      case 'getGroupDetail': {
        const { groupId } = event;
        if (!groupId) return { ok: false, msg: '缺少拼团参数' };
        const g = await safeGet(C.groups, { _id: groupId }, 1);
        if (!g[0]) return { ok: false, msg: '拼团不存在或已被删除' };
        const group = g[0];
        const config = await getConfig();
        const members = await loadGroupMembers(groupId);
        const isLeader = group.leaderOpenid === OPENID;
        const role = await getRole(OPENID);
        const isAdmin = role === 'admin' || role === 'superadmin';

        // 普通成员只看到自己的参与记录；团长、管理员只看到「已支付」的成员台账
        const mine = members.filter((m) => m.openid === OPENID).map((m) => managerMember(m, OPENID));
        const all = isLeader || isAdmin
          ? members.filter((m) => m.payStatus === 'confirmed').map((m) => managerMember(m, OPENID))
          : [];

        // 公开统计：仅参与人数（已确认收款金额属内部统计，不对普通用户开放）
        const s = summarize(members);

        // 公开报名名单：所有进入详情页的人都能看到，用于「谁已报名」的从众转化展示
        const joiners = members
          .filter((m) => m.payStatus !== 'cancelled')
          .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
          .map((m) => {
            const j = publicJoiner(m);
            j.isMe = m.openid === OPENID;
            return j;
          });

        return {
          ok: true,
          data: {
            group: publicGroup(group),
            isLeader,
            isAdmin,
            joinedCount: s.joinedCount,
            targetCount: group.targetCount || 0,
            joiners,
            myMembers: mine,
            members: all,
            stats: isLeader || isAdmin ? groupStats(group, members, config) : null,
            config,
          },
        };
      }

      // ---------------- 参与拼团（记录一条拉客台账） ----------------
      case 'joinGroup': {
        const { groupId, name, phone, amount, remark, refOpenid } = event;
        if (!groupId) return { ok: false, msg: '缺少拼团参数' };
        if (!name || !String(name).trim()) return { ok: false, msg: '请填写你的姓名' };
        if (!/^1\d{10}$/.test(String(phone || ''))) return { ok: false, msg: '请填写正确的手机号' };

        const g = await safeGet(C.groups, { _id: groupId }, 1);
        if (!g[0]) return { ok: false, msg: '拼团不存在' };
        const group = g[0];
        if (group.status !== 'ongoing') return { ok: false, msg: '该拼团已关闭，无法参与' };

        // 已参与且未取消 → 直接返回原记录
        const mine = await safeGet(C.members, { groupId, openid: OPENID }, 10);
        const active = mine.find((m) => m.payStatus !== 'cancelled');
        if (active) return { ok: true, msg: '你已参与该拼团', data: { memberId: active._id, existed: true } };

        const amt = amount == null || amount === '' ? Number(group.unitAmount || 0) : Number(amount);
        if (!(amt >= 0)) return { ok: false, msg: '金额填写有误' };

        // 推荐人（用于拉客留痕）
        let refName = '';
        if (refOpenid && refOpenid !== OPENID) {
          const u = await safeGet(C.users, { openid: refOpenid }, 1);
          refName = (u[0] && u[0].nickname) || '';
        }
        const src = sourceInfo(refOpenid && refOpenid !== OPENID ? refOpenid : '', group, refName);

        const res = await db.collection(C.members).add({
          data: {
            groupId,
            groupName: group.name,
            leaderOpenid: group.leaderOpenid,
            leaderName: group.leaderName,
            openid: OPENID,
            name: String(name).trim(),
            phone: String(phone),
            maskedPhone: maskPhone(phone),
            amount: amt,
            remark: String(remark || '').trim(),
            payStatus: 'unpaid',
            voucherFileID: '',
            rejectReason: '',
            refOpenid: refOpenid || '',
            refName,
            source: src.source,
            sourceLabel: src.sourceLabel,
            createdAt: db.serverDate(),
            payTime: null,
            confirmedAt: null,
            confirmedBy: '',
          },
        });
        return { ok: true, msg: '已加入，请按页面提示完成付款', data: { memberId: res._id } };
      }

      // ---------------- 我的参与记录 ----------------
      // 先做一次「自动认领」：用个人资料里的姓名 + 手机号，把团长/管理员代录的
      // （openid 为空）记录绑定到当前微信，这样代录的记录会直接出现在「我的参与」里，
      // 无需用户手动查找。只认领 openid 为空且姓名手机号完全一致的记录，不抢占他人。
      case 'getMyJoins': {
        try {
          const u = await safeGet(C.users, { openid: OPENID }, 1);
          const me = u[0] || {};
          const nm = String(me.name || '').trim();
          const ph = String(me.phone || '').trim();
          if (nm && /^1\d{10}$/.test(ph)) {
            const pend = await db.collection(C.members)
              .where({ name: nm, phone: ph, openid: '' })
              .limit(50)
              .get();
            for (const m of (pend.data || [])) {
              if (m.payStatus === 'cancelled') continue;
              try {
                await db.collection(C.members).doc(m._id).update({
                  data: { openid: OPENID, claimedAt: db.serverDate(), claimFrom: 'auto' },
                });
              } catch (e) { /* 忽略单条失败 */ }
            }
          }
        } catch (e) { /* 自动认领失败不影响列表查询 */ }

        const r = await db.collection(C.members)
          .where({ openid: OPENID })
          .orderBy('createdAt', 'desc')
          .limit(100)
          .get();
        return { ok: true, data: (r.data || []).map(publicMember) };
      }

      // ---------------- 单条参与记录（付款页用） ----------------
      case 'getMember': {
        const { memberId } = event;
        const r = await safeGet(C.members, { _id: memberId, openid: OPENID }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该参与记录' };
        const g = await safeGet(C.groups, { _id: r[0].groupId }, 1);
        return {
          ok: true,
          data: {
            member: publicMember(r[0]),
            group: g[0] ? publicGroup(g[0]) : null,
          },
        };
      }

      // ---------------- 微信支付：统一下单 ----------------
      // 用 cloud.cloudPay.unifiedOrder 生成预支付单，返回 payment 给前端 wx.requestPayment
      case 'wxPayOrder': {
        const { memberId } = event;
        if (!memberId) return { ok: false, msg: '缺少参与记录' };

        const r = await safeGet(C.members, { _id: memberId, openid: OPENID }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该参与记录' };
        const m = r[0];
        if (m.payStatus === 'confirmed') return { ok: false, msg: '该记录已支付，无需重复支付' };

        // 应付金额（元）只允许套餐价：年票 698 / 次票 99
        const price = Number(m.amount || 0);
        const ALLOWED = [698, 99];
        if (ALLOWED.indexOf(price) < 0) return { ok: false, msg: '应付金额异常，请联系管理员' };
        const totalFee = Math.round(price * 100); // 微信支付金额单位为「分」

        if (!SUB_MCH_ID) return { ok: false, msg: '微信支付正在开通中，请先联系客服付款' };

        // 商户订单号：32 字符内，只能用数字 / 大小写字母 / _ -
        const outTradeNo = 'PT' + Date.now() + String(Math.floor(Math.random() * 900) + 100);

        let order;
        try {
          order = await cloud.cloudPay.unifiedOrder({
            body: '能量少年研学-' + (m.planName || '拼团报名'),
            outTradeNo,
            spbillCreateIp: '127.0.0.1',
            subMchId: SUB_MCH_ID,
            totalFee,
            envId: wxContext.ENV,          // 云开发环境 ID（回调所在环境）
            functionName: PAY_CALLBACK_FN, // 支付结果回调到本函数
            tradeType: 'JSAPI',
            openid: OPENID,
            attach: memberId,
          });
        } catch (e) {
          console.error('[wxPayOrder] unifiedOrder fail', e);
          return { ok: false, msg: '下单失败：' + friendlyError(e) };
        }

        if (!order || !order.payment) {
          return { ok: false, msg: '下单失败，请稍后再试' };
        }

        // 记录订单号，供支付回调对账定位
        try {
          await db.collection(C.members).doc(memberId).update({
            data: { payOrderNo: outTradeNo, payOrderAt: db.serverDate() },
          });
        } catch (e) { /* 忽略 */ }

        return { ok: true, data: { payment: order.payment, outTradeNo } };
      }

      // ---------------- 取消参与 ----------------
      case 'cancelJoin': {
        const { memberId } = event;
        const r = await safeGet(C.members, { _id: memberId, openid: OPENID }, 1);
        if (!r[0]) return { ok: false, msg: '未找到该参与记录' };
        if (r[0].payStatus === 'confirmed') return { ok: false, msg: '已确认的参与不能取消，请联系管理员' };
        if (r[0].payStatus === 'pending') return { ok: false, msg: '凭证正在核实中，不能取消' };
        await db.collection(C.members).doc(memberId).update({
          data: { payStatus: 'cancelled', cancelledAt: db.serverDate() },
        });
        return { ok: true, msg: '已取消参与' };
      }

      default:
        return { ok: false, msg: '未知操作：' + action };
    }
  } catch (err) {
    console.error('[ptApi] action=' + action + ' error:', err);
    return { ok: false, msg: '服务异常：' + friendlyError(err) };
  }
};
