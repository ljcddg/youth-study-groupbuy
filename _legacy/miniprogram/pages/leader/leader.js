// 团长大厅：注册成为团长 / 搜索加入团 / 我的团
const app = getApp();

Page({
  data: {
    // 视图模式：browse 浏览搜索 | register 注册团长 | myteam 我的团
    mode: 'browse',
    keyword: '',
    results: [],
    searched: false,
    joinedLeader: null,   // 我加入的团 { name, time }
    myTeam: null,         // 我是团长的信息
    regName: '',
    regPhone: '',
    submitting: false,
    myLeaderId: '',
  },

  onShow() {
    this.loadMyStatus();
  },

  loadMyStatus() {
    this.setData({ myLeaderId: wx.getStorageSync('leaderId') || '' });
    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'getMyLeader' },
    }).then((res) => {
      const d = res.result && res.result.data;
      this.setData({ joinedLeader: d || null });
    }).catch(() => {});

    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'getMyTeam' },
    }).then((res) => {
      const d = res.result && res.result.data;
      if (d && d.isLeader) this.setData({ myTeam: d });
    }).catch(() => {});
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onRegName(e) { this.setData({ regName: e.detail.value }); },
  onRegPhone(e) { this.setData({ regPhone: e.detail.value }); },

  // 搜索团（手机号 / 姓名）
  search() {
    const kw = (this.data.keyword || '').trim();
    if (!kw) return wx.showToast({ title: '请输入手机号或姓名', icon: 'none' });
    this.setData({ searching: true });
    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'searchLeaders', keyword: kw },
    }).then((res) => {
      this.setData({ results: (res.result && res.result.data) || [], searched: true, searching: false });
    }).catch(() => {
      wx.showToast({ title: '搜索失败，请稍后再试', icon: 'none' });
      this.setData({ searching: false });
    });
  },

  // 加入团
  join(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '加入确认',
      content: '确定加入「' + name + '」的团吗？加入后首单佣金归属该团长。',
      success: (r) => {
        if (!r.confirm) return;
        wx.cloud.callFunction({
          name: 'createOrder',
          data: { action: 'joinTeam', leaderId: id },
        }).then((res) => {
          const r2 = res.result || {};
          wx.showToast({ title: r2.msg || (r2.ok ? '入团成功' : '加入失败'), icon: 'none' });
          if (r2.ok) {
            wx.setStorageSync('leaderId', id);
            this.loadMyStatus();
          }
        }).catch(() => wx.showToast({ title: '网络异常', icon: 'none' }));
      },
    });
  },

  // 注册成为团长
  register() {
    const { regName, regPhone, submitting } = this.data;
    if (submitting) return;
    if (!regName.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!/^1\d{10}$/.test(regPhone)) return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
    this.setData({ submitting: true });
    wx.cloud.callFunction({
      name: 'createOrder',
      data: { action: 'registerLeader', name: regName.trim(), phone: regPhone },
    }).then((res) => {
      const r = res.result || {};
      this.setData({ submitting: false });
      if (r.ok) {
        wx.setStorageSync('leaderId', r.data.leaderId);
        this.setData({ myLeaderId: r.data.leaderId });
        wx.showToast({ title: r.msg || '注册成功', icon: 'success' });
        this.loadMyStatus();
        this.setData({ mode: 'myteam' });
      } else {
        wx.showToast({ title: r.msg || '注册失败', icon: 'none' });
      }
    }).catch(() => {
      this.setData({ submitting: false });
      wx.showToast({ title: '网络异常', icon: 'none' });
    });
  },

  onShareAppMessage() {
    const leader = wx.getStorageSync('leaderId') || '';
    return {
      title: '能量少年研学·698元亲子研学年卡，全年48场没套路',
      path: '/pages/index/index?leader=' + leader,
    };
  },
});
