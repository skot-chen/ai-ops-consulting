"""客户日志/工单分析 → 带水印的 PDF 报告。

全程本地运行，不联网、不上传。
用法:
    python3 make_report.py --input data/<客户目录> --client "某某客户" --author "陈振旭" --out out/
输入目录中支持:
    *.log / *.txt  : 形如 "2026-11-20 09:40:01 ERROR payment-svc connection timeout ..."
    *.csv          : 工单，需包含列 date,category,title（可选 severity）
"""
from __future__ import annotations

import argparse
import csv
import html
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import weasyprint

LINE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s+(FATAL|ERROR|WARN|WARNING|INFO|DEBUG)\s+(\S+)\s+(.*)$")
VAR_PATTERNS = [
    (re.compile(r"\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b"), "<IP>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<UUID>"),
    (re.compile(r"\b\d+(\.\d+)?(ms|s|MB|GB|%)?\b"), "<NUM>"),
]
# 规则：关键词 → 排查建议（来自一线经验，可按客户环境增删）
RULES = [
    (("timeout", "超时"), "超时：先查下游依赖的延迟与连接数，再查网络与防火墙。"),
    (("too many connections", "connection pool", "连接池"), "连接数打满：查连接池上限、连接泄漏与慢 SQL。"),
    (("401", "unauthorized", "invalid api key"), "认证失败：核对入站与出站认证头，排查代理是否复制了多余的头。"),
    (("403", "forbidden"), "权限拒绝：核对账号权限、白名单与访问策略。"),
    (("502", "bad gateway"), "网关无法连到上游：查网关进程、代理环境变量、DNS 与本地域名解析。"),
    (("503", "unavailable"), "上游不可用：先看上游服务商状态，并用其他客户端直连对照。"),
    (("out of memory", "oom"), "内存不足：查内存曲线、泄漏点与容器限制。"),
    (("disk", "no space"), "磁盘满：查增长最快的目录与日志轮转策略。"),
    (("外网", "上外网", "internet", "egress"), "多个账号同时不能上外网：先查资源池出口网关、NAT、默认路由与防火墙，确认受影响 VPC 是否共用同一出口。"),
]


@dataclass
class LogLine:
    ts: datetime
    level: str
    service: str
    message: str


def templatize(msg: str) -> str:
    out = msg
    for pat, token in VAR_PATTERNS:
        out = pat.sub(token, out)
    return out[:160]


def read_logs(folder: Path) -> tuple[list[LogLine], int, int]:
    lines: list[LogLine] = []
    total = bad = 0
    for path in sorted(folder.glob("*.log")) + sorted(folder.glob("*.txt")):
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not raw.strip():
                continue
            total += 1
            m = LINE_RE.match(raw.strip())
            if not m:
                bad += 1
                continue
            ts = datetime.fromisoformat(m.group(1).replace(" ", "T"))
            level = "WARN" if m.group(2) == "WARNING" else m.group(2)
            lines.append(LogLine(ts, level, m.group(3), m.group(4)))
    return lines, total, bad


