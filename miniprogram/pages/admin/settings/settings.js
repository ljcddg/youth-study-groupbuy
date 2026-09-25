// 管理端 · 业务规则 / 管理员管理（收款配置已移除：支付方式写死，后续接微信支付）
const app = getApp();
const { adm, fail, ok, loading, done } = require('../../../utils/cloud.js');
const { money, datetime } = require('../../../utils/format.js');

const TAB = [
  { key: 'biz', label: '业务规则' },
  { key: 'admin', label: '管理员' },
];

Page({
  data: {
    tab: 'biz',
    tabs: TAB,
    loading: true,
    isSuper: false,
    myOpenid: '',

    // 业务规则
    biz: { minMembers: 0, contactAdminTip: '', saleEndAt: '' },
    saleDate: '',
    saleTime: '',

    // 管理员
    admins: [],
    addShow: false,
    addForm: { openid: '', name: '', role: 'admin' },
    addSubmitting: false,
    usersShow: false,
    users: [],
    acting: false,
  },

  onLoad() {
    app.ready(() => this.loadAll());
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    const biz = Object.assign({}, this.data.biz, app.globalData.config || {});
    const se = String(biz.saleEndAt || '');
    this.setData({
      isSuper: app.isSuperAdmin(),
      myOpenid: app.globalData.openid,
      biz,
      saleDate: se.slice(0, 10),
      saleTime: se.length >= 16 ? se.slice(11, 16) : '',
    });
    this.setData({ loading: true });
    return adm('listAdmins')
      .catch(() => ({ list: [] }))
      .then((a) => {
        this.setData({
          loading: false,
          admins: (a.list || []).map((x) => Object.assign({}, x, { createdAtText: datetime(x.createdAt) })),
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.key }); },

  // ---------------- 业务规则 ----------------
  onBizInput(e) {
    this.setData({ ['biz.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  // 限时抢购截止时间（日期 + 时间两个 picker 拼接）
  onSaleDate(e) {
    const saleDate = e.detail.value;
    const saleTime = this.data.saleTime || '20:00';
    this.setData({ saleDate, saleTime, 'biz.saleEndAt': saleDate + ' ' + saleTime });
  },
  onSaleTime(e) {
    const saleTime = e.detail.value;
    const saleDate = this.data.saleDate || this.todayStr();
    this.setData({ saleTime, saleDate, 'biz.saleEndAt': saleDate + ' ' + saleTime });
  },
  clearSaleEnd() {
    this.setData({ saleDate: '', saleTime: '', 'biz.saleEndAt': '' });
  },
  todayStr() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },
  saveBiz() {
    loading('保存中');
    adm('saveBusinessConfig', {
      minMembers: Number(this.data.biz.minMembers || 0),
      contactAdminTip: this.data.biz.contactAdminTip || '',
      saleEndAt: this.data.biz.saleEndAt || '',
    })
      .then((d) => {
        done();
        // raw() 已解包：d 就是云函数返回的 data 本体（含 saleEndAt），不是 d.data
        app.globalData.config = Object.assign({}, app.globalData.config, d || {});
        ok('已保存');
        this.loadAll(); // 立即回显，保存结果当场可见
      })
      .catch((e) => { done(); fail(e); });
  },

  // ---------------- 管理员 ----------------
  toggleAdmin(e) {
    const { id, enabled } = e.currentTarget.dataset;
    loading('处理中');
    adm('toggleAdmin', { id, enabled: enabled !== 'true' })
      .then(() => { done(); ok('已更新'); this.loadAll(); })
      .catch((err) => { done(); fail(err); });
  },

  removeAdmin(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除管理员',
      content: '删除后该用户将无法进入管理端。确定吗？',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        adm('removeAdmin', { id })
          .then(() => { done(); ok('已删除'); this.loadAll(); })
          .catch((err) => { done(); fail(err); });
      },
    });
  },

  openAdd() { this.setData({ addShow: true, addForm: { openid: '', name: '', role: 'admin' } }); },
  closeAdd() { this.setData({ addShow: false }); },
  onAddInput(e) { this.setData({ ['addForm.' + e.currentTarget.dataset.field]: e.detail.value }); },
  submitAdd() {
    const f = this.data.addForm;
    if (!(f.openid || '').trim()) return wx.showToast({ title: '请填写 openid', icon: 'none' });
    this.setData({ addSubmitting: true });
    adm('addAdmin', { openid: f.openid.trim(), name: (f.name || '').trim() })
      .then(() => { this.setData({ addSubmitting: false, addShow: false }); ok('已添加'); this.loadAll(); })
      .catch((e) => { this.setData({ addSubmitting: false }); fail(e); });
  },

  openUsers() {
    this.setData({ usersShow: true, users: [] });
    adm('listUsers')
      .then((d) => {
        this.setData({
          myOpenid: (d && d.myOpenid) || this.data.myOpenid,
          users: (d.list || []).map((u) => Object.assign({}, u, { lastLoginText: datetime(u.lastLoginAt) })),
        });
      })
      .catch((e) => fail(e));
  },
  closeUsers() { this.setData({ usersShow: false }); },

  pickUser(e) {
    const openid = e.currentTarget.dataset.openid;
    this.setData({ usersShow: false, addShow: true, 'addForm.openid': openid });
  },

  copyText(e) {
    const t = e.currentTarget.dataset.text;
    if (t) wx.setClipboardData({ data: t });
  },

  noop() {},
});
