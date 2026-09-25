// 推广中心：我的推广码 / 推广记录 / 佣金
const app = getApp();

Page({
  data: {
    commissionAnnual: null,  // 年卡佣金（云端）
    commissionTrial: null,   // 体验单佣金（云端）
    records: [],            // 推广记录：时间、对象、类型、状态
    totalCount: 0,
    paidCount: 0,
    totalCommission: 0,
    loading: true,
  },

  onShow() {
    this.loadAll();
  },

  loadAll() {
    this.setData({ loading: true });
    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'getPromoteInfo' },
    })
      .then((res) => {
        const r = (res.result && res.result.data) || {};
        this.setData({
          commissionAnnual: r.commissionAnnual,
          commissionTrial: r.commissionTrial,
          records: r.records || [],
          totalCount: r.totalCount || 0,
          paidCount: r.paidCount || 0,
          totalCommission: r.totalCommission || 0,
          loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));
  },

  copyMyLink() {
    const leader = wx.getStorageSync('leaderId');
    if (leader) {
      wx.setClipboardData({ content: '团长标识：' + leader });
    }
  },

  // 分享即推广：新家长从这条卡片进入，自动加入你的团、首单佣金归你
  onShareAppMessage() {
    const leader = wx.getStorageSync('leaderId') || '';
    return {
      title: '能量少年研学·698元亲子研学年卡，全年48场没套路',
      path: '/pages/index/index?leader=' + leader,
    };
  },

  onShareTimeline() {
    return { title: '能量少年研学·698元亲子研学年卡，全年48场没套路' };
  },
});
