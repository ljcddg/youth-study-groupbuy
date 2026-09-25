// 管理端 · 成团申请审核
const app = getApp();
const { adm, fail, ok, loading, done } = require('../../../utils/cloud.js');
const { APPLY_STATUS, APPLY_STATUS_CLASS, money, datetime } = require('../../../utils/format.js');

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'all', label: '全部' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' },
];

Page({
  data: {
    tabs: TABS,
    tab: 'pending',
    keyword: '',
    loading: true,
    list: [],
    counts: {},

    show: false,
    cur: null,
    mode: 'approve',   // approve | reject
    remark: '',
    unitAmount: '',
    submitting: false,
    withBlacklist: false,
  },

  onLoad() {
    app.ready(() => this.load());
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return adm('listApplications', { status: this.data.tab, keyword: this.data.keyword })
      .then((d) => {
        this.setData({
          loading: false,
          list: (d.list || []).map((a) =>
            Object.assign({}, a, {
              statusLabel: APPLY_STATUS[a.status] || a.status,
              statusClass: APPLY_STATUS_CLASS[a.status] || 'st-gray',
              unitAmountText: money(a.unitAmount),
              createdAtText: datetime(a.createdAt),
              reviewedAtText: datetime(a.reviewedAt),
            })
          ),
          counts: d.counts || {},
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key });
    this.load();
  },

  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  doSearch() { this.load(); },
  clearSearch() { this.setData({ keyword: '' }); this.load(); },

  openReview(e) {
    const id = e.currentTarget.dataset.id;
    const a = this.data.list.find((x) => x._id === id);
    if (!a) return;
    if (a.status !== 'pending') return wx.showToast({ title: '该申请已处理过', icon: 'none' });
    this.setData({ show: true, cur: a, mode: 'approve', remark: '', unitAmount: String(a.unitAmount), withBlacklist: false });
  },

  closeReview() { this.setData({ show: false, cur: null, remark: '' }); },

  setMode(e) { this.setData({ mode: e.currentTarget.dataset.mode }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onBlacklistChange(e) { this.setData({ withBlacklist: e.detail.value }); },
  onUnitAmount(e) { this.setData({ unitAmount: e.detail.value }); },

  submitReview() {
    const { cur, mode, remark, unitAmount } = this.data;
    if (!cur || this.data.submitting) return;
    this.setData({ submitting: true });
    loading('处理中');
    adm('reviewApplication', {
      id: cur._id,
      approve: mode === 'approve',
      remark: (remark || '').trim(),
      unitAmount: unitAmount === '' ? undefined : Number(unitAmount),
      blacklist: mode === 'reject' && this.data.withBlacklist,
    })
      .then((d) => {
        done();
        this.setData({ submitting: false, show: false, cur: null });
        wx.showModal({
          title: mode === 'approve' ? '审核通过' : '已驳回',
          content: mode === 'approve' ? '拼团已自动创建，申请人已成为团长。' : '已驳回该申请，用户可修改后重新提交。',
          showCancel: false,
        });
        this.load();
      })
      .catch((e) => {
        done();
        this.setData({ submitting: false });
        fail(e);
      });
  },

  goGroup(e) {
    wx.navigateTo({ url: '/pages/group/group?id=' + e.currentTarget.dataset.id });
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  noop() {},
});
