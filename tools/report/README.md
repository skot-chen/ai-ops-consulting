# 客户材料分析 → 带水印报告

本地运行，不联网、不上传。客户数据只放在 `consulting/data/`（已被 .gitignore 忽略），不要提交到 GitHub。

## 准备材料

把客户提供的材料放进一个目录，例如 `data/某客户/`：

- `*.log` / `*.txt`：每行格式为 `时间 级别 服务名 消息`，例如
  `2026-11-20 09:40:01 ERROR payment-svc connection timeout to db 10.0.1.9 after 3000ms`
- `*.csv`：工单，需要 `date,category,title` 三列，可选 `severity`

无法解析的行会被计入报告的"无法解析行"，不会被静默丢弃。

## 生成报告

```bash
cd consulting
python3 tools/report/make_report.py --input data/某客户 --client "某客户" --author "陈振旭" --out out
```

输出 PDF 与 HTML 到 `out/`。每页有斜向水印和页脚（编制人、日期、机密）。

## 报告内容

1. 概览：行数、错误数、突增事件数、无法解析行数
2. 异常时段：按服务和时间窗的错误突增，中位数加 MAD 稳健评分
3. 高频错误模板：IP、数字、UUID 替换为占位符后合并统计
4. 工单分类（有 CSV 时）
5. 排查建议：按关键词匹配的一线经验规则，可在 `RULES` 中增删
6. 局限说明

## 注意

- 结论是排查方向，不是根因。报告里的局限说明需要保留。
- `sample/` 下的日志和工单是合成的测试数据，不是真实客户数据。
