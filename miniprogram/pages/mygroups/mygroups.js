// 我的拼团（团长视角）
const app = getApp();
const { api, fail, ok, loading, done } = require('../../utils/cloud.js');
const { decorateGroup } = require('../../utils/format.js');

Page({
  data: {
    loading: true,
    list: [],
    role: 'user',
    isLeader: false,
    config: { leaderMaxGroups: 1, minMembers: 0 },

    editShow: false,
    editForm: { _id: '', name: '', desc: '' },
    editing: false,
  },

  onLoad() {
    app.ready(() => this.load());
  },

  onShow() {
    if (app.globalData.logged && this.data.list.length) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    const g = app.globalData;
    return api('getMyGroups')
      .then((d) => {
        const cfg = (d && d.config) || g.config || {};
        this.setData({
          loading: false,
          list: ((d && d.list) || []).map((x) => decorateGroup(x, cfg)),
          config: cfg,
          role: g.role,
          isLeader: g.role === 'leader' || (d && d.list && d.list.length > 0),
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  goGroup(e) {
    wx.navigateTo({ url: '/pages/group/group?id=' + e.currentTarget.dataset.id });
  },

  goApply() {
    app.goApply();
  },

  // ---------- 编辑 ----------
  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    const g = this.data.list.find((x) => x._id === id);
    if (!g) return;
    this.setData({
      editShow: true,
      editForm: { _id: g._id, name: g.name, desc: g.desc || '' },
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
      groupId: f._id,
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

  // ---------- 关闭 ----------
  closeGroup(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '关闭拼团',
      content: '关闭后不再接受新的参与，已参与成员不受影响。确定关闭吗？',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        api('closeGroup', { groupId: id })
          .then(() => { done(); ok('已关闭'); this.load(); })
          .catch((err) => { done(); fail(err); });
      },
    });
  },

  noop() {},

  onShareAppMessage() {
    const me = app.globalData.openid || '';
    return { title: '能量少年研学 · 拼团报名', path: '/pages/index/index' + (me ? '?ref=' + me : '') };
  },
});
