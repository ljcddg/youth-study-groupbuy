// 下单页：type=annual 年卡 698 / type=trial 单次体验 99
const app = getApp();

const TYPE_MAP = {
  annual: { title: '亲子研学年卡', price: 698, desc: '能量少年亲子研学年卡（全年48场）' },
  trial: { title: '单次活动体验', price: 99, desc: '能量少年单次活动体验' },
};

Page({
  data: {
    type: 'annual',
    title: '',
    price: 698,
    name: '',
    phone: '',
    idcard: '',
    submitting: false,
  },

  onLoad(options) {
    const type = TYPE_MAP[options.type] ? options.type : 'annual';
    const conf = TYPE_MAP[type];
    // 云端价格可覆盖本地默认（config 集合可改价）
    this.setData({ type, title: conf.title, price: conf.price });
    this.loadPrice(type);
  },

  loadPrice(type) {
    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'getConfig' },
      success: (res) => {
        const cfg = (res.result && res.result.data) || {};
        const key = type === 'annual' ? 'annualPrice' : 'trialPrice';
        if (cfg[key]) this.setData({ price: cfg[key] });
      },
      fail: () => {},
    });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  submit() {
    const { type, name, phone, idcard, submitting } = this.data;
    if (submitting) return;
    if (!name.trim()) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' });

    this.setData({ submitting: true });
    wx.cloud.callFunction({
      name: 'createOrder',
      data: {
        action: 'createOrder',
        type,
        name: name.trim(),
        phone,
        idcard: idcard.trim(), // 选填，仅用于投保团险，严格保密
        leaderId: wx.getStorageSync('leaderId') || '',
      },
    })
      .then((res) => {
        const r = res.result || {};
        if (!r.ok) throw new Error(r.msg || '下单失败');
        return wx.requestPayment(r.payment);
      })
      .then(() => {
        wx.showToast({ title: '购买成功', icon: 'success' });
        setTimeout(() => wx.redirectTo({ url: '/pages/orders/orders' }), 1200);
      })
      .catch((err) => {
        // 用户取消支付不算错误
        if (!/requestPayment:fail cancel/i.test(err.errMsg || err.message || '')) {
          wx.showToast({ title: err.message || '支付未完成', icon: 'none' });
        }
        this.setData({ submitting: false });
      });
  },
});
