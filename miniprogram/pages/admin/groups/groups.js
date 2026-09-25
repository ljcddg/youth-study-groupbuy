// 管理端 · 拼团管理（列表 / 单团台账）
// 付款只走微信支付、自动确认，故已移除「人工确认收款 / 驳回凭证 / 查看凭证」相关逻辑
const app = getApp();
const { adm, fail, ok, loading, done } = require('../../../utils/cloud.js');
const { decorateGroup, decorateMember, money, datetime, today, PLANS } = require('../../../utils/format.js');

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'ongoing', label: '进行中' },
  { key: 'closed', label: '已关闭' },
];

Page({
  data: {
    mode: 'list', // list | detail
    tabs: TABS,
    tab: 'all',
    keyword: '',
    startDate: '',
    endDate: '',
    loading: true,
    list: [],
    config: {},

    groupId: '',
    group: null,
    stats: null,
    members: [],

    // 代录成员
    addShow: false,
    addForm: { name: '', phone: '', planKey: 'year', remark: '', sourceLabel: '' },
    plans: PLANS,
    addSubmitting: false,

    today: today(),
  },

  onLoad() {
    app.ready(() => this.loadList());
  },

  onPullDownRefresh() {
    const p = this.data.mode === 'detail' ? this.loadDetail() : this.loadList();
    p.then(() => wx.stopPullDownRefresh());
  },

  // ---------------- 列表 ----------------
  loadList() {
    this.setData({ loading: true, mode: 'list' });
    return adm('listGroups', {
      status: this.data.tab,
      keyword: this.data.keyword,
      startDate: this.data.startDate,
      endDate: this.data.endDate,
    })
      .then((d) => {
        const cfg = (d && d.config) || {};
        this.setData({
          loading: false,
          list: ((d && d.list) || []).map((g) => decorateGroup(g, cfg)),
          config: cfg,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key });
    this.loadList();
  },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  doSearch() { this.loadList(); },
  clearSearch() { this.setData({ keyword: '' }); this.loadList(); },
  onStartDate(e) { this.setData({ startDate: e.detail.value }); this.loadList(); },
  onEndDate(e) { this.setData({ endDate: e.detail.value }); this.loadList(); },
  clearDate() { this.setData({ startDate: '', endDate: '' }); this.loadList(); },

  // ---------------- 明细 ----------------
  openDetail(e) {
    const groupId = e.currentTarget.dataset.id;
    this.setData({ groupId, mode: 'detail' });
    this.loadDetail();
  },

  backList() {
    this.setData({ mode: 'list' });
    this.loadList();
  },

  loadDetail() {
    this.setData({ loading: true });
    return adm('groupDetail', { groupId: this.data.groupId })
      .then((d) => {
        const cfg = (d && d.config) || {};
        const st = d.stats || {};
        this.setData({
          loading: false,
          group: decorateGroup(d.group, cfg),
          stats: Object.assign({}, st, {
            confirmedAmountText: money(st.confirmedAmount),
          }),
          members: (d.members || []).map(decorateMember),
          config: cfg,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  // 作废参与记录（与付款方式无关，保留）
  cancelMember(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '作废参与记录',
      content: '作废后该记录不再计入拼团统计，记录本身仍保留可追溯。确定吗？',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        adm('cancelMember', { memberId: id })
          .then(() => { done(); ok('已作废'); this.loadDetail(); })
          .catch((err) => { done(); fail(err); });
      },
    });
  },

  // ---------------- 代录成员 ----------------
  openAdd() {
    this.setData({
      addShow: true,
      addForm: { name: '', phone: '', planKey: 'year', remark: '', sourceLabel: '' },
    });
  },
  closeAdd() { this.setData({ addShow: false }); },
  onAddInput(e) { this.setData({ ['addForm.' + e.currentTarget.dataset.field]: e.detail.value }); },
  choosePlan(e) { this.setData({ 'addForm.planKey': e.currentTarget.dataset.key }); },
  submitAdd() {
    const f = this.data.addForm;
    if (!(f.name || '').trim()) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (!/^1\d{10}$/.test(f.phone || '')) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' });
    this.setData({ addSubmitting: true });
    adm('addMember', {
      groupId: this.data.groupId,
      name: f.name.trim(),
      phone: f.phone,
      planKey: f.planKey,
      remark: (f.remark || '').trim(),
      sourceLabel: (f.sourceLabel || '').trim() || '管理员录入',
    })
      .then(() => {
        this.setData({ addSubmitting: false, addShow: false });
        ok('已录入');
        this.loadDetail();
      })
      .catch((e) => { this.setData({ addSubmitting: false }); fail(e); });
  },

  // ---------------- 状态变更 ----------------
  closeGroup() {
    wx.showModal({
      title: '关闭拼团',
      content: '关闭后不再接受新的参与。确定吗？',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        adm('closeGroup', { groupId: this.data.groupId })
          .then(() => { done(); ok('已关闭'); this.loadDetail(); })
          .catch((e) => { done(); fail(e); });
      },
    });
  },

  reopenGroup() {
    loading('处理中');
    adm('reopenGroup', { groupId: this.data.groupId })
      .then(() => { done(); ok('已重新开启'); this.loadDetail(); })
      .catch((e) => { done(); fail(e); });
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  noop() {},
});
