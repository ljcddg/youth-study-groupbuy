// 云函数 createOrder — 下单/配置查询/团长/推广绑定/记录查询（多功能入口）
// 依赖：云开发环境 + 微信支付商户号（开通「微信云开发-微信支付」关联）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 微信支付商户号：部署前在云函数「配置-环境变量」里配置 SUB_MCH_ID
const SUB_MCH_ID = process.env.SUB_MCH_ID || '';

// 默认配置（云端 config 集合可覆盖：{ _id:'pay', annualPrice:698, trialPrice:99, commissionAnnual:100, commissionTrial:10 }）
const DEFAULT_CONFIG = {
  annualPrice: 698,        // 单位：元
  trialPrice: 99,
  commissionAnnual: 100,   // 年卡每单佣金（元）
  commissionTrial: 10,     // 体验单每单佣金（元）
};

function yuanToFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

async function getConfig() {
  try {
    const res = await db.collection('config').doc('pay').get();
    return Object.assign({}, DEFAULT_CONFIG, res.data || {});
  } catch (e) {
    return DEFAULT_CONFIG;
  }
}

function commissionOf(cfg, type) {
  return type === 'trial' ? (cfg.commissionTrial || 10) : (cfg.commissionAnnual || 100);
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const { OPENID } = wxContext;
  const envId = wxContext.ENV; // 当前云环境 ID，用于指定支付回调所在环境
  const action = event.action;

  switch (action) {
    // ---------- 获取价格/佣金配置 ----------
    case 'getConfig': {
      const cfg = await getConfig();
      return { ok: true, data: {
        annualPrice: cfg.annualPrice,
        trialPrice: cfg.trialPrice,
        commissionAnnual: cfg.commissionAnnual,
        commissionTrial: cfg.commissionTrial,
      } };
    }

    // ---------- 创建订单并发起微信支付 ----------
    case 'createOrder': {
      const { type, name, phone, idcard, leaderId } = event;
      const cfg = await getConfig();
      const amount = type === 'trial' ? cfg.trialPrice : cfg.annualPrice;
      const title = type === 'trial' ? '单次活动体验' : '亲子研学年卡';
      if (!amount) return { ok: false, msg: '价格配置异常' };

      const outTradeNo = 'NY' + Date.now() + Math.floor(Math.random() * 10000);
      const now = db.serverDate();

      // 下单时若未显式传团长，自动带上我绑定的团长（首单归属）
      let leader = leaderId || '';
      if (!leader) {
        const b = await db.collection('inviter_binding').where({ openid: OPENID }).limit(1).get();
        if (b.data[0]) leader = b.data[0].inviterId;
      }

      await db.collection('orders').add({
        data: {
          openid: OPENID,
          type,                          // annual | trial
          title,
          name, phone, idcard: idcard || '',
          leaderId: leader,              // 所属团长（佣金归属）
          amount,
          outTradeNo,
          paid: false,
          activatedAt: null,             // 首次参加活动时由后台标记激活
          createdAt: now,
        },
      });

      // 云开发微信支付统一下单（免证书签名，由云函数完成）
      const res = await cloud.cloudPay.unifiedOrder({
        body: '能量少年研学-' + title,
        outTradeNo,
        spbillCreateIp: '127.0.0.1',
        subMchId: SUB_MCH_ID,
        totalFee: yuanToFen(amount),
        envId,
        functionName: 'payCallback',
      });
      return { ok: true, outTradeNo, payment: res.payment };
    }

    // ---------- 新用户绑定推广人/团长（首次绑定生效） ----------
    case 'bindInviter': {
      const { inviterId } = event;
      if (!inviterId) return { ok: true };
      if (inviterId === OPENID) return { ok: true, msg: '不能绑定自己' };
      const exist = await db.collection('inviter_binding').where({ openid: OPENID }).count();
      if (exist.total > 0) return { ok: true, msg: '已绑定过' };
      // 校验团长存在，取姓名做展示
      let leaderName = '';
      try {
        const l = await db.collection('leaders').where({ openid: inviterId }).limit(1).get();
        if (l.data[0]) leaderName = l.data[0].name;
      } catch (e) {}
      await db.collection('inviter_binding').add({
        data: { openid: OPENID, inviterId, leaderName, createdAt: db.serverDate(), converted: false },
      });
      return { ok: true, leaderName };
    }

    // ---------- 团长大厅：注册成为团长 ----------
    case 'registerLeader': {
      const { name, phone } = event;
      if (!name || !/^1\d{10}$/.test(phone || '')) return { ok: false, msg: '请填写正确的姓名和手机号' };
      const exist = await db.collection('leaders').where({ openid: OPENID }).limit(1).get();
      if (exist.data[0]) {
        await db.collection('leaders').doc(exist.data[0]._id).update({ data: { name, phone } });
        return { ok: true, msg: '已更新团长信息', data: { leaderId: OPENID, name, phone } };
      }
      await db.collection('leaders').add({
        data: { openid: OPENID, name, phone, memberCount: 0, createdAt: db.serverDate() },
      });
      return { ok: true, msg: '注册成功，开始分享吧', data: { leaderId: OPENID, name, phone } };
    }

    // ---------- 团长大厅：按手机号/姓名搜索团 ----------
    case 'searchLeaders': {
      const { keyword } = event;
      if (!keyword) return { ok: true, data: [] };
      const reg = db.RegExp({ regexp: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
      const res = await db.collection('leaders')
        .where(_.or([{ phone: reg }, { name: reg }]))
        .orderBy('createdAt', 'desc').limit(20).get();
      return { ok: true, data: res.data.map((l) => ({
        leaderId: l.openid,
        name: l.name,
        phone: l.phone,
        memberCount: l.memberCount || 0,
        isMine: l.openid === OPENID,
      })) };
    }

    // ---------- 团长大厅：加入团（人数不限） ----------
    case 'joinTeam': {
      const { leaderId } = event;
      if (!leaderId) return { ok: false, msg: '缺少团长信息' };
      if (leaderId === OPENID) return { ok: false, msg: '不能加入自己的团' };
      const exist = await db.collection('inviter_binding').where({ openid: OPENID }).count();
      if (exist.total > 0) return { ok: false, msg: '你已加入过团，首单只能归属一个团' };
      const l = await db.collection('leaders').where({ openid: leaderId }).limit(1).get();
      if (!l.data[0]) return { ok: false, msg: '未找到该团' };
      await db.collection('inviter_binding').add({
        data: { openid: OPENID, inviterId: leaderId, leaderName: l.data[0].name, createdAt: db.serverDate(), converted: false },
      });
      await db.collection('leaders').where({ openid: leaderId })
        .update({ data: { memberCount: _.inc(1) } });
      return { ok: true, msg: '入团成功！本团团长：' + l.data[0].name };
    }

    // ---------- 我的团长信息（下单页/个人页展示） ----------
    case 'getMyLeader': {
      const b = await db.collection('inviter_binding').where({ openid: OPENID }).limit(1).get();
      if (!b.data[0]) return { ok: true, data: null };
      return { ok: true, data: { leaderId: b.data[0].inviterId, name: b.data[0].leaderName || '', time: b.data[0].createdAt ? new Date(b.data[0].createdAt).toLocaleString('zh-CN') : '' } };
    }

    // ---------- 我的团（我是团长时的成员） ----------
    case 'getMyTeam': {
      const l = await db.collection('leaders').where({ openid: OPENID }).limit(1).get();
      const members = await db.collection('inviter_binding').where({ inviterId: OPENID })
        .orderBy('createdAt', 'desc').limit(200).get();
      return { ok: true, data: {
        isLeader: !!l.data[0],
        name: l.data[0] ? l.data[0].name : '',
        phone: l.data[0] ? l.data[0].phone : '',
        memberCount: members.data.length,
        members: members.data.map((m) => ({
          objectName: m.objectName || '微信用户',
          time: m.createdAt ? new Date(m.createdAt).toLocaleString('zh-CN') : '',
          statusLabel: m.paid ? '已成交' : (m.converted ? '已下单' : '待成交'),
        })),
      } };
    }

    // ---------- 我的订单 ----------
    case 'getMyOrders': {
      const res = await db.collection('orders').where({ openid: OPENID })
        .orderBy('createdAt', 'desc').limit(50).get();
      const data = res.data.map((o) => ({
        title: o.title,
        amount: o.amount,
        paid: !!o.paid,
        activatedAt: o.activatedAt || '',
        time: o.createdAt ? new Date(o.createdAt).toLocaleString('zh-CN') : '',
      }));
      return { ok: true, data };
    }

    // ---------- 推广中心：推广对象 + 佣金记录 ----------
    case 'getPromoteInfo': {
      const cfg = await getConfig();
      const bindings = await db.collection('inviter_binding').where({ inviterId: OPENID })
        .orderBy('createdAt', 'desc').limit(100).get();
      const records = bindings.data.map((b) => ({
        objectName: b.objectName || '微信用户',
        time: b.createdAt ? new Date(b.createdAt).toLocaleString('zh-CN') : '',
        typeLabel: b.converted ? (b.type === 'trial' ? '体验单 ¥' + cfg.trialPrice : '年卡 ¥' + cfg.annualPrice) : '未下单',
        statusLabel: b.paid ? '已成交 · 佣金 ¥' + (b.commission || 0) : (b.converted ? '已下单' : '待成交'),
        paid: !!b.paid,
      }));
      const paidList = bindings.data.filter((b) => b.paid);
      return {
        ok: true,
        data: {
          commissionAnnual: cfg.commissionAnnual,
          commissionTrial: cfg.commissionTrial,
          records,
          totalCount: bindings.data.length,
          paidCount: paidList.length,
          totalCommission: paidList.reduce((s, b) => s + (b.commission || 0), 0),
        },
      };
    }

    default:
      return { ok: false, msg: '未知操作' };
  }
};
