// 拼团详情（对外分享落地页 + 团长/管理员台账）
const app = getApp();
const { api, fail, ok, loading, done } = require('../../utils/cloud.js');
const { decorateGroup, decorateMember, PAY_STATUS, money, datetime, PLANS } = require('../../utils/format.js');

// 分享文案里的套餐概览，如「年票¥698 / 次票¥99」
const PLAN_BRIEF = PLANS.map((p) => p.name + '¥' + p.price).join(' / ');

Page({
  data: {
    groupId: '',
    ref: '',
    loading: true,
    notFound: false,
    group: null,
    stats: null,
    members: [],
    mine: [],
    isLeader: false,
    isAdmin: false,
    joinedCount: 0,
    joiners: [],
    progress: 0,
    plans: PLANS,          // 成员可选套餐：年票 698 / 次票 99
    planBrief: PLAN_BRIEF,

    // 参与弹窗（金额不再手填，由所选套餐决定）
    joinShow: false,
    joinForm: { name: '', phone: '', planKey: 'year', remark: '' },
    joining: false,

    // 编辑弹窗（团长只维护名称/说明/目标人数，不涉及定价）
    editShow: false,
    editForm: { name: '', desc: '' },
    editing: false,

    // 成员详情弹窗
    memberShow: false,
    curMember: null,
  },

  onLoad(options) {
    const groupId = options.id || options.groupId || '';
    // 优先取分享链接里的 ref（谁邀请我进来的）；没有则回退到本地缓存（通过首页/大厅分享进入时已存）
    let ref = options.ref ? decodeURIComponent(options.ref) : '';
    if (!ref) ref = wx.getStorageSync('refOpenid') || '';
    this.setData({ groupId, ref });
    if (!groupId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    app.ready(() => this.load());
  },

  onShow() {
    if (app.globalData.logged && this.data.group) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return api('getGroupDetail', { groupId: this.data.groupId })
      .then((d) => {
        const cfg = app.globalData.config || {};
        const g = decorateGroup(d.group, cfg);
        const target = Number(d.targetCount || 0);
        this.setData({
          loading: false,
          notFound: false,
          group: g,
          stats: d.stats ? this.decorateStats(d.stats) : null,
          members: (d.members || []).map(decorateMember),
          mine: (d.myMembers || []).map(decorateMember),
          isLeader: !!d.isLeader,
          isAdmin: !!d.isAdmin,
          joinedCount: d.joinedCount || 0,
          joiners: (d.joiners || []).map((j) =>
            Object.assign({}, j, { joinedAtText: datetime(j.joinedAt) })
          ),
          progress: target > 0 ? Math.min(100, Math.round(((d.joinedCount || 0) / target) * 100)) : 0,
        });
      })
      .catch((e) => {
        this.setData({ loading: false, notFound: true });
        fail(e);
      });
  },

  decorateStats(s) {
    return Object.assign({}, s, {
      confirmedAmountText: money(s.confirmedAmount),
    });
  },

  // ---------- 参与 ----------
  openJoin() {
    const g = this.data.group;
    if (!g) return;
    if (g.status !== 'ongoing') return wx.showToast({ title: '该拼团已' + g.statusLabel + '，无法参与', icon: 'none' });
    const active = this.data.mine.find((m) => m.payStatus !== 'cancelled');
    if (active) {
      // 已参与 → 直接去付款页
      return wx.navigateTo({ url: '/pages/pay/pay?id=' + active._id });
    }
    this.setData({
      joinShow: true,
      joinForm: {
        name: (app.globalData.profile && app.globalData.profile.name) || '',
        phone: (app.globalData.profile && app.globalData.profile.phone) || '',
        planKey: 'year',
        remark: '',
      },
    });
  },

  closeJoin() { this.setData({ joinShow: false }); },

  onJoinInput(e) {
    this.setData({ ['joinForm.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  // 选择套餐：年票 / 次票，金额由套餐决定
  choosePlan(e) {
    this.setData({ 'joinForm.planKey': e.currentTarget.dataset.key });
  },

  confirmJoin() {
    const f = this.data.joinForm;
    if (this.data.joining) return;
    if (!(f.name || '').trim()) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (!/^1\d{10}$/.test(f.phone || '')) return wx.showToast({ title: '请填写正确的手机号', icon: 'none' });
    if (!f.planKey) return wx.showToast({ title: '请选择套餐', icon: 'none' });

    this.setData({ joining: true });
    api('joinGroup', {
      groupId: this.data.groupId,
      name: f.name.trim(),
      phone: f.phone,
      planKey: f.planKey,
      remark: (f.remark || '').trim(),
      refOpenid: this.data.ref || '',
    })
      .then((d) => {
        this.setData({ joining: false, joinShow: false });
        wx.navigateTo({ url: '/pages/pay/pay?id=' + d.memberId });
      })
      .catch((e) => {
        this.setData({ joining: false });
        fail(e);
      });
  },

  // ---------- 我的参与 ----------
  goPay(e) {
    const id = e.currentTarget.dataset.id || (this.data.mine[0] && this.data.mine[0]._id);
    if (id) wx.navigateTo({ url: '/pages/pay/pay?id=' + id });
  },

  cancelJoin(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消参与',
      content: '确定取消这次参与吗？取消后如需参加需要重新报名。',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        api('cancelJoin', { memberId: id })
          .then(() => { done(); ok('已取消'); this.load(); })
          .catch((err) => { done(); fail(err); });
      },
    });
  },

  // ---------- 团长：编辑（不含定价，套餐由成员自己选）----------
  openEdit() {
    const g = this.data.group;
    this.setData({
      editShow: true,
      editForm: {
        name: g.name,
        desc: g.desc || '',
      },
    });
  },
  closeEdit() { this.setData({ editShow: false }); },
  onEditInput(e) {
    this.setData({ ['editForm.' + e.currentTarget.dataset.field]: e.detail.value });
  },
  saveEdit() {
    const f = this.data.editForm;
    if (!(f.name || '').trim()) return wx.showToast({ title: '请填写拼团名称', icon: 'none' });
    this.setData({ editing: true });
    api('updateGroup', {
      groupId: this.data.groupId,
      name: f.name.trim(),
      desc: (f.desc || '').trim(),
    })
      .then(() => {
        this.setData({ editing: false, editShow: false });
        ok('已保存');
        this.load();
      })
      .catch((e) => { this.setData({ editing: false }); fail(e); });
  },

  closeGroup() {
    wx.showModal({
      title: '关闭拼团',
      content: '关闭后该拼团不再接受新的参与，已参与的成员不受影响。确定关闭吗？',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        api('closeGroup', { groupId: this.data.groupId })
          .then(() => { done(); ok('已关闭'); this.load(); })
          .catch((e) => { done(); fail(e); });
      },
    });
  },

  // ---------- 成员详情 ----------
  showMember(e) {
    const id = e.currentTarget.dataset.id;
    const m = this.data.members.find((x) => x._id === id);
    if (m) this.setData({ memberShow: true, curMember: m });
  },
  closeMember() { this.setData({ memberShow: false, curMember: null }); },

  copyGroupNo() {
    const g = this.data.group;
    if (g && g.groupNo) {
      wx.setClipboardData({ data: g.groupNo });
    }
  },

  noop() {},

  onShareAppMessage() {
    const g = this.data.group;
    const me = app.globalData.openid || '';
    return {
      title: g ? '【' + g.name + '】' + g.leaderName + ' 邀请你参与拼团，' + PLAN_BRIEF : '一起参加拼团',
      path: '/pages/group/group?id=' + this.data.groupId + (me ? '&ref=' + me : ''),
      imageUrl: g && g.cover ? g.cover : '',
    };
  },

  onShareTimeline() {
    const me = app.globalData.openid || '';
    const g = this.data.group;
    return {
      title: g ? '【' + g.name + '】一起参加拼团' : '一起参加拼团',
      query: 'id=' + this.data.groupId + (me ? '&ref=' + me : ''),
    };
  },
});
