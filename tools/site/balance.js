// 网关轮换模拟页面逻辑：编辑 Key 列表 → BalanceCore.simulate → 显示汇总、用量与日志
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STATUS = { ok: "200 正常", "401": "401 认证失败", "403": "403 无权限", "429": "429 限流" };
  const DEMO_KEYS = [
    { id: "Key-A", status: "401" },
    { id: "Key-B", status: "429" },
    { id: "Key-C", status: "ok" },
  ];

  function addRow(id, status) {
    const row = document.createElement("div");
    row.className = "b-row";
    const options = Object.entries(STATUS)
      .map(([v, t]) => `<option value="${v}"${v === status ? " selected" : ""}>${t}</option>`).join("");
    row.innerHTML = `<input type="text" class="b-id" value="${esc(id)}"><select class="b-status">${options}</select><button type="button" class="ghost b-del">删除</button>`;
    row.querySelector(".b-del").onclick = () => row.remove();
    $("b-keys").appendChild(row);
  }

  function setKeys(keys) {
    $("b-keys").innerHTML = "";
    keys.forEach((k) => addRow(k.id, k.status));
  }

  function readKeys() {
    return Array.from(document.querySelectorAll("#b-keys .b-row")).map((row) => ({
      id: row.querySelector(".b-id").value.trim() || "未命名",
      status: row.querySelector(".b-status").value,
    }));
  }

  function run() {
    const keys = readKeys();
    if (!keys.length) { $("b-out").innerHTML = '<p class="note">请至少添加一个 Key。</p>'; return; }
    const requests = Math.min(500, Math.max(1, parseInt($("b-requests").value, 10) || 30));
    const recoverSec = Math.max(0, parseInt($("b-recover").value, 10) || 0);
    const seed = parseInt($("b-seed").value, 10) || 42;
    const r = BalanceCore.simulate({ keys, requests, recoverSec, seed });

    const usageRows = keys
      .map((k) => `<tr><td>${esc(k.id)}</td><td>${esc(STATUS[k.status])}</td><td>${r.usage[k.id] ?? 0}</td></tr>`).join("");
    const SHOW = 30;
    const logRows = r.log.slice(0, SHOW)
      .map((x) => `<tr><td>${x.n}</td><td>${x.t}</td><td>${esc(x.key)}</td><td>${esc(x.result)}</td></tr>`).join("");

    $("b-out").innerHTML = `<div class="report-wrap">
      <h2>汇总</h2>
      <p>共 ${r.requests} 次请求，成功 ${r.ok} 次，成功率 ${r.rate.toFixed(1)}%，发生切换 ${r.failovers} 次。</p>
      <h2>各 Key 用量</h2>
      <table><tr><th>Key</th><th>返回结果</th><th>被调用次数</th></tr>${usageRows}</table>
      <h2>逐次日志</h2>
      <table><tr><th>第几次请求</th><th>模拟秒</th><th>使用的 Key</th><th>结果</th></tr>${logRows}</table>
      <p class="note">${r.log.length > SHOW ? `日志共 ${r.log.length} 条，此处显示前 ${SHOW} 条。` : ""}同一次请求失败后会换 Key 重试，所以日志条数可能多于请求数。失效的 Key 在恢复时间内不会再被选中。这是模拟结果，不代表真实网关的表现。</p>
    </div>`;
  }

  $("b-add").onclick = () => addRow("Key-" + String.fromCharCode(65 + document.querySelectorAll("#b-keys .b-row").length), "ok");
  $("b-demo").onclick = () => { setKeys(DEMO_KEYS); $("b-requests").value = 30; $("b-recover").value = 10; $("b-seed").value = 42; run(); };
  $("b-run").onclick = run;
  setKeys(DEMO_KEYS);
})();
