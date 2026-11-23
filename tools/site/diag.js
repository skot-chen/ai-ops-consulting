// 排障向导页面逻辑：读取表单 → DiagCore.diagnose → 显示层级、依据与对照测试
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 表单控件 id → 诊断答案字段
  const FIELDS = {
    "d-health": "health", "d-direct": "direct", "d-peer": "peer", "d-extra": "extraAuthHeader",
    "d-proxy": "proxyEnv", "d-host": "hostType", "d-upstream": "upstreamStatus",
  };

  // 示例：只是预填表单，结论由 DiagCore 按规则算出
  const DEMOS = {
    "401": { code: "401", answers: { direct: "ok", extraAuthHeader: "yes" } },
    "502": { code: "502", answers: { health: "ok", direct: "ok", proxyEnv: "yes", hostType: "local" } },
    "503": { code: "503", answers: { direct: "ok", upstreamStatus: "normal", peer: "fail" } },
  };

  function fill({ code, answers }) {
    $("d-code").value = code;
    for (const [id, key] of Object.entries(FIELDS)) $(id).value = answers[key] || "unknown";
  }

  function readForm() {
    const answers = {};
    for (const [id, key] of Object.entries(FIELDS)) answers[key] = $(id).value;
    return { code: $("d-code").value, answers };
  }

  function render(r) {
    const evidence = r.evidence.length
      ? `<ul>${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
      : '<p class="note">没有额外依据，结论只基于上面的主要判断。</p>';
    const tests = r.tests.length
      ? `<table><tr><th>步骤</th><th>做什么</th><th>预期结果</th></tr>${r.tests
          .map(([step, expect], i) => `<tr><td>${i + 1}</td><td>${esc(step)}</td><td>${esc(expect)}</td></tr>`).join("")}</table>`
      : '<p class="note">该错误码暂无预设测试清单，请按网关层、认证层、上游层逐层检查。</p>';
    $("d-out").innerHTML = `<div class="report-wrap">
      <h2>判断：${esc(r.layerName)}</h2>
      <p>${esc(r.conclusion)}</p>
      <h2>依据</h2>${evidence}
      <h2>对照测试清单</h2>${tests}
      <p class="note">${esc(r.note)}</p>
    </div>`;
  }

  function run() {
    const input = readForm();
    render(DiagCore.diagnose(input));
  }

  for (const code of Object.keys(DEMOS)) {
    $("d-demo-" + code).onclick = () => { fill(DEMOS[code]); run(); };
  }
  $("d-run").onclick = run;
})();