def read_tickets(folder: Path) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(folder.glob("*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                if row.get("title"):
                    rows.append(row)
    return rows


def find_spikes(lines: list[LogLine], window_min: int, min_count: int, threshold: float):
    """按服务、时间窗统计 ERROR 数量，用中位数 + MAD 稳健评分找突增，相邻窗口合并。"""
    errors = [l for l in lines if l.level in ("ERROR", "FATAL")]
    if not errors:
        return []
    width = timedelta(minutes=window_min)
    start = min(l.ts for l in lines).replace(second=0, microsecond=0)
    per_service: dict[str, Counter] = defaultdict(Counter)
    for l in errors:
        bucket = start + ((l.ts - start) // width) * width
        per_service[l.service][bucket] += 1
    events = []
    all_buckets = []
    t = start
    end = max(l.ts for l in lines)
    while t <= end:
        all_buckets.append(t)
        t += width
    for svc, counts in per_service.items():
        series = [counts.get(b, 0) for b in all_buckets]
        med = statistics.median(series)
        mad = statistics.median([abs(x - med) for x in series]) or 1
        hot = []
        for b, c in zip(all_buckets, series):
            score = (c - med) / (1.4826 * mad)
            if c >= min_count and score >= threshold:
                hot.append((b, c, score))
        # 合并相邻窗口
        group = []
        for item in hot:
            if group and item[0] - group[-1][0] <= width:
                group.append(item)
            else:
                if group:
                    events.append((svc, group, med))
                group = [item]
        if group:
            events.append((svc, group, med))
    events.sort(key=lambda e: e[1][0][0])
    return events


def advice_for(messages: list[str]) -> list[str]:
    text = " ".join(messages).lower()
    out = []
    for keys, tip in RULES:
        if any(k in text for k in keys):
            out.append(tip)
    return out


def summarize_alert(tickets):
    """告警数据（带 desktops/online 列）→ 影响面汇总；不是告警数据则返回 None。"""
    if not tickets or "desktops" not in tickets[0]:
        return None

    def num(v):
        try:
            return int(float(v or 0))
        except ValueError:
            return 0

    desk = sum(num(t["desktops"]) for t in tickets)
    online = sum(num(t.get("online")) for t in tickets)
    top = sorted(tickets, key=lambda t: num(t["desktops"]), reverse=True)[:10]
    return {
        "accounts": len(tickets),
        "desktops": desk,
        "online": online,
        "rate": online / desk * 100 if desk else 0,
        "top": [(t.get("title", ""), num(t["desktops"]), num(t.get("online"))) for t in top],
    }


def build_html(args, lines, total, bad, tickets, events, top_templates, advices) -> str:
    esc = html.escape
    first = min((l.ts for l in lines), default=None)
    last = max((l.ts for l in lines), default=None)
    err_count = sum(1 for l in lines if l.level in ("ERROR", "FATAL"))
    span = f"{first:%Y-%m-%d %H:%M} ～ {last:%Y-%m-%d %H:%M}" if first else (
        f"告警日期：{tickets[0].get('date', '未知')}" if tickets else "无有效日志")
    today = datetime.now().strftime("%Y-%m-%d")

    ev_rows = "".join(
        f"<tr><td>{esc(svc)}</td><td>{g[0][0]:%H:%M}–{(g[-1][0] + timedelta(minutes=args.window)):%H:%M}</td>"
        f"<td>{sum(c for _, c, _ in g)}</td><td>{max(s for *_, s in g):.1f}</td></tr>"
        for svc, g, _ in events
    ) or ('<tr><td colspan="4">无日志数据，未做突增分析</td></tr>' if not lines else '<tr><td colspan="4">未发现明显突增</td></tr>')

    tpl_rows = "".join(
        f"<tr><td>{n}</td><td><code>{esc(t)}</code></td></tr>" for t, n in top_templates
    ) or '<tr><td colspan="2">无错误记录</td></tr>'

    cn = iter("一二三四五六七")
    alert = summarize_alert(tickets)
    n_over = next(cn)
    n_alert = next(cn) if alert else None
    n_events, n_tpl = next(cn), next(cn)
    n_ticket = next(cn) if (tickets and alert is None) else None
    n_adv, n_limit = next(cn), next(cn)

    overview_kpi = "" if alert else f"""<table class="kpi"><tr><th>日志行数</th><th>错误数</th><th>突增事件</th><th>无法解析行</th></tr>
<tr><td>{total}</td><td>{err_count}</td><td>{len(events)}</td><td>{bad}</td></tr></table>"""

    alert_html = ""
    if alert:
        meta_total = args.total_desktops if args.total_desktops is not None else alert["desktops"]
        meta_online = args.online_total if args.online_total is not None else alert["online"]
        vpc_row = f"<tr><td>{args.vpc_count}</td>" if args.vpc_count is not None else "<tr><td>—</td>"
        top_rows = "".join(
            f"<tr><td>{esc(t)}</td><td>{d}</td><td>{o}</td><td>{(o / d * 100 if d else 0):.0f}%</td></tr>"
            for t, d, o in alert["top"]
        )
        alert_html = f"""<h2>{n_alert}、影响面（告警）</h2>
<table class="kpi"><tr><th>涉及 VPC</th><th>受影响账号</th><th>总桌面（告警）</th><th>在线（告警）</th><th>在线率</th></tr>
{vpc_row}<td>{alert['accounts']}</td><td>{meta_total}</td><td>{meta_online}</td><td>{(meta_online / meta_total * 100 if meta_total else 0):.1f}%</td></tr></table>
<p class="note">明细仅列出前 10 个账号（共 {alert['accounts']} 个），合计 {alert['desktops']} 台桌面、在线 {alert['online']} 台。在线数受作息影响，判断影响时以"不能上网的桌面数"为准。</p>
<table><tr><th>账号（脱敏）</th><th>总桌面</th><th>在线</th><th>在线率</th></tr>{top_rows}</table>
"""

    ticket_html = ""
    if tickets and alert is None:
        cats = Counter((t.get("category") or "未分类") for t in tickets)
        rows = "".join(f"<tr><td>{esc(c)}</td><td>{n}</td></tr>" for c, n in cats.most_common(8))
        ticket_html = f"<h2>{n_ticket}、工单分类</h2><p>共 {len(tickets)} 条工单。</p><table><tr><th>分类</th><th>数量</th></tr>{rows}</table>"

    adv_html = "".join(f"<li>{esc(a)}</li>" for a in advices) or "<li>未匹配到已知规则，需人工进一步判断。</li>"

    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
@page {{
  size: A4; margin: 2.2cm 2cm 2.4cm 2cm;
  @bottom-left {{ content: "{esc(args.author)} · {today} · 机密"; font-size: 9pt; color: #64748b; }}
  @bottom-right {{ content: "第 " counter(page) " / " counter(pages) " 页"; font-size: 9pt; color: #64748b; }}
}}
body {{ font-family: "PingFang SC", "Heiti SC", "Noto Sans CJK SC", sans-serif; color: #0f172a; font-size: 10.5pt; line-height: 1.6; }}
h1 {{ font-size: 22pt; margin: 0 0 4pt; color: #0f766e; }}
h2 {{ font-size: 14pt; margin: 18pt 0 6pt; padding-left: 8pt; border-left: 4pt solid #4f46e5; }}
.meta {{ color: #64748b; font-size: 9.5pt; margin-bottom: 12pt; }}
table {{ width: 100%; border-collapse: collapse; margin: 6pt 0; font-size: 9.5pt; }}
th, td {{ border-bottom: 0.5pt solid #e2e8f0; padding: 4pt 6pt; text-align: left; vertical-align: top; }}
th {{ background: #f1f5f9; }}
code {{ font-family: Menlo, monospace; font-size: 8.5pt; background: #f1f5f9; padding: 0 3pt; word-break: break-all; }}
.kpi td {{ text-align: center; font-size: 16pt; font-weight: bold; color: #0f766e; }}
.kpi th {{ font-size: 8.5pt; color: #64748b; font-weight: normal; }}
.note {{ color: #64748b; font-size: 9pt; }}
.watermark {{ position: fixed; top: 38%; left: -8%; width: 120%; text-align: center;
  font-size: 54pt; font-weight: bold; color: rgba(79,70,229,0.08); transform: rotate(-30deg); white-space: nowrap; }}
</style></head><body>
<div class="watermark">{esc(args.author)} · 机密</div>
<h1>{esc(args.title)}</h1>
<div class="meta">客户：{esc(args.client)} ｜ 编制：{esc(args.author)} ｜ 日期：{today}</div>

<h2>{n_over}、概览</h2>
{overview_kpi}
<p>时间范围：{span}</p>
<p class="note">方法：按服务和 {args.window} 分钟窗口统计错误数，用中位数与 MAD 稳健评分识别突增，相邻窗口合并为一个事件。本报告仅基于提供的材料，结论需结合现场情况确认。</p>

{alert_html}<h2>{n_events}、异常时段</h2>
<table><tr><th>服务</th><th>时段</th><th>错误数</th><th>最高评分</th></tr>{ev_rows}</table>

<h2>{n_tpl}、高频错误模板</h2>
<p class="note">变量（IP、数字、UUID）已替换为占位符，便于合并同类错误。</p>
<table><tr><th>次数</th><th>模板</th></tr>{tpl_rows}</table>

{ticket_html}

<h2>{n_adv}、排查建议</h2>
<ul>{adv_html}</ul>

<h2>{n_limit}、局限说明</h2>
<p class="note">1. 分析只覆盖提供的日志与工单，未包含监控指标与变更记录。2. 突增判断依赖历史数据量，样本过少时结果不可靠。3. 建议作为排查方向，根因需通过对照测试确认。</p>
</body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser(description="客户材料分析 → 带水印 PDF 报告")
    ap.add_argument("--input", required=True, type=Path, help="客户材料目录")
    ap.add_argument("--out", type=Path, default=Path("out"), help="输出目录")
    ap.add_argument("--client", default="客户名称", help="客户名（报告中显示）")
    ap.add_argument("--author", default="陈振旭", help="编制人（水印与页脚）")
    ap.add_argument("--title", default="运维问题分析报告", help="报告标题")
    ap.add_argument("--window", type=int, default=5, help="统计窗口（分钟）")
    ap.add_argument("--min-count", type=int, default=5, help="窗口内最少错误数")
    ap.add_argument("--threshold", type=float, default=3.5, help="稳健评分阈值")
    ap.add_argument("--total-desktops", type=int, help="告警全量总桌面数（来自告警头部，可选）")
    ap.add_argument("--online-total", type=int, help="告警全量在线数（来自告警头部，可选）")
    ap.add_argument("--vpc-count", type=int, help="告警涉及 VPC 数（来自告警头部，可选）")
    args = ap.parse_args()

    lines, total, bad = read_logs(args.input)
    tickets = read_tickets(args.input)
    if not lines and not tickets:
        raise SystemExit("未找到可解析的日志或工单，请检查目录和格式。")

    events = find_spikes(lines, args.window, args.min_count, args.threshold)
    errs = [l for l in lines if l.level in ("ERROR", "FATAL")]
    tpl = Counter(templatize(l.message) for l in errs)
    top_templates = tpl.most_common(10)
    advices = advice_for([l.message for l in errs] + [f"{t.get('category', '')} {t.get('title', '')}" for t in tickets])

    doc = build_html(args, lines, total, bad, tickets, events, top_templates, advices)
    args.out.mkdir(parents=True, exist_ok=True)
    stem = f"report-{args.client}-{datetime.now():%Y%m%d}"
    (args.out / f"{stem}.html").write_text(doc, encoding="utf-8")
    weasyprint.HTML(string=doc, base_url=str(args.input)).write_pdf(args.out / f"{stem}.pdf")
    print(f"done: {args.out / (stem + '.pdf')}  (日志 {total} 行，无法解析 {bad} 行，突增事件 {len(events)} 个)")


if __name__ == "__main__":
    main()
