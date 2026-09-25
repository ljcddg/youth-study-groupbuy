// 我的订单
Page({
  data: {
    orders: [],
    loading: true,
  },

  onShow() {
    this.loadOrders();
  },

  loadOrders() {
    this.setData({ loading: true });
    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'getMyOrders' },
    })
      .then((res) => {
        const r = (res.result && res.result.data) || [];
        this.setData({ orders: r, loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },

  goHome() {
    wx.switchTab ? wx.navigateTo({ url: '/pages/index/index' }) : wx.navigateBack();
  },

  onShareAppMessage() {
    const inviter = wx.getStorageSync('inviterId') || '';
    return {
      title: '能量少年研学·698元亲子研学年卡，全年48场没套路',
      path: '/pages/index/index?inviter=' + inviter,
    };
  },
});
