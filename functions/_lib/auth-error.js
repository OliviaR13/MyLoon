// 鉴权存储暂时读不了。调用方应返回 503，不要把用户当成已登出后清掉本地数据。
export function authUnavailable() {
  const err = new Error("auth_unavailable");
  err.code = "auth_unavailable";
  return err;
}

export const isAuthUnavailable = (err) => err?.code === "auth_unavailable";
