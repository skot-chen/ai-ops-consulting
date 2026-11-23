// 排障向导：根据你填写的现象和检查结果，判断问题在哪一层，并给出对照测试清单。
// 结论基于你填写的答案，不做自动探测。
(function (root) {
  "use strict";

  const LAYERS = {
    auth: "认证层（凭据或认证头）",
    gateway: "网关层（网关进程或代理）",
    upstream: "上游层（上游服务商）",
    unknown: "暂无法归类",
  };

  const TESTS = {
    401: [
      ["只带 Authorization 头请求网关", "应返回 200，说明 token 本身正确"],
      ["额外带一个错误值的 X-Api-Key 请求网关", "应返回 401，说明这个头会被上游当凭据"],
      ["查看客户端实际发出的请求头（抓包或网关日志）", "是否同时出现 Authorization 和 X-Api-Key"],
      ["过滤多余的认证头后重试，再用错误凭据做反向验证", "重试 200；错误凭据仍 200 说明过滤生效"],
    ],
    502: [
      ["直接请求网关健康检查", "应返回 200，否则先查网关进程"],
      ["查看客户端进程的代理环境变量（如 ps eww）", "是否存在 HTTP_PROXY / HTTPS_PROXY"],
      ["把地址从本地域名换成 IP 后复测", "恢复则说明代理无法解析本地域名"],
      ["直连上游对照", "直连正常、经代理失败，问题在客户端到网关之间"],
    ],
    503: [
      ["查看上游服务商的状态页或公告", "是否有故障或限流公告"],
      ["直连上游对照", "直连 503 说明上游问题；直连正常则需看时段规律"],
      ["同一时段其他客户端或标签是否也 503", "全部失败更像上游；单个失败更像配置"],
    ],
  };

  function diagnose(input) {
    const a = input.answers || {};
    const code = input.code;
    const evidence = [];
    let layer = "unknown", conclusion = "";

    if (code === "401") {
      if (a.direct === "fail") {
        layer = "upstream";
        conclusion = "直连上游也返回认证失败，问题更可能在 token 本身或上游账户状态，而不是网关。";
        evidence.push("直连上游失败");
      } else if (a.extraAuthHeader === "yes") {
        layer = "auth";
        conclusion = "客户端同时发送了多个认证头，网关原样转发，上游把其中一个陌生的头当成凭据拒绝。";
        evidence.push("客户端带了额外的认证头");
        if (a.direct === "ok") evidence.push("直连上游正常，说明凭据本身有效");
      } else if (a.extraAuthHeader === "unknown") {
        layer = "unknown";
        conclusion = "还不能判断。需要先看清客户端实际发出的请求头。";
      } else {
        layer = "auth";
        conclusion = "认证头看起来只有一个，需要继续核对网关入站头与出站头是否一致。";
      }
    } else if (code === "502") {
      if (a.health === "fail") {
        layer = "gateway";
        conclusion = "网关健康检查失败，问题在网关进程本身，先恢复网关。";
        evidence.push("网关健康检查失败");
      } else if (a.proxyEnv === "yes" && a.hostType === "local") {
        layer = "gateway";
        conclusion = "客户端带有代理环境变量，且地址是本地域名。代理可能无法解析该域名，导致 502。";
        evidence.push("存在代理环境变量", "使用本地域名");
      } else if (a.health === "ok" && a.direct === "ok") {
        layer = "gateway";
        conclusion = "网关和上游都正常，问题更可能出在客户端到网关之间的代理或地址配置。";
        evidence.push("网关健康", "直连上游正常");
      } else {
        layer = "unknown";
        conclusion = "现有答案不足以定位，请补充网关健康检查和直连上游的结果。";
      }
    } else if (code === "503") {
      if (a.upstreamStatus === "incident" || a.direct === "fail") {
        layer = "upstream";
        conclusion = a.upstreamStatus === "incident" ? "上游服务商有故障公告，问题在上游。" : "直连上游也失败，问题在上游。";
        evidence.push(a.upstreamStatus === "incident" ? "上游有故障公告" : "直连上游失败");
      } else if (a.direct === "ok") {
        layer = "upstream";
        conclusion = "直连上游正常，503 可能是上游间歇性限流或高峰期拥堵，需要对比时段规律。";
        evidence.push("直连上游正常");
      } else {
        layer = "unknown";
        conclusion = "现有答案不足以定位，请补充上游状态和直连结果。";
      }
    } else {
      conclusion = "这个错误码没有预设规则，建议按网关层、认证层、上游层逐层检查。";
    }

    if (a.peer === "fail" && layer !== "unknown") evidence.push("其他标签或客户端也失败，问题可能共享网关或上游");
    if (a.peer === "ok" && layer === "gateway") evidence.push("其他标签正常，说明问题只影响这一条链路");

    return {
      code,
      layer,
      layerName: LAYERS[layer],
      conclusion,
      evidence,
      tests: TESTS[code] || [],
      note: "结论基于你填写的答案，不是自动探测。对照测试结果出来后再确认根因。",
    };
  }

  const api = { diagnose, LAYERS, TESTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DiagCore = api;
})(typeof window !== "undefined" ? window : globalThis);
