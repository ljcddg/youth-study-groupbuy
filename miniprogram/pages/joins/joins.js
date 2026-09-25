// 我的参与
const app = getApp();
const { api, fail } = require('../../utils/cloud.js');
const { decorateMember, PAY_STATUS } = require('../../utils/format.js');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'unpaid', label: '未付款' },
  { key: 'pending', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
  { key: 'rejected', label: '已驳回' },
];

Page({
  data: {
    tabs: TABS,
    tab: 'all',
    all: [],
    list: [],
    counts: {},
    loading: true,
  },

  onLoad() {
    app.ready(() => this.load());
  },

  onShow() {
    if (app.globalData.logged && this.data.all.length) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return api('getMyJoins')
      .then((list) => {
        const all = (list || []).map(decorateMember);
        const counts = { all: all.length };
        Object.keys(PAY_STATUS).forEach((k) => {
          counts[k] = all.filter((m) => m.payStatus === k).length;
        });
        this.setData({ loading: false, all, counts });
        this.applyTab();
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  applyTab() {
    const { all, tab } = this.data;
    this.setData({ list: tab === 'all' ? all : all.filter((m) => m.payStatus === tab) });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key });
    this.applyTab();
  },

  goGroup(e) {
    wx.navigateTo({ url: '/pages/group/group?id=' + e.currentTarget.dataset.id });
  },

  goPay(e) {
    wx.navigateTo({ url: '/pages/pay/pay?id=' + e.currentTarget.dataset.id });
  },

  goIndex() {
    wx.navigateTo({ url: '/pages/index/index' });
  },

  cancelJoin(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消参与',
      content: '确定取消这次参与吗？',
      success: (r) => {
        if (!r.confirm) return;
        api('cancelJoin', { memberId: id })
          .then(() => { wx.showToast({ title: '已取消', icon: 'success' }); this.load(); })
          .catch((err) => fail(err));
      },
    });
  },

  onShareAppMessage() {
    return { title: '能量少年研学 · 拼团报名', path: '/pages/index/index' };
  },
});
