"""Run four thinking modes and generate a comparison. No key is saved."""
import argparse
import csv
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime
import uuid


def main():
    parser = argparse.ArgumentParser(description="四种思考模式各测 5 次，自动生成对比报告")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prompt-file", type=Path, help="自定义 UTF-8 题目；默认使用资源采购优化题")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    prompt_file = args.prompt_file or root / "思考模式测试题.txt"
    if not prompt_file.is_file():
        parser.error(f"找不到题目文件：{prompt_file}")
    modes = [("disabled", None), ("low", "low"), ("high", "high"), ("max", "max")]
    folder = root / "results" / ("compare_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:8])
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if not args.dry_run and not env.get("DEEPSEEK_API_KEY", "").strip():
        if not sys.stdin.isatty():
            print("没有 DEEPSEEK_API_KEY。请在交互终端运行本程序以隐藏输入密钥。")
            return 2
        key = getpass.getpass("请输入 DeepSeek API Key（输入不显示，回车开始测试）：").strip()
        if not key:
            print("未输入密钥，未发送请求。")
            return 2
        env["DEEPSEEK_API_KEY"] = key
    print("最多 20 次请求：每档 5 次；并发 1；输出上限 4096 token。")
    print(f"四组使用同一道题：{prompt_file}")
    print("费用采用 Flash 高峰参考价：输入 2、缓存 0.04、输出 8 元/百万 token。实际以账单为准。")
    comparisons = []
    if not args.dry_run:
        folder.mkdir(parents=True)
    try:
        for label, effort in modes:
            target = folder / label
            command = [sys.executable, str(root / "benchmark.py"), "--scenario", "speed",
                       "--model", "deepseek-flash", "--requests", "5", "--prompt-file", str(prompt_file),
                       "--thinking", "enabled" if effort else "disabled", "--max-tokens", "4096",
                       "--timeout", "300", "--input-price", "2", "--cache-price", ".04",
                       "--output-price", "8", "--currency", "CNY", "--out", str(target)]
            if effort:
                command.extend(["--effort", effort])
            if args.dry_run:
                command.append("--dry-run")
            print(f"\n===== 模式：{label} =====", flush=True)
            result = subprocess.run(command, env=env)
            if args.dry_run:
                if result.returncode:
                    return result.returncode
                continue
            summaries = list(target.glob("*/summary.json"))
            if not summaries:
                print("未生成本组汇总，停止后续测试。")
                break
            summary = json.loads(summaries[0].read_text(encoding="utf-8"))
            stage = summary["stages"].get("speed_c1", {})
            metrics = stage.get("metrics", {})
            records = [json.loads(line) for line in (summaries[0].parent / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
            reasoning = [r["reasoning_tokens"] for r in records if r["success"] and r["reasoning_tokens"] is not None]
            costs = [r["estimated_cost"] for r in records if r["estimated_cost"] is not None]
            row = {"mode": label, "attempted": stage.get("attempted"), "success": stage.get("succeeded"),
                   "ttft_p50_s": metrics.get("ttft_s", {}).get("p50"),
                   "answer_p50_s": metrics.get("first_answer_s", {}).get("p50"),
                   "e2e_p50_s": metrics.get("e2e_s", {}).get("p50"),
                   "e2e_p95_s": metrics.get("e2e_s", {}).get("p95"),
                   "mean_reasoning_tokens": sum(reasoning) / len(reasoning) if reasoning else None,
                   "reasoning_usage_n": len(reasoning),
                   "mean_output_tokens": metrics.get("completion_tokens", {}).get("mean"),
                   "mean_known_cost_cny": sum(costs) / len(costs) if costs else None,
                   "total_known_cost_cny": summary.get("known_total_cost"), "cost_known_n": len(costs),
                   "truncated": stage.get("truncated_count"), "failure_rate": stage.get("failure_rate"),
                   "cache_hit_ratio": stage.get("cache_hit_ratio"), "result_directory": str(summaries[0].parent)}
            comparisons.append(row)
            # Authentication/balance/config errors stop the complete comparison as well.
            if any(r.get("http_status") in (400, 401, 402, 403, 404) for r in records):
                print("检测到配置、密钥或余额问题，停止后续模式。")
                break
    finally:
        if comparisons:
            with (folder / "comparison.csv").open("w", encoding="utf-8-sig", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=list(comparisons[0]))
                writer.writeheader()
                writer.writerows(comparisons)
            (folder / "comparison.json").write_text(json.dumps(comparisons, ensure_ascii=False, indent=2), encoding="utf-8")
            def fmt(value):
                return "—" if value is None else f"{value:.4f}" if isinstance(value, float) else str(value)
            columns = ["mode", "success", "ttft_p50_s", "answer_p50_s", "e2e_p50_s", "mean_reasoning_tokens", "total_known_cost_cny", "truncated"]
            lines = ["# 思考模式性能对比", "", "每组仅 5 次，是初步观测，不评价答案质量。缺失用量留空；费用为高峰参考单价估算。",
                     "", "| 模式 | 成功次数 | TTFT P50秒 | 正文 P50秒 | 总耗时 P50秒 | 平均推理token | 已知总费用元 | 截断次数 |",
                     "|---|---:|---:|---:|---:|---:|---:|---:|"]
            lines.extend("| " + " | ".join(fmt(row[key]) for key in columns) + " |" for row in comparisons)
            lines.extend(["", "各模式按顺序执行，时段和网络变化可能影响结果。相同输出上限不代表相同输出长度。",
                          "推理模式消耗上限后可能没有正文，须结合成功率、截断和原始记录解释。",
                          "完整费用覆盖数、缓存比例、P95 和逐组结果路径见 comparison.csv。"])
            (folder / "comparison.md").write_text("\n".join(lines), encoding="utf-8")
            print(f"\n对比结果已保存：{folder / 'comparison.md'}", flush=True)
    return 0 if args.dry_run or len(comparisons) == 4 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("已中断；已完成组的汇总已保留，在途请求可能产生费用。")
        sys.exit(130)
