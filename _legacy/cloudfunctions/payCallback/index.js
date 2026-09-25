// 云函数 payCallback — 微信支付结果回调
// 职责：1) 标记订单已支付  2) 给订单所属团长记佣金（两档：年卡 698→100，体验 99→10，config 可调）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEFAULT_CONFIG = { commissionAnnual: 100, commissionTrial: 10 };

async function getConfig() {
  try {
    const res = await db.collection('config').doc('pay').get();
    return Object.assign({}, DEFAULT_CONFIG, res.data || {});
  } catch (e) {
    return DEFAULT_CONFIG;
  }
}

exports.main = async (event) => {
  // 云开发微信支付回调：event.outTradeNo / event.returnCode / event.totalFee
  const { outTradeNo, returnCode, resultCode } = event;
  if (returnCode !== 'SUCCESS' || (resultCode && resultCode !== 'SUCCESS')) {
    return { errcode: 0, errmsg: 'OK' };
  }

  const orderRes = await db.collection('orders').where({ outTradeNo }).limit(1).get();
  const order = orderRes.data[0];
  if (!order) return { errcode: 0, errmsg: 'OK' };
  if (order.paid) return { errcode: 0, errmsg: 'OK' }; // 幂等

  await db.collection('orders').doc(order._id).update({
    data: { paid: true, paidAt: db.serverDate() },
  });

  // 佣金归属：优先订单 leaderId，兼容旧字段 inviterId
  const leaderId = order.leaderId || order.inviterId || '';
  if (leaderId) {
    const cfg = await getConfig();
    const commission = order.type === 'trial' ? (cfg.commissionTrial || 10) : (cfg.commissionAnnual || 100);

    const bindingRes = await db.collection('inviter_binding')
      .where({ openid: order.openid, inviterId: leaderId }).limit(1).get();
    const binding = bindingRes.data[0];
    const bindingData = {
      converted: true,
      paid: true,
      commission,
      type: order.type,
      objectName: order.name || '微信用户',
    };
    if (binding) {
      await db.collection('inviter_binding').doc(binding._id).update({ data: bindingData });
    } else {
      bindingData.openid = order.openid;
      bindingData.inviterId = leaderId;
      bindingData.createdAt = db.serverDate();
      await db.collection('inviter_binding').add({ data: bindingData });
    }
    // 佣金明细流水（对账/提现依据）
    await db.collection('commission_records').add({
      data: {
        promoterId: leaderId,
        orderNo: outTradeNo,
        orderType: order.type,
        amount: commission,
        status: 'pending',   // 待结算，可在后台调整为 settled
        createdAt: db.serverDate(),
      },
    });
  }

  return { errcode: 0, errmsg: 'OK' };
};
