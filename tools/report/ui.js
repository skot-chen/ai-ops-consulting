// 页面交互：读取所选文件 → ReportCore 生成报告 → 显示 / 打印
(function () {
  const $ = (id) => document.getElementById(id);
  const num = (id) => { const v = $(id).value.trim(); return v === "" ? null : Number(v); };

  function readFile(file) {
    return file.text().then((text) => ({ name: file.name, text }));
  }

  // 演示数据：确定性生成，不含任何真实客户信息
  function demoLog() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const base = Date.UTC(2026, 10, 20, 9, 0, 0);
    const out = [];
    for (let i = 0; i < 120 * 6; i++) {
      const ts = base + i * 10000;
      const r = rnd();
      out.push(`${fmt(ts)} ${r < 0.97 ? "INFO" : "WARN"} api-gw ${r < 0.97 ? "request ok path=/v1/pay latency=" + Math.round(20 + rnd() * 160) + "ms" : "slow upstream latency=" + Math.round(300 + rnd() * 300) + "ms"}`);
    }
    for (let i = 0; i < 300; i++) {
      const ts = Date.UTC(2026, 10, 20, 9, 40, 0) + i * 1000;
      if (i % 2 === 0) out.push(`${fmt(ts)} ERROR db too many connections for role app (max 100) from 10.0.${i % 7}.${i % 50}`);
      if (i % 3 === 0) out.push(`${fmt(ts)} ERROR payment-svc connection timeout to db 10.0.1.9 after 3000ms req=${i}`);
    }
    out.sort();
    return out.join("\n");
  }
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

  function demoAlert() {
    const rows = [[130, 3], [81, 1], [68, 4], [67, 0], [65, 0], [65, 0], [61, 1], [56, 0], [55, 8], [51, 0]];
    const head = "date,category,title,severity,desktops,online";
    return [head, ...rows.map(([d, o], i) => `2026-01-11,外网中断,用户${String(i + 1).padStart(2, "0")},P1,${d},${o}`)].join("\n");
  }

  async function generate(files, opts, label) {
    const status = $("f-status");
    status.textContent = "正在分析…";
    try {
      const { html, stats } = ReportCore.buildReport(files, opts);
      $("reportOut").innerHTML = `<div class="report-wrap">${html}</div>`;
      $("f-print").hidden = false;
      status.textContent = `${label}完成：日志 ${stats.total} 行（无法解析 ${stats.bad} 行），错误 ${stats.errors} 条，突增事件 ${stats.events} 个，工单/告警 ${stats.tickets} 条。`;
      $("reportOut").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  }

  function currentOpts(demo) {
    return {
      client: demo ? "演示客户（虚构数据）" : ($("f-client").value.trim() || "客户名称"),
      author: $("f-author").value.trim() || "陈振旭",
      title: demo ? "演示报告（虚构数据，非真实客户）" : ($("f-title").value.trim() || "运维问题分析报告"),
      totalDesktops: num("f-total"),
      onlineTotal: num("f-online"),
      vpcCount: num("f-vpc"),
    };
  }

  $("f-demo-log").onclick = () =>
    generate([{ name: "demo.log", text: demoLog() }], currentOpts(true), "演示（日志）：");

  $("f-demo-alert").onclick = () =>
    generate([{ name: "demo-alert.csv", text: demoAlert() }],
      Object.assign(currentOpts(true), { totalDesktops: num("f-total") ?? 2623, onlineTotal: num("f-online") ?? 96, vpcCount: num("f-vpc") ?? 243 }),
      "演示（告警）：");

  $("f-run").onclick = async () => {
    const picked = Array.from($("f-files").files || []);
    if (!picked.length) { $("f-status").textContent = "请先选择文件，或点击上方的演示按钮。"; return; }
    const files = await Promise.all(picked.map(readFile));
    generate(files, currentOpts(false), "");
  };

  $("f-print").onclick = () => {
    document.body.classList.add("printing");
    window.print();
  };
  window.addEventListener("afterprint", () => document.body.classList.remove("printing"));
})();
