// 首页：海报垂直长页 + 限时抢购倒计时 + 浏览/团数 + 头像墙 + 最新订单 + 底部操作栏
const app = getApp();
const { api } = require('../../utils/cloud.js');
const { datetime } = require('../../utils/format.js');

// 全部海报，垂直依次展示（图片放 miniprogram/images/poster/ 下，想加图就往这里添一行）
const POSTERS = [
  { img: '/images/poster/xunlongjue.jpg', name: '寻龙诀' },
  { img: '/images/poster/taikong.jpg', name: '筑梦太空' },
  { img: '/images/poster/xiaobing.jpg', name: '小兵时代' },
  { img: '/images/poster/huahai.jpg', name: '共赴紫色花海' },
  { img: '/images/poster/chunguang.jpg', name: '春光造物' },
  { img: '/images/poster/baisikou.jpg', name: '寻迹拜寺口' },
  { img: '/images/poster/yumi.jpg', name: '塞上渔米香' },
  { img: '/images/poster/yibeinai.jpg', name: '一杯奶的故事' },
  { img: '/images/poster/feixingjia.jpg', name: '云端飞行家' },
  { img: '/images/poster/tianyuan.jpg', name: '梦想田园' },
  { img: '/images/poster/gouqi.jpg', name: '贺兰山枸杞红了' },
  { img: '/images/poster/dianbo.jpg', name: '永不消逝的电波' },
  { img: '/images/poster/piying.jpg', name: '让历史活起来' },
  { img: '/images/poster/shipin.jpg', name: '探秘食品工厂' },
];

// 顶部轮播：真实活动海报（img 为轮播裁切图，poster 为点击放大时的完整海报）
const BANNERS = [
  { img: '/images/banner/xunlongjue.jpg', poster: '/images/poster/xunlongjue.jpg' },
  { img: '/images/banner/taikong.jpg', poster: '/images/poster/taikong.jpg' },
  { img: '/images/banner/xiaobing.jpg', poster: '/images/poster/xiaobing.jpg' },
  { img: '/images/banner/huahai.jpg', poster: '/images/poster/huahai.jpg' },
];

function pad(n) { return n < 10 ? '0' + n : '' + n; }

Page({
  data: {
    brandName: '能量少年研学',
    banners: BANNERS,
    posters: POSTERS,
    serviceShow: false,
    contactTip: '',

    // 首页统计：浏览数 / 团数人数 / 头像墙 / 最新订单
    stats: null,
    // 限时抢购倒计时：{ days, hh, mm, ss }，null = 不展示
    countdown: null,
  },

  onLoad(options) {
    // 从分享链接进入时，把分享人的 openid 存起来，后续参与拼团时作为「谁拉的客」留痕
    if (options && options.ref) {
      const ref = decodeURIComponent(options.ref);
      if (ref) wx.setStorageSync('refOpenid', ref);
    }
    app.ready(() => {
      this.setData({ contactTip: (app.globalData.config && app.globalData.config.contactAdminTip) || '' });
      this.loadHomeStats();
    });
  },

  onShow() {
    // 从后台切回时恢复倒计时（config 已缓存）
    if (this.data.stats) this.startCountdown();
  },

  onHide() {
    clearInterval(this._cdTimer);
    this._cdTimer = null;
  },

  onUnload() {
    clearInterval(this._cdTimer);
    this._cdTimer = null;
  },

  // ---------------- 首页统计 ----------------
  loadHomeStats() {
    return api('homeStats')
      .then((d) => {
        const orders = (d.recentOrders || []).map((o) => {
          const amt = Number(o.amount || 0);
          let payText = '已报名';
          let payClass = 'pay-wait';
          if (o.payStatus === 'confirmed') { payText = '已支付 ¥' + amt.toFixed(2); payClass = 'pay-ok'; }
          else if (o.payStatus === 'pending') { payText = '已付款·确认中'; payClass = 'pay-wait'; }
          return Object.assign({}, o, {
            createdAtText: datetime(o.createdAt),
            payText,
            payClass,
          });
        });
        this.setData({
          stats: {
            viewCount: d.viewCount || 0,
            ongoingGroups: d.ongoingGroups || 0,
            joinedCount: d.joinedCount || 0,
            recentAvatars: d.recentAvatars || [],
            recentOrders: orders,
          },
        });
        this.startCountdown();
      })
      .catch(() => {});
  },

  // ---------------- 限时抢购倒计时（截止时间由管理员在业务设置里配置） ----------------
  startCountdown() {
    const cfg = app.globalData.config || {};
    const end = String(cfg.saleEndAt || '').trim();
    if (!end) { this.setData({ countdown: null }); return; }
    const endTs = new Date(end.replace(/-/g, '/')).getTime();
    if (isNaN(endTs)) { this.setData({ countdown: null }); return; }

    clearInterval(this._cdTimer);
    const tick = () => {
      const diff = endTs - Date.now();
      if (diff <= 0) {
        this.setData({ countdown: null });
        clearInterval(this._cdTimer);
        this._cdTimer = null;
        return;
      }
      const s = Math.floor(diff / 1000);
      this.setData({
        countdown: {
          days: Math.floor(s / 86400),
          hh: pad(Math.floor((s % 86400) / 3600)),
          mm: pad(Math.floor((s % 3600) / 60)),
          ss: pad(s % 60),
        },
      });
    };
    tick();
    this._cdTimer = setInterval(tick, 1000);
  },

  // 点单张海报 → 全屏放大预览，可长按保存/转发
  previewPoster(e) {
    const cur = e.currentTarget.dataset.img;
    wx.previewImage({ urls: this.posterUrls(), current: cur });
  },

  posterUrls() {
    return this.data.posters.map((p) => p.img);
  },

  goMine() { wx.navigateTo({ url: '/pages/mine/mine' }); },
  goHall() { wx.navigateTo({ url: '/pages/hall/hall' }); },
  goApply() { app.goApply(); },

  showService() { this.setData({ serviceShow: true }); },
  hideService() { this.setData({ serviceShow: false }); },
  noop() {},

  // 分享首页：带上自己的 openid，谁点进来就算「我邀请的」
  onShareAppMessage() {
    const me = app.globalData.openid || '';
    return {
      title: '能量少年研学 · 698元亲子研学年卡，全年48场',
      path: '/pages/index/index' + (me ? '?ref=' + me : ''),
      imageUrl: this.posterUrls()[0],
    };
  },

  onShareTimeline() {
    return { title: '能量少年研学 · 698元亲子研学年卡，全年48场' };
  },
});
