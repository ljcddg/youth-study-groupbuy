// 全年 48 场活动安排表
// 进入页面自动展开「当前月份」并滚动定位过去
const { MONTHS } = require('../../data/activities.js');

// 年卡周期是 6 月 → 次年 5 月，数据顺序不是 1-12，
// 所以要按月份数字去匹配下标，不能直接拿 getMonth() 当索引
function currentMonthIndex() {
  const m = new Date().getMonth() + 1;
  const idx = MONTHS.findIndex((x) => parseInt(x.month, 10) === m);
  return idx >= 0 ? idx : 0;
}

Page({
  data: {
    months: MONTHS,
    expandedMonth: 0,
    curIdx: 0,
  },

  _scrollTop: 0,
  _focusedMonth: -1,

  onLoad() {
    this.focusCurrentMonth();
  },

  onShow() {
    // 跨月后再次进入时重新定位；同月内不打断用户手动展开的月份
    if (this._focusedMonth !== currentMonthIndex()) this.focusCurrentMonth();
    else this.setData({ curIdx: currentMonthIndex() });
  },

  onPageScroll(e) {
    this._scrollTop = e.scrollTop || 0;
  },

  // 展开当前月，并把页面滚到它上面
  focusCurrentMonth() {
    const idx = currentMonthIndex();
    this._focusedMonth = idx;
    this.setData({ expandedMonth: idx, curIdx: idx }, () => {
      // 等列表按新高度渲染完再量位置，否则量到的是折叠状态
      setTimeout(() => this.scrollToMonth(idx), 60);
    });
  },

  scrollToMonth(idx) {
    wx.createSelectorQuery()
      .in(this)
      .select('#m' + idx)
      .boundingClientRect((rect) => {
        if (!rect) return;
        const top = rect.top + this._scrollTop - 24;
        wx.pageScrollTo({ scrollTop: top > 0 ? top : 0, duration: 220 });
      })
      .exec();
  },

  toggleMonth(e) {
    const idx = e.currentTarget.dataset.idx;
    this.setData({
      expandedMonth: this.data.expandedMonth === idx ? -1 : idx,
    });
  },

  onShareAppMessage() {
    return {
      title: '能量少年研学 · 全年48场活动安排表，每周六开展',
      path: '/pages/index/index',
    };
  },
});
