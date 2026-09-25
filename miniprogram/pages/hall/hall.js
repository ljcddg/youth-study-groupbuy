// 团长大厅：浏览 / 搜索所有已成团的拼团
// 只有管理员审核通过并建团的拼团才会出现在这里
const app = getApp();
const { api, fail } = require('../../utils/cloud.js');
const { GROUP_STATUS, GROUP_STATUS_CLASS, money, datetime, PLANS } = require('../../utils/format.js');

const PLAN_BRIEF = PLANS.map((p) => p.name + '¥' + p.price).join(' / ');

Page({
  data: {
    loading: true,
    keyword: '',
    tab: 'all',
    tabs: [
      { key: 'all', label: '全部' },
      { key: 'ongoing', label: '进行中' },
      { key: 'closed', label: '已关闭' },
    ],
    list: [],
    planBrief: PLAN_BRIEF,
    total: 0,
    ongoingCount: 0,
    isAdmin: false,
  },

  onLoad() {
    app.ready(() => {
      this.setData({ isAdmin: app.isAdmin() });
      this.load();
    });
  },

  onShow() {
    if (app.globalData.logged) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return api('searchHall', { keyword: this.data.keyword, status: this.data.tab })
      .then((d) => {
        this.setData({
          loading: false,
          total: d.total || 0,
          ongoingCount: d.ongoingCount || 0,
          list: (d.list || []).map((g) =>
            Object.assign({}, g, {
              statusLabel: GROUP_STATUS[g.status] || g.status,
              statusClass: GROUP_STATUS_CLASS[g.status] || 'st-gray',
              unitAmountText: money(g.unitAmount),
              createdAtText: datetime(g.createdAt),
              isFree: !(Number(g.unitAmount) > 0),
            })
          ),
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  doSearch() {
    this.load();
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.load();
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key });
    this.load();
  },

  goGroup(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/group/group?id=' + id });
  },

  goApply() {
    app.goApply();
  },

  onShareAppMessage() {
    const me = app.globalData.openid || '';
    return {
      title: '团长大厅 · 看看有哪些研学拼团可以加入',
      path: '/pages/hall/hall' + (me ? '?ref=' + me : ''),
    };
  },

  onShareTimeline() {
    return { title: '团长大厅 · 看看有哪些研学拼团可以加入' };
  },
});
