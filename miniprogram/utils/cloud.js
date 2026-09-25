// utils/cloud.js — 云函数调用封装
// 约定：所有云函数都接收 { action, ...params }，统一返回 { ok, msg, data }

function raw(name, action, data) {
  return wx.cloud
    .callFunction({ name, data: Object.assign({ action }, data || {}) })
    .then((res) => {
      const r = (res && res.result) || {};
      if (r.ok === false) throw new Error(r.msg || '操作失败');
      return r.data;
    });
}

// 用户 / 团长侧接口
function api(action, data) {
  return raw('ptApi', action, data);
}

// 管理端接口
function adm(action, data) {
  return raw('ptAdmin', action, data);
}

// 统一的错误提示（把云函数返回的 msg 直接展示给用户）
function fail(err, fallback) {
  const msg = (err && (err.message || err.errMsg)) || fallback || '网络异常，请稍后再试';
  wx.showToast({ title: msg, icon: 'none', duration: 2600 });
  return msg;
}

function ok(title) {
  wx.showToast({ title: title || '操作成功', icon: 'success' });
}

function loading(title) {
  wx.showLoading({ title: title || '处理中', mask: true });
}

function done() {
  wx.hideLoading();
}

module.exports = { api, adm, raw, fail, ok, loading, done };
