// 页面交互：读取所选文件 → ReportCore 生成报告 → 显示 / 打印
(function () {
  const $ = (id) => document.getElementById(id);
  const num = (id) => { const v = $(id).value.trim(); return v === "" ? null : Number(v); };

  function readFile(file) {
    return file.text().then((text) => ({ name: file.name, text }));
  }

  $("f-run").onclick = async () => {
    const status = $("f-status");
    const picked = Array.from($("f-files").files || []);
    if (!picked.length) { status.textContent = "请先选择文件。"; return; }
    status.textContent = "正在分析…";
    try {
      const files = await Promise.all(picked.map(readFile));
      const { html, stats } = ReportCore.buildReport(files, {
        client: $("f-client").value.trim() || "客户名称",
        author: $("f-author").value.trim() || "陈振旭",
        title: $("f-title").value.trim() || "运维问题分析报告",
        totalDesktops: num("f-total"),
        onlineTotal: num("f-online"),
        vpcCount: num("f-vpc"),
      });
      $("reportOut").innerHTML = `<div class="report-wrap">${html}</div>`;
      $("f-print").hidden = false;
      status.textContent = `完成：日志 ${stats.total} 行（无法解析 ${stats.bad} 行），错误 ${stats.errors} 条，突增事件 ${stats.events} 个，工单/告警 ${stats.tickets} 条。`;
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  };

  $("f-print").onclick = () => {
    document.body.classList.add("printing");
    window.print();
  };
  window.addEventListener("afterprint", () => document.body.classList.remove("printing"));
})();
