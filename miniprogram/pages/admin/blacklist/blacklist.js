// 管理端 · 黑名单
const app = getApp();
const { adm, fail, ok, loading, done } = require('../../../utils/cloud.js');
const { datetime } = require('../../../utils/format.js');

Page({
  data: {
    loading: true,
    list: [],
  },

  onLoad() {
    app.ready(() => this.load());
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return adm('listBlacklist')
      .then((d) => {
        this.setData({
          loading: false,
          list: (d.list || []).map((b) => Object.assign({}, b, { createdAtText: datetime(b.createdAt) })),
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        fail(e);
      });
  },

  restore(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '';
    wx.showModal({
      title: '移出黑名单',
      content: '确定恢复「' + name + '」吗？恢复后对方可再次申请成为团长。',
      success: (r) => {
        if (!r.confirm) return;
        loading('处理中');
        adm('restoreBlacklist', { id })
          .then(() => { done(); ok('已移出黑名单'); this.load(); })
          .catch((err) => { done(); fail(err); });
      },
    });
  },

  noop() {},
});
