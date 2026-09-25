// 付款页：只走微信支付，支付成功由服务端回调自动确认（不再上传凭证人工核实）
const app = getApp();
const { api, fail, loading, done } = require('../../utils/cloud.js');
const { PAY_STATUS, PAY_STATUS_CLASS, money, datetime, planOf } = require('../../utils/format.js');

Page({
  data: {
    memberId: '',
    loading: true,
    notFound: false,
    member: null,
    group: null,

    paying: false,

    statusLabel: '',
    statusClass: 'st-gray',
  },

  onLoad(options) {
    const memberId = options.id || '';
    this.setData({ memberId });
    if (!memberId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    app.ready(() => this.load());
  },

  load() {
    this.setData({ loading: true });
    return api('getMember', { memberId: this.data.memberId })
      .then((d) => {
        const m = d.member;
        this.setData({
          loading: false,
          notFound: false,
          member: Object.assign({}, m, {
            amountText: money(m.amount),
            planName: (planOf(m.planKey, m.amount) || {}).name || '',
            createdAtText: datetime(m.createdAt),
            payTimeText: datetime(m.payTime),
          }),
          group: d.group,
          statusLabel: PAY_STATUS[m.payStatus] || m.payStatus,
          statusClass: PAY_STATUS_CLASS[m.payStatus] || 'st-gray',
        });
      })
      .catch((e) => {
        this.setData({ loading: false, notFound: true });
        fail(e);
      });
  },

  // 微信支付：云函数统一下单 → wx.requestPayment 唤起支付 → 轮询确认状态
  wxPay() {
    if (this.data.paying) return;
    const m = this.data.member;
    if (!m) return;
    if (m.payStatus === 'confirmed') return wx.showToast({ title: '已支付', icon: 'none' });

    this.setData({ paying: true });
    loading('正在下单');
    api('wxPayOrder', { memberId: this.data.memberId })
      .then((d) => {
        done();
        const payment = (d && d.payment) || {};
        wx.requestPayment({
          timeStamp: String(payment.timeStamp || ''),
          nonceStr: payment.nonceStr || '',
          package: payment.package || '',
          signType: payment.signType || 'MD5',
          paySign: payment.paySign || '',
          success: () => {
            this.setData({ paying: false });
            wx.showToast({ title: '支付成功，确认中…', icon: 'none' });
            this.pollConfirm(0);
          },
          fail: (err) => {
            this.setData({ paying: false });
            const msg = (err && err.errMsg) || '';
            if (msg.indexOf('cancel') < 0) {
              wx.showToast({ title: '支付未完成，请重试', icon: 'none' });
            }
          },
        });
      })
      .catch((e) => {
        done();
        this.setData({ paying: false });
        fail(e);
      });
  },

  // 支付成功后轮询成员状态，直到服务端确认（支付回调是异步的）
  pollConfirm(n) {
    if (n >= 6) { this.load(); return; }
    api('getMember', { memberId: this.data.memberId })
      .then((d) => {
        if (d.member && d.member.payStatus === 'confirmed') {
          this.load();
        } else {
          setTimeout(() => this.pollConfirm(n + 1), 2000);
        }
      })
      .catch(() => this.load());
  },

  goGroup() {
    const g = this.data.group;
    if (g) wx.navigateTo({ url: '/pages/group/group?id=' + g._id });
  },

  copyAmount() {
    const a = this.data.member ? this.data.member.amountText : '';
    if (a) wx.setClipboardData({ data: a });
  },

  onShareAppMessage() {
    const g = this.data.group;
    const me = app.globalData.openid || '';
    return {
      title: g ? '【' + g.name + '】一起参加拼团' : '一起参加拼团',
      path: g ? '/pages/group/group?id=' + g._id + (me ? '&ref=' + me : '') : '/pages/index/index',
    };
  },
});
