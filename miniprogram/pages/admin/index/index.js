// 管理端 · 工作台
const app = getApp();
const { adm, fail } = require('../../../utils/cloud.js');

Page({
  data: {
    loading: false,
    isAdmin: false,
    roleLabel: '',
    myOpenid: '',
    d: {
      pendingApps: 0,
      pendingPay: 0,
      ongoing: 0,
      total: 0,
      closed: 0,
      joinedCount: 0,
      confirmedCount: 0,
      confirmedAmount: 0,
    },
    menus: [],
  },

  onLoad() {
    app.ready(() => this.load());
  },

  onShow() {
    if (app.globalData.logged) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    const g = app.globalData;
    const isAdmin = app.isAdmin();
    this.setData({
      isAdmin,
      myOpenid: g.openid,
      roleLabel: g.role === 'superadmin' ? '超级管理员' : g.role === 'admin' ? '管理员' : g.role === 'leader' ? '团长' : '普通用户',
    });
    if (!isAdmin) {
      this.setData({ loading: false });
      return Promise.resolve();
    }
    this.setData({ loading: true });
    return adm('dashboard')
      .then((d) => {
        this.setData({ loading: false, d });
        this.buildMenus(d);
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  buildMenus(d) {
    this.setData({
      menus: [
        { icon: '🖊', name: '成团申请审核', desc: '审核用户提交的成团申请', url: '/pages/admin/applications/applications', badge: d.pendingApps, badgeText: '待审核' },
        { icon: '📋', name: '拼团管理', desc: '成员台账、统计、关闭', url: '/pages/admin/groups/groups', badge: d.ongoing, badgeText: '进行中' },
        { icon: '⚙️', name: '业务设置与管理员', desc: '业务规则、管理员名单', url: '/pages/admin/settings/settings', badge: 0 },
        { icon: '🚫', name: '黑名单', desc: '禁止申请成为团长，可恢复', url: '/pages/admin/blacklist/blacklist', badge: 0 },
      ],
    });
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  copyOpenid() {
    if (this.data.myOpenid) {
      wx.setClipboardData({ data: this.data.myOpenid });
    }
  },

  goIndex() {
    wx.navigateTo({ url: '/pages/index/index' });
  },
});
