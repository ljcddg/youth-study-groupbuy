// 我的：个人入口聚合 + 个人资料编辑
// 资料链路：保存 → 写库（pt_users）→ 本地缓存兜底 → 每次进入页面再以云端为准刷新
const app = getApp();
const { api, fail, ok, loading, done } = require('../../utils/cloud.js');

const ROLE_LABEL = { user: '普通用户', leader: '团长', admin: '管理员', superadmin: '超级管理员' };
const PROFILE_KEY = 'pt_profile_cache';

Page({
  data: {
    roleLabel: '普通用户',
    roleClass: 'st-gray',
    isAdmin: false,
    serviceShow: false,
    contactTip: '',
    isAdminReady: false,

    // 「测试管理员功能」入口是否显示（由云端 selfGrantAllowed() 决定，见 app.js 注释）
    selfGrantEnabled: false,

    // 我的 openid（低调展示，点击可复制）
    openid: '',

    // 个人资料
    profile: { name: '', phone: '', avatarUrl: '', avatarFileID: '' },
    profileShow: false,
    profileForm: { name: '', phone: '' },
    avatarUploading: false,
    saving: false,
  },

  onLoad() {
    this.applyCache(); // 先垫上本地缓存，避免闪一下默认文案
    app.ready(() => this.refresh());
  },

  onShow() {
    this.applyCache();
    if (app.globalData.logged) {
      this.refresh();
      this.loadProfile().then(() => this.maybeGuideProfile()); // 每次进入都以云端数据为准
    }
  },

  // 只取有值的字段，避免空字符串把已保存的资料冲掉
  pick(p) {
    const out = {};
    ['name', 'phone', 'avatarUrl', 'avatarFileID'].forEach((k) => {
      if (p && p[k]) out[k] = p[k];
    });
    return out;
  },

  applyCache() {
    let c = {};
    try {
      c = wx.getStorageSync(PROFILE_KEY) || {};
    } catch (e) {
      c = {};
    }
    if (c.name || c.phone || c.avatarUrl || c.avatarFileID) {
      this.setData({ profile: Object.assign({}, this.data.profile, this.pick(c)) });
    }
  },

  refresh() {
    const role = app.globalData.role || 'user';
    this.setData({
      isAdminReady: true,
      roleLabel: ROLE_LABEL[role] || '普通用户',
      roleClass: role === 'leader' ? 'st-confirmed' : role === 'user' ? 'st-gray' : 'st-pending',
      isAdmin: app.isAdmin(),
      selfGrantEnabled: !!app.globalData.selfGrantEnabled,
      contactTip: (app.globalData.config && app.globalData.config.contactAdminTip) || '',
      openid: app.globalData.openid || '',
      profile: Object.assign({}, this.data.profile, this.pick(app.globalData.profile)),
    });
  },

  // 低调复制 openid（整行点击即复制，不做醒目按钮）
  copyOpenid() {
    const id = this.data.openid;
    if (!id) return;
    wx.setClipboardData({ data: id });
  },

  // ---------------- 个人资料 ----------------
  // 首次进入且完全没填过资料时，自动弹出资料编辑，引导用户一键选用微信头像和昵称（只弹一次）
  maybeGuideProfile() {
    try {
      if (wx.getStorageSync('pt_profile_guided')) return;
    } catch (e) {}
    const p = this.data.profile || {};
    if (!p.name && !p.avatarFileID && !p.avatarUrl) {
      try { wx.setStorageSync('pt_profile_guided', 1); } catch (e) {}
      this.openProfile();
    }
  },

  openProfile() {
    const p = app.globalData.profile || {};
    this.setData({
      profileShow: true,
      profileForm: { name: p.name || this.data.profile.name || '', phone: p.phone || this.data.profile.phone || '' },
    });
    this.loadProfile();
  },
  closeProfile() { this.setData({ profileShow: false }); },

  // 从云端拉取最新资料（含头像临时链接），并同步到全局 + 本地缓存
  loadProfile() {
    return api('getProfile')
      .then((p) => {
        const next = Object.assign({}, this.data.profile, this.pick(p));
        this.setData({ profile: next });
        app.globalData.profile = Object.assign({}, app.globalData.profile, next);
        try {
          wx.setStorageSync(PROFILE_KEY, {
            name: next.name || '',
            phone: next.phone || '',
            avatarUrl: next.avatarUrl || '',
            avatarFileID: next.avatarFileID || '',
          });
        } catch (e) { /* 忽略缓存失败 */ }
        return next;
      })
      .catch(() => {});
  },

  // 兼容旧调用
  loadAvatar() { return this.loadProfile(); },

  onProfileInput(e) {
    this.setData({ ['profileForm.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  // 微信「头像昵称填写能力」：一键选用微信头像（临时路径 → 上传云存储）
  onChooseAvatar(e) {
    const temp = e.detail && e.detail.avatarUrl;
    if (!temp || this.data.avatarUploading) return;
    this.setData({ avatarUploading: true });
    const ext = (temp.match(/\.(\w+)$/) || [])[1] || 'jpg';
    const cloudPath = 'avatars/' + (app.globalData.openid || 'u') + '_' + Date.now() + '.' + ext;
    wx.cloud
      .uploadFile({ cloudPath, filePath: temp })
      .then((up) => {
        this.setData({
          avatarUploading: false,
          'profile.avatarFileID': up.fileID,
          'profile.avatarUrl': temp, // 先显示本地，保存后会换成云端链接
        });
      })
      .catch((err) => {
        this.setData({ avatarUploading: false });
        fail(err, '头像上传失败');
      });
  },

  saveProfile() {
    const f = this.data.profileForm;
    const name = String(f.name || '').trim();
    if (!name) return wx.showToast({ title: '请填写姓名', icon: 'none' });
    if (f.phone && !/^1\d{10}$/.test(f.phone)) return wx.showToast({ title: '手机号格式不正确', icon: 'none' });

    this.setData({ saving: true });
    loading('保存中');
    api('saveProfile', {
      name,
      phone: f.phone,
      avatarFileID: this.data.profile.avatarFileID || '',
    })
      .then(() => {
        done();
        this.setData({ saving: false, profileShow: false });
        // 同步到全局，报名时自动带出
        const next = Object.assign({}, app.globalData.profile, {
          name,
          phone: f.phone,
          avatarFileID: this.data.profile.avatarFileID || '',
        });
        app.globalData.profile = next;
        try {
          wx.setStorageSync(PROFILE_KEY, {
            name: next.name || '',
            phone: next.phone || '',
            avatarUrl: this.data.profile.avatarUrl || '',
            avatarFileID: next.avatarFileID || '',
          });
        } catch (e) { /* 忽略 */ }
        ok('已保存');
        this.refresh();
        // 拉回云端头像的正式链接，替换掉本地临时路径（临时路径页面重建后会失效）
        return this.loadProfile();
      })
      .catch((e) => {
        done();
        this.setData({ saving: false });
        fail(e);
      });
  },

  goJoins() { wx.navigateTo({ url: '/pages/joins/joins' }); },
  goMyGroups() { wx.navigateTo({ url: '/pages/mygroups/mygroups' }); },
  goCalendar() { wx.navigateTo({ url: '/pages/calendar/calendar' }); },

  // 测试管理员功能：先把当前微信设为管理员，再进入管理端
  goAdmin() {
    loading('设为管理员');
    api('selfGrantAdmin')
      .then(() => {
        done();
        return app.refreshRole();
      })
      .then(() => {
        ok('已设为管理员');
        wx.navigateTo({ url: '/pages/admin/index/index' });
      })
      .catch((e) => {
        done();
        fail(e);
      });
  },

  showService() { this.setData({ serviceShow: true }); },
  hideService() { this.setData({ serviceShow: false }); },
  noop() {},

  onShareAppMessage() {
    const me = app.globalData.openid || '';
    return {
      title: '能量少年研学 · 698元亲子研学年卡，全年48场',
      path: '/pages/index/index' + (me ? '?ref=' + me : ''),
    };
  },
});
