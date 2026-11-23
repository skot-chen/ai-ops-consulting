// 网关轮换模拟：演示多 Key 轮换、失败切换和恢复的过程。
// 这是模拟，不是真实网关；随机数用固定种子，同样的输入每次结果一致。
(function (root) {
  "use strict";

  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  // keys: [{id, status: "ok"|"401"|"403"|"429"}]，status 表示该 Key 实际会返回的结果
  // requests: 请求数；recoverSec: 失效 Key 的恢复时间（模拟秒，每个请求间隔 1 秒）
  function simulate({ keys, requests = 30, recoverSec = 10, seed = 42 }) {
    const rand = rng(seed);
    const state = keys.map((k) => ({ ...k, downUntil: -1 }));
    const log = [];
    const usage = Object.fromEntries(keys.map((k) => [k.id, 0]));
    let ok = 0, failovers = 0;

    for (let i = 0; i < requests; i++) {
      const t = i;
      const tried = [];
      let done = false;
      while (!done) {
        const healthy = state.filter((k) => k.downUntil <= t && !tried.includes(k.id));
        if (!healthy.length) {
          log.push({ n: i + 1, t, key: "-", result: "无可用 Key", ok: false, switched: tried.length > 0 });
          break;
        }
        const pick = healthy[Math.floor(rand() * healthy.length)];
        tried.push(pick.id);
        usage[pick.id]++;
        if (pick.status === "ok") {
          ok++;
          log.push({ n: i + 1, t, key: pick.id, result: "200 成功", ok: true, switched: tried.length > 1 });
          done = true;
        } else {
          pick.downUntil = t + recoverSec;
          failovers++;
          log.push({ n: i + 1, t, key: pick.id, result: `${pick.status} 失败，切换到其他 Key`, ok: false, switched: true });
        }
      }
    }

    return {
      requests,
      ok,
      rate: requests ? (ok / requests) * 100 : 0,
      failovers,
      usage,
      log,
    };
  }

  const api = { simulate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BalanceCore = api;
})(typeof window !== "undefined" ? window : globalThis);
