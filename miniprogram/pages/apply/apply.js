// 我要成团：提交申请 + 查看我的申请状态
const app = getApp();
const { api, fail, ok, loading, done } = require('../../utils/cloud.js');
const { APPLY_STATUS, APPLY_STATUS_CLASS, money, datetime } = require('../../utils/format.js');

const EMPTY_FORM = { name: '', phone: '', groupName: '', desc: '', unitAmount: '', targetCount: '', remark: '' };

Page({
  data: {
    loading: true,
    submitting: false,
    application: null,
    forceForm: false, // 已驳回/已撤回后点「重新填写」时强制显示表单
    statusLabel: '',
    statusClass: 'st-gray',
    config: { leaderMaxGroups: 1, minMembers: 0 },
    form: Object.assign({}, EMPTY_FORM),
    alreadyLeader: false,
  },

  onLoad() {
    app.ready(() => this.init());
  },

  onShow() {
    if (app.globalData.logged && !this.data.forceForm) this.loadApplication();
  },

  init() {
    this.setData({
      config: app.globalData.config || this.data.config,
      alreadyLeader: app.globalData.role === 'leader',
    });
    this.loadApplication();
  },

  loadApplication() {
    this.setData({ loading: true });
    api('getMyApplication')
      .then((a) => {
        // 已通过 = 上一个团已建好，可继续发起新申请 → 视为无待处理申请，直接显示新表单
        if (a && a.status === 'approved') a = null;
        // 回写全局，让首页 / 大厅 / 我的拼团 的「我要成团」入口也能感知当前状态
        app.globalData.apply = a ? { _id: a._id, status: a.status, groupId: a.groupId || '' } : null;
        this.setData({
          loading: false,
          application: a
            ? Object.assign({}, a, {
                unitAmountText: money(a.unitAmount),
                createdAtText: datetime(a.createdAt),
                reviewedAtText: datetime(a.reviewedAt),
              })
            : null,
          statusLabel: a ? APPLY_STATUS[a.status] || a.status : '',
          statusClass: a ? APPLY_STATUS_CLASS[a.status] || 'st-gray' : 'st-gray',
        });
        if (!a) this.prefill();
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  // 预填：优先用「我的」里保存的个人资料，其次用上次填写的缓存
  prefill() {
    const p = app.globalData.profile || {};
    const cache = wx.getStorageSync('applyForm');
    const src = {};
    if (p.name) src.name = p.name;
    if (p.phone) src.phone = p.phone;
    // 缓存里的姓名手机号作为兜底（个人资料优先）
    if (!src.name && cache && cache.name) src.name = cache.name;
    if (!src.phone && cache && cache.phone) src.phone = cache.phone;
    this.setData({ form: Object.assign({}, EMPTY_FORM, src) });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  submit() {
    const f = this.data.form;
    if (this.data.submitting) return;
    if (!(f.name || '').trim()) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (!/^1\d{10}$/.test(f.phone || '')) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' });

    this.setData({ submitting: true });
    loading('提交中');
    api('submitApplication', {
      name: f.name.trim(),
      phone: f.phone,
      // 拼团名称、金额等留给团长建团成功后在拼团详情里设置
      groupName: '',
      desc: '',
      unitAmount: 0,
      targetCount: 0,
      remark: '',
    })
      .then(() => {
        done();
        this.setData({ submitting: false, forceForm: false });
        wx.setStorageSync('applyForm', { name: f.name.trim(), phone: f.phone });
        ok('申请已提交');
        this.loadApplication();
      })
      .catch((e) => {
        done();
        this.setData({ submitting: false });
        fail(e);
      });
  },

  cancelApply() {
    const a = this.data.application;
    wx.showModal({
      title: '撤回申请',
      content: '确定撤回这条成团申请吗？撤回后可以重新填写提交。',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        api('cancelApplication', { id: a._id })
          .then(() => {
            done();
            ok('已撤回');
            this.loadApplication();
          })
          .catch((e) => {
            done();
            fail(e);
          });
      },
    });
  },

  // 已驳回 / 已撤回 → 回到表单重新填写
  goReapply() {
    this.setData({ forceForm: true });
    this.prefill();
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  goGroup() {
    const a = this.data.application;
    if (a && a.groupId) wx.navigateTo({ url: '/pages/group/group?id=' + a.groupId });
  },

  goMyGroups() {
    wx.navigateTo({ url: '/pages/mygroups/mygroups' });
  },

  onShareAppMessage() {
    return { title: '能量少年研学 · 拼团报名', path: '/pages/index/index' };
  },
});
