'use strict';

function parseGateway(raw) {
  let value = String(raw || '').trim();
  if (!value) throw new Error('请填写本机网关地址，或留空使用自动检测');
  if (!value.includes('://')) value = `http://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error('网关地址格式不正确，例如 127.0.0.1:3425'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网关地址仅支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('网关地址中不能包含账号或密码');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('只需填写主机和端口，不要包含接口路径、参数或片段');
  let host = url.hostname.toLowerCase();
  if (['localhost', '0.0.0.0', '[::]', '::'].includes(host)) host = '127.0.0.1';
  if (!(host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host))) throw new Error('路由接口仅支持本机读取，请使用 127.0.0.1、localhost 或 [::1]');
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/)[0];
  const explicitPort = /:(\d+)$/.exec(authority)?.[1];
  return `${url.protocol}//${host}:${url.port || explicitPort || '3425'}`;
}

function gatewayProblem(error) {
  if (error?.name === 'AbortError') return '读取超时，请检查 magpie 是否仍在响应';
  const status = Number(error?.status) || 0;
  if (status === 404) return '接口不存在（HTTP 404），请检查端口和 magpie 版本';
  if (status === 403) return '接口拒绝访问（HTTP 403），路由数据仅允许本机读取';
  if (status === 401) return '接口要求身份验证（HTTP 401）';
  if (status) return `接口返回 HTTP ${status}`;
  const code = error?.cause?.code || error?.code;
  if (code === 'ECONNREFUSED') return 'magpie 未启动，或当前端口没有网关监听';
  if (code === 'ENOTFOUND') return '无法解析网关地址';
  return error?.message || '读取失败';
}

module.exports = {parseGateway, gatewayProblem};
