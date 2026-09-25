// app.js — 拼团小程序
// 业务闭环：申请成团 → 审核 → 自动建团 → 分享 → 成员参与 → 付款 → 凭证确认 → 统计（止于店家确认收款）
// 说明：本阶段不做自动拆分付款、不做子账户、不做自动打款、不做自动结算（见需求文档第 15 节）

App({
  globalData: {
    // ===== 云开发环境 ID =====
    // 开通「云开发」后，把下面这串换成你自己的环境 ID（云开发控制台首页可查）
    envId: 'cloud1-d5g63u040b7c3c704',

    brandName: '能量少年研学',

    // 当前用户身份，登录后由云函数返回并缓存在这里
    openid: '',
    role: 'user',      // user 普通用户 / leader 团长 / admin 管理员 / superadmin 超级管理员
    nickname: '',
    logged: false,

    // 「我的 → 测试管理员功能」入口是否显示。由云端 ptApi 的 selfGrantAllowed() 决定：
    // 上线前在云开发控制台删掉环境变量 ALLOW_SELF_GRANT 后，这里会变成 false，按钮自动消失。
    selfGrantEnabled: false,

    // 个人资料（姓名/手机号/头像），登录后返回，报名/申请成团时自动带出
    profile: {
      name: '',
      phone: '',
      avatarFileID: '',
    },

    // 最新一条成团申请的状态
    // pending 待审核 / approved 已通过 / rejected 已驳回 / cancelled 已撤回 / null 未申请
    apply: null,

    // 业务配置（默认值，登录后由云端配置覆盖）
    config: {
      leaderMaxGroups: 1,     // 每个团长最多可创建的拼团数
      minMembers: 0,          // 最低成团人数，0 = 不限制
      contactAdminTip: '',    // 联系管理员提示
    },
  },

  _readyCbs: [],

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请把微信开发者工具的基础库调到 2.2.3 以上，或升级微信客户端。',
        showCancel: false,
      });
      return;
    }
    wx.cloud.init({
      env: this.globalData.envId,
      traceUser: true,
    });
    // 先用本地缓存垫上资料，避免冷启动到登录返回之间姓名/手机号闪成空白
    try {
      const c = wx.getStorageSync('pt_profile_cache');
      if (c) this.globalData.profile = this.mergeProfile(c);
    } catch (e) { /* 忽略缓存读取失败 */ }
    this.login();
  },

  // 登录：拿到 openid 与角色（团长 / 管理员 / 超管），并取回业务配置
  login() {
    return wx.cloud
      .callFunction({ name: 'ptApi', data: { action: 'login' } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (!r.ok) throw new Error(r.msg || '登录失败');
        const d = r.data || {};
        this.globalData.openid = d.openid || '';
        this.globalData.role = d.role || 'user';
        this.globalData.nickname = d.nickname || '';
        this.globalData.profile = this.mergeProfile(d.profile);
        this.globalData.apply = d.apply || null;
        this.globalData.config = Object.assign({}, this.globalData.config, d.config || {});
        this.globalData.logged = true;
        this.globalData.selfGrantEnabled = !!d.selfGrantEnabled;
        console.log('[login] 身份：' + this.globalData.role + '，openid：' + this.globalData.openid);
        this.flushReady();
        return d;
      })
      .catch((err) => {
        console.error('[login] 失败：', err);
        // 云环境未配置好时给出可读的提示，避免小白用户一头雾水
        wx.showModal({
          title: '云端未连接',
          content:
            '登录云函数调用失败。请检查：\n1) app.js 里的 envId 是否已改成你的云开发环境 ID；\n2) cloudfunctions 下的 ptApi、ptAdmin 是否已右键「上传并部署」；\n3) 云开发是否已开通。\n\n详见项目根目录的《部署说明.md》。',
          showCancel: false,
        });
        this.flushReady();
        return null;
      });
  },

  // 页面等待登录完成后再渲染数据（登录失败也会回调，保证页面不会一直转圈）
  ready(cb) {
    if (typeof cb !== 'function') return;
    if (this.globalData.logged) {
      cb(this.globalData);
      return;
    }
    this._readyCbs.push(cb);
  },

  flushReady() {
    const cbs = this._readyCbs.splice(0);
    cbs.forEach((fn) => {
      try {
        fn(this.globalData);
      } catch (e) {
        console.error('[ready] 回调报错：', e);
      }
    });
  },

  // 合并个人资料：只让「有值」的字段覆盖，
  // 否则重新登录时云端返回的空字符串会把已保存的姓名/手机号冲掉
  mergeProfile(p) {
    const out = Object.assign({}, this.globalData.profile || {});
    ['name', 'phone', 'avatarUrl', 'avatarFileID'].forEach((k) => {
      if (p && p[k]) out[k] = p[k];
    });
    return out;
  },

  isAdmin() {
    const r = this.globalData.role;
    return r === 'admin' || r === 'superadmin';
  },

  isSuperAdmin() {
    return this.globalData.role === 'superadmin';
  },

  // 统一的「我要成团」入口：直接进申请页，由申请页按状态自动展示。
  // 无待处理申请（含上一个团已通过）→ 表单；待审核 → 等待审批；驳回/撤回 → 重新申请。
  goApply() {
    wx.navigateTo({ url: '/pages/apply/apply' });
  },

  // 刷新角色（例如被加入管理员名单后）
  refreshRole() {
    return this.login();
  },
});
