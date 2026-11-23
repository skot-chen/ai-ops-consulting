// 客户材料分析 → 报告 HTML（浏览器内运行，数据不上传）
// 与 make_report.py 的规则保持一致：日志模板化、中位数+MAD 突增检测、告警影响面、排查建议。
(function (root) {
  "use strict";

  const LINE_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s+(FATAL|ERROR|WARN|WARNING|INFO|DEBUG)\s+(\S+)\s+(.*)$/;
  const VAR_PATTERNS = [
    [/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "<IP>"],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>"],
    [/\b\d+(\.\d+)?(ms|s|MB|GB|%)?\b/g, "<NUM>"],
  ];
  const RULES = [
    [["timeout", "超时"], "超时：先查下游依赖的延迟与连接数，再查网络与防火墙。"],
    [["too many connections", "connection pool", "连接池"], "连接数打满：查连接池上限、连接泄漏与慢 SQL。"],
    [["401", "unauthorized", "invalid api key"], "认证失败：核对入站与出站认证头，排查代理是否复制了多余的头。"],
    [["403", "forbidden"], "权限拒绝：核对账号权限、白名单与访问策略。"],
    [["502", "bad gateway"], "网关无法连到上游：查网关进程、代理环境变量、DNS 与本地域名解析。"],
    [["503", "unavailable"], "上游不可用：先看上游服务商状态，并用其他客户端直连对照。"],
    [["out of memory", "oom"], "内存不足：查内存曲线、泄漏点与容器限制。"],
    [["disk", "no space"], "磁盘满：查增长最快的目录与日志轮转策略。"],
    [["外网", "上外网", "internet", "egress"], "多个账号同时不能上外网：先查资源池出口网关、NAT、默认路由与防火墙，确认受影响 VPC 是否共用同一出口。"],
  ];
  const CN = ["一", "二", "三", "四", "五", "六", "七", "八"];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  // 时间按"本地墙上时间"处理：用 UTC 取值避免时区影响
  const fmtTime = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtDate = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const fmtDateTime = (ms) => `${fmtDate(ms)} ${fmtTime(ms)}`;

  function parseTs(s) {
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  function templatize(msg) {
    let out = msg;
    for (const [re, tok] of VAR_PATTERNS) out = out.replace(re, tok);
    return out.slice(0, 160);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
  }

  // files: [{name, text}]
  function parseInputs(files) {
    const lines = [];
    let total = 0, bad = 0;
    let tickets = [];
    for (const f of files) {
      if (/\.csv$/i.test(f.name)) {
        tickets = tickets.concat(parseCsv(f.text).filter((t) => t.title));
        continue;
      }
      if (!/\.(log|txt)$/i.test(f.name)) continue;
      for (const raw of f.text.split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        total++;
        const m = s.match(LINE_RE);
        if (!m) { bad++; continue; }
        lines.push({ ts: parseTs(m[1]), level: m[2] === "WARNING" ? "WARN" : m[2], service: m[3], message: m[4] });
      }
    }
    return { lines, total, bad, tickets };
  }

  function findSpikes(lines, windowMin, minCount, threshold) {
    const errors = lines.filter((l) => l.level === "ERROR" || l.level === "FATAL");
    if (!errors.length) return [];
    const width = windowMin * 60000;
    const start = Math.floor(Math.min(...lines.map((l) => l.ts)) / 60000) * 60000;
    const end = Math.max(...lines.map((l) => l.ts));
    const buckets = [];
    for (let t = start; t <= end; t += width) buckets.push(t);
    const perSvc = new Map();
    for (const l of errors) {
      const b = start + Math.floor((l.ts - start) / width) * width;
      if (!perSvc.has(l.service)) perSvc.set(l.service, new Map());
      const m = perSvc.get(l.service);
      m.set(b, (m.get(b) || 0) + 1);
    }
    const median = (arr) => { const a = [...arr].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };
    const events = [];
    for (const [svc, counts] of perSvc) {
      const series = buckets.map((b) => counts.get(b) || 0);
      const med = median(series);
      const mad = median(series.map((x) => Math.abs(x - med))) || 1;
      const hot = [];
      buckets.forEach((b, i) => {
        const c = series[i];
        const score = (c - med) / (1.4826 * mad);
        if (c >= minCount && score >= threshold) hot.push({ t: b, c, score });
      });
      let group = [];
      for (const item of hot) {
        if (group.length && item.t - group[group.length - 1].t <= width) group.push(item);
        else { if (group.length) events.push({ svc, group, width }); group = [item]; }
      }
      if (group.length) events.push({ svc, group, width });
    }
    events.sort((a, b) => a.group[0].t - b.group[0].t);
    return events;
  }

  function adviceFor(texts) {
    const text = texts.join(" ").toLowerCase();
    return RULES.filter(([keys]) => keys.some((k) => text.includes(k))).map(([, tip]) => tip);
  }

  function summarizeAlert(tickets) {
    if (!tickets.length || !("desktops" in tickets[0])) return null;
    const num = (v) => { const n = parseInt(v || 0, 10); return Number.isNaN(n) ? 0 : n; };
    const desk = tickets.reduce((s, t) => s + num(t.desktops), 0);
    const online = tickets.reduce((s, t) => s + num(t.online), 0);
    const top = [...tickets].sort((a, b) => num(b.desktops) - num(a.desktops)).slice(0, 10)
      .map((t) => ({ title: t.title, desk: num(t.desktops), online: num(t.online) }));
    return { accounts: tickets.length, desktops: desk, online, rate: desk ? (online / desk) * 100 : 0, top };
  }

  function buildReport(files, opt) {
    const o = Object.assign({ client: "客户名称", author: "陈振旭", title: "运维问题分析报告", window: 5, minCount: 5, threshold: 3.5, totalDesktops: null, onlineTotal: null, vpcCount: null }, opt || {});
    const { lines, total, bad, tickets } = parseInputs(files);
    if (!lines.length && !tickets.length) throw new Error("未找到可解析的日志或工单，请检查文件和格式。");

    const alert = summarizeAlert(tickets);
    const errs = lines.filter((l) => l.level === "ERROR" || l.level === "FATAL");
    const tplCounts = new Map();
    for (const l of errs) { const t = templatize(l.message); tplCounts.set(t, (tplCounts.get(t) || 0) + 1); }
    const topTpl = [...tplCounts].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const events = findSpikes(lines, o.window, o.minCount, o.threshold);
    const advices = adviceFor([...errs.map((l) => l.message), ...tickets.map((t) => `${t.category || ""} ${t.title}`)]);
    const today = fmtDate(Date.now());

    const first = lines.length ? Math.min(...lines.map((l) => l.ts)) : null;
    const last = lines.length ? Math.max(...lines.map((l) => l.ts)) : null;
    const span = first ? `${fmtDateTime(first)} ～ ${fmtDateTime(last)}` : (tickets.length ? `告警日期：${tickets[0].date || "未知"}` : "无有效日志");

    const cn = CN.slice(); let k = 0; const next = () => cn[k++];
    const nOver = next();
    const nAlert = alert ? next() : null;
    const nEvents = next(), nTpl = next();
    const nTicket = tickets.length && !alert ? next() : null;
    const nAdv = next(), nLimit = next();

    const overviewKpi = alert ? "" : `<table class="kpi"><tr><th>日志行数</th><th>错误数</th><th>突增事件</th><th>无法解析行</th></tr>
<tr><td>${total}</td><td>${errs.length}</td><td>${events.length}</td><td>${bad}</td></tr></table>`;

    let alertHtml = "";
    if (alert) {
      const mt = o.totalDesktops ?? alert.desktops, mo = o.onlineTotal ?? alert.online;
      const vpc = o.vpcCount != null ? o.vpcCount : "—";
      const topRows = alert.top.map((t) => `<tr><td>${esc(t.title)}</td><td>${t.desk}</td><td>${t.online}</td><td>${t.desk ? Math.round((t.online / t.desk) * 100) : 0}%</td></tr>`).join("");
      alertHtml = `<h2>${nAlert}、影响面（告警）</h2>
<table class="kpi"><tr><th>涉及 VPC</th><th>受影响账号</th><th>总桌面（告警）</th><th>在线（告警）</th><th>在线率</th></tr>
<tr><td>${vpc}</td><td>${alert.accounts}</td><td>${mt}</td><td>${mo}</td><td>${mt ? ((mo / mt) * 100).toFixed(1) : "0.0"}%</td></tr></table>
<p class="note">明细仅列出前 ${alert.top.length} 个账号（共 ${alert.accounts} 个），合计 ${alert.desktops} 台桌面、在线 ${alert.online} 台。在线数受作息影响，判断影响时以"不能上网的桌面数"为准。</p>
<table><tr><th>账号（脱敏）</th><th>总桌面</th><th>在线</th><th>在线率</th></tr>${topRows}</table>`;
    }

    const evRows = events.length ? events.map((e) => {
      const endT = e.group[e.group.length - 1].t + e.width;
      const sum = e.group.reduce((s, g) => s + g.c, 0);
      const maxS = Math.max(...e.group.map((g) => g.score));
      return `<tr><td>${esc(e.svc)}</td><td>${fmtTime(e.group[0].t)}–${fmtTime(endT)}</td><td>${sum}</td><td>${maxS.toFixed(1)}</td></tr>`;
    }).join("") : (lines.length ? '<tr><td colspan="4">未发现明显突增</td></tr>' : '<tr><td colspan="4">无日志数据，未做突增分析</td></tr>');
    const tplRows = topTpl.length ? topTpl.map(([t, n]) => `<tr><td>${n}</td><td><code>${esc(t)}</code></td></tr>`).join("") : '<tr><td colspan="2">无错误记录</td></tr>';

    let ticketHtml = "";
    if (tickets.length && !alert) {
      const cats = new Map();
      for (const t of tickets) { const c = t.category || "未分类"; cats.set(c, (cats.get(c) || 0) + 1); }
      const rows = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `<tr><td>${esc(c)}</td><td>${n}</td></tr>`).join("");
      ticketHtml = `<h2>${nTicket}、工单分类</h2><p>共 ${tickets.length} 条工单。</p><table><tr><th>分类</th><th>数量</th></tr>${rows}</table>`;
    }
    const advHtml = advices.length ? advices.map((a) => `<li>${esc(a)}</li>`).join("") : "<li>未匹配到已知规则，需人工进一步判断。</li>";

    const html = `<div class="watermark">${esc(o.author)} · 机密</div>
<div class="report">
<h1>${esc(o.title)}</h1>
<div class="meta">客户：${esc(o.client)} ｜ 编制：${esc(o.author)} ｜ 日期：${today}</div>
<h2>${nOver}、概览</h2>
${overviewKpi}
<p>时间范围：${esc(span)}</p>
<p class="note">方法：按服务和 ${o.window} 分钟窗口统计错误数，用中位数与 MAD 稳健评分识别突增，相邻窗口合并为一个事件。本报告仅基于提供的材料，结论需结合现场情况确认。</p>
${alertHtml}
<h2>${nEvents}、异常时段</h2>
<table><tr><th>服务</th><th>时段</th><th>错误数</th><th>最高评分</th></tr>${evRows}</table>
<h2>${nTpl}、高频错误模板</h2>
<p class="note">变量（IP、数字、UUID）已替换为占位符，便于合并同类错误。</p>
<table><tr><th>次数</th><th>模板</th></tr>${tplRows}</table>
${ticketHtml}
<h2>${nAdv}、排查建议</h2>
<ul>${advHtml}</ul>
<h2>${nLimit}、局限说明</h2>
<p class="note">1. 分析只覆盖提供的日志与工单，未包含监控指标与变更记录。2. 突增判断依赖历史数据量，样本过少时结果不可靠。3. 建议作为排查方向，根因需通过对照测试确认。</p>
</div>`;
    return { html, stats: { total, bad, errors: errs.length, events: events.length, tickets: tickets.length, alert: !!alert } };
  }

  const api = { buildReport, parseInputs, findSpikes, summarizeAlert, templatize, parseCsv, adviceFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ReportCore = api;
})(typeof window !== "undefined" ? window : globalThis);
