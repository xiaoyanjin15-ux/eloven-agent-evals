"""DeepSeek streaming API benchmark. See 测试说明.md for definitions and examples."""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import math
import os
import platform
import statistics
import sys
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


def percentile(values, q):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    position = (len(values) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    return values[low] + (values[high] - values[low]) * (position - low)


def stats(values):
    values = [v for v in values if v is not None]
    return {"n": len(values), "mean": statistics.mean(values) if values else None,
            "p50": percentile(values, .50), "p95": percentile(values, .95),
            "p99": percentile(values, .99)}


def token_number(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def derive(row, args):
    usage = row.get("usage") or {}
    prompt = token_number(usage.get("prompt_tokens"))
    output = token_number(usage.get("completion_tokens"))
    hit = token_number(usage.get("prompt_cache_hit_tokens"))
    if hit is None:
        hit = token_number((usage.get("prompt_tokens_details") or {}).get("cached_tokens"))
    miss = token_number(usage.get("prompt_cache_miss_tokens"))
    if hit is None and prompt is not None and miss is not None and miss <= prompt:
        hit = prompt - miss
    if miss is None and prompt is not None and hit is not None and hit <= prompt:
        miss = prompt - hit
    valid_cache = (prompt is not None and hit is not None and miss is not None
                   and hit + miss == prompt)
    reasoning = token_number((usage.get("completion_tokens_details") or {}).get("reasoning_tokens"))
    if reasoning is None and args.thinking == "disabled" and row["reasoning_chars"] == 0:
        reasoning = 0
    answer = output - reasoning if output is not None and reasoning is not None and reasoning <= output else None
    row.update(prompt_tokens=prompt, completion_tokens=output, reasoning_tokens=reasoning,
               answer_tokens=answer, cache_hit_tokens=hit, cache_miss_tokens=miss,
               cache_usage_valid=valid_cache,
               cache_hit_ratio=hit / prompt if valid_cache and prompt else None)
    # Chunk timestamps do not expose per-token timestamps. Rates are explicitly estimates.
    for prefix, count, first, last, chunks in [
        ("output", output, row["ttft_s"], row["last_content_s"], row["content_chunks"]),
        ("answer", answer, row["first_answer_s"], row["last_answer_s"], row["answer_chunks"]),
    ]:
        duration = last - first if last is not None and first is not None else 0
        row[prefix + "_tokens_per_s_est"] = (
            count / duration if row["success"] and count is not None and duration > 0 and chunks >= 2 else None)
    prices = [args.input_price, args.cache_price, args.output_price]
    row["estimated_cost"] = ((miss * prices[0] + hit * prices[1] + output * prices[2]) / 1e6
                             if valid_cache and output is not None and all(p is not None for p in prices) else None)


async def one_request(client, args, prompt, stage, index, phase="measure"):
    row = dict(stage=stage, phase=phase, index=index, started_utc=datetime.now(timezone.utc).isoformat(),
               requested_model=args.model, response_model=None, response_id=None,
               system_fingerprint=None, prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
               prompt_chars=len(prompt), success=False, error_type=None, http_status=None,
               finish_reason=None, ttft_s=None, first_answer_s=None, last_content_s=None,
               last_answer_s=None, content_chunks=0, answer_chunks=0, answer_chars=0,
               reasoning_chars=0, usage=None)
    start = time.perf_counter()

    async def consume():
        kwargs = dict(model=args.model, messages=[{"role": "user", "content": prompt}],
                      stream=True, stream_options={"include_usage": True}, max_tokens=args.max_tokens,
                      extra_body={"thinking": {"type": args.thinking}})
        if args.thinking == "enabled":
            kwargs["reasoning_effort"] = args.effort
        stream = await client.chat.completions.create(**kwargs)
        async with stream:
            async for chunk in stream:
                elapsed = time.perf_counter() - start
                row["response_model"] = getattr(chunk, "model", None) or row["response_model"]
                row["response_id"] = getattr(chunk, "id", None) or row["response_id"]
                row["system_fingerprint"] = getattr(chunk, "system_fingerprint", None) or row["system_fingerprint"]
                if getattr(chunk, "usage", None) is not None:
                    row["usage"] = chunk.usage.model_dump()
                for choice in chunk.choices:
                    if choice.index != 0:
                        continue
                    reasoning = getattr(choice.delta, "reasoning_content", None) or ""
                    answer = getattr(choice.delta, "content", None) or ""
                    if reasoning or answer:
                        if row["ttft_s"] is None:
                            row["ttft_s"] = elapsed
                        row["last_content_s"] = elapsed
                        row["content_chunks"] += 1
                    if answer:
                        if row["first_answer_s"] is None:
                            row["first_answer_s"] = elapsed
                        row["last_answer_s"] = elapsed
                        row["answer_chunks"] += 1
                    row["answer_chars"] += len(answer)
                    row["reasoning_chars"] += len(reasoning)
                    if choice.finish_reason:
                        row["finish_reason"] = choice.finish_reason

    try:
        await asyncio.wait_for(consume(), timeout=args.timeout)
        row["success"] = row["finish_reason"] in ("stop", "length") and row["answer_chars"] > 0
        if not row["success"]:
            row["error_type"] = "NoAnswer" if row["finish_reason"] else "IncompleteStream"
    except asyncio.TimeoutError:
        row["error_type"] = "RequestDeadlineExceeded"
    except Exception as exc:
        # Never persist exception bodies: providers may echo credentials or private inputs.
        row["error_type"] = type(exc).__name__
        row["http_status"] = getattr(exc, "status_code", None)
    row["e2e_s"] = time.perf_counter() - start
    row["truncated"] = row["finish_reason"] == "length"
    derive(row, args)
    return row


def summarize(rows, wall_s, requested):
    successful = [r for r in rows if r["success"]]
    token_rows = [r for r in successful if r["completion_tokens"] is not None]
    cache_rows = [r for r in rows if r["cache_usage_valid"]]
    prompt_sum = sum(r["prompt_tokens"] for r in cache_rows)
    known_costs = [r["estimated_cost"] for r in rows if r["estimated_cost"] is not None]
    return dict(requested=requested, attempted=len(rows), skipped=requested - len(rows),
                succeeded=len(successful), failed=len(rows) - len(successful), wall_s=wall_s,
                failure_rate=(len(rows) - len(successful)) / len(rows) if rows else None,
                errors=dict(Counter(str(r["http_status"] or r["error_type"]) for r in rows if not r["success"])),
                truncated_count=sum(r["truncated"] for r in rows),
                success_requests_per_s=len(successful) / wall_s if wall_s else None,
                known_success_output_tokens_per_s=sum(r["completion_tokens"] for r in token_rows) / wall_s if wall_s and token_rows else None,
                successful_token_usage_coverage=len(token_rows) / len(successful) if successful else None,
                cache_hit_ratio=sum(r["cache_hit_tokens"] for r in cache_rows) / prompt_sum if prompt_sum else None,
                cache_usage_rows=len(cache_rows), cost_known_rows=len(known_costs),
                known_estimated_cost=sum(known_costs) if known_costs else None,
                metrics={name: stats([r[name] for r in successful]) for name in
                         ("ttft_s", "first_answer_s", "e2e_s", "output_tokens_per_s_est", "answer_tokens_per_s_est", "prompt_tokens", "completion_tokens")})


def make_prompt(args, base, run_id, stage, index, shared=False):
    marker = run_id + ("-shared" if shared else f"-{stage}-{index:06d}")
    return f"测试编号：{marker}（无需在答案中复述）。\n" + base


async def run_stage(client, args, base, run_id, stage, concurrency, mode, emit):
    rows = []
    fatal = False
    shared = mode == "repeat"
    if shared:
        primer = await one_request(client, args, make_prompt(args, base, run_id, stage, 0, True), stage, 0, "primer")
        emit(primer)
        if not primer["success"]:
            return [], {"primer_failed": True, "requested": args.requests, "attempted": 0, "skipped": args.requests}, True
        await asyncio.sleep(args.cache_wait)
    queue = asyncio.Queue()
    for i in range(1, args.requests + 1):
        queue.put_nowait(i)
    start = time.perf_counter()

    async def worker():
        nonlocal fatal
        while not fatal:
            try:
                index = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            row = await one_request(client, args, make_prompt(args, base, run_id, stage, index, shared), stage, index)
            rows.append(row)
            emit(row)
            # Stop launching new requests on configuration/authentication/balance failures.
            if row["http_status"] in (400, 401, 402, 403, 404):
                fatal = True
    await asyncio.gather(*(worker() for _ in range(min(concurrency, args.requests))))
    return rows, summarize(rows, time.perf_counter() - start, args.requests), fatal


def parser():
    p = argparse.ArgumentParser(description="DeepSeek API 性能测试：测速、并发、缓存、费用。默认不重试。")
    p.add_argument("--scenario", choices=["speed", "load", "cache"], default="speed")
    p.add_argument("--model", default="deepseek-flash")
    p.add_argument("--base-url", default="https://api.deepseek.com")
    p.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    p.add_argument("--thinking", choices=["enabled", "disabled"], default="disabled")
    p.add_argument("--effort", choices=["low", "high", "max"], default="high")
    p.add_argument("--requests", type=int, default=5, help="每个阶段的请求总数（不是每个并发用户的数量）")
    p.add_argument("--concurrency", type=int, nargs="+", default=[1, 2, 4, 8])
    p.add_argument("--max-tokens", type=int, default=512)
    p.add_argument("--timeout", type=float, default=120, help="每请求总时间上限，单位秒")
    p.add_argument("--cache-wait", type=float, default=5)
    p.add_argument("--context-chars", type=int, default=2000, help="内置资料字符数，不是 token 数")
    p.add_argument("--prompt-file", type=Path, help="UTF-8 文本，替换内置完整提示词")
    p.add_argument("--input-price", type=float, help="每百万未命中输入 token 单价")
    p.add_argument("--cache-price", type=float, help="每百万缓存命中 token 单价")
    p.add_argument("--output-price", type=float, help="每百万输出 token 单价")
    p.add_argument("--currency", default="USD")
    p.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "results")
    p.add_argument("--dry-run", action="store_true", help="只展示测试计划，不联网、不扣费")
    return p


def plan(args):
    if args.scenario == "load":
        return [(f"load_c{c}", c, "unique") for c in args.concurrency]
    if args.scenario == "cache":
        return [("unique_prefix", 1, "unique"), ("repeated_prefix", 1, "repeat")]
    return [("speed_c1", 1, "unique")]


def write_outputs(folder, rows, report):
    (folder / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if rows:
        keys = [k for k in rows[0] if k != "usage"]
        with (folder / "requests.csv").open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, keys, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
    lines = ["# API 性能测试结果", "", f"请求模型：`{report['config']['model']}`；币种：{report['config']['currency']}",
             "", "费用为配置单价计算的已知部分，不是平台账单。primer 也计费。空值表示无法计算，不代表 0。", "",
             "| 阶段 | 已执行/计划 | 成功 | TTFT P50(s) | 正文 P50(s) | 总耗时 P95(s) | 失败率 |", "|---|---:|---:|---:|---:|---:|---:|"]
    def fmt(v):
        return "—" if v is None else f"{v:.3f}"
    for name, s in report["stages"].items():
        m = s.get("metrics", {})
        lines.append(f"| {name} | {s['attempted']}/{s['requested']} | {s.get('succeeded', 0)} | "
                     f"{fmt(m.get('ttft_s', {}).get('p50'))} | {fmt(m.get('first_answer_s', {}).get('p50'))} | "
                     f"{fmt(m.get('e2e_s', {}).get('p95'))} | {fmt(s.get('failure_rate'))} |")
    lines += ["", f"已知估算总费用（含 primer）：{fmt(report['known_total_cost'])} {report['config']['currency']}",
              f"费用可计算请求数：{report['cost_known_rows']}/{len(rows)}", "", "完整吞吐量、分位数、用量、错误分布请看 summary.json；逐请求看 requests.csv。",
              "", "少量样本不适合判断尾延迟；成功不代表答案正确；length 表示达到输出上限。失败请求可能已计费。",
              "返回的 model 字段可能仍是别名，不能据此保证实际权重版本。"]
    (folder / "report.md").write_text("\n".join(lines), encoding="utf-8")


async def execute(args, base, stages, api_key):
    try:
        import openai
    except ImportError:
        raise SystemExit("缺少 openai 包。请用运行脚本的同一个 Python 执行 -m pip install -r requirements.txt")
    run_id = uuid.uuid4().hex[:12]
    folder = args.out / (datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + run_id)
    folder.mkdir(parents=True, exist_ok=False)
    config = {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}
    report = dict(config=config, run_id=run_id, python=sys.version, executable=sys.executable,
                  platform=platform.platform(), openai_version=openai.__version__, stages={}, interrupted=False)
    (folder / "config.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = []
    print(f"结果目录：{folder}", flush=True)
    with (folder / "requests.jsonl").open("w", encoding="utf-8") as log:
        def emit(row):
            rows.append(row)
            log.write(json.dumps(row, ensure_ascii=False) + "\n")
            log.flush()
            print(f"[{row['stage']}/{row['phase']}] {row['index']} "
                  f"{'OK' if row['success'] else 'FAIL'} {row['e2e_s']:.2f}s "
                  f"status={row['http_status']} error={row['error_type']}", flush=True)
        try:
            async with openai.AsyncOpenAI(api_key=api_key, base_url=args.base_url,
                                        max_retries=0, timeout=args.timeout) as client:
                for name, concurrency, mode in stages:
                    _, summary, fatal = await run_stage(client, args, base, run_id, name, concurrency, mode, emit)
                    report["stages"][name] = summary
                    if fatal:
                        print("已停止后续请求：请检查配置、密钥、余额或 primer 结果。", flush=True)
                        break
        except (asyncio.CancelledError, KeyboardInterrupt):
            report["interrupted"] = True
            raise
        finally:
            costs = [r["estimated_cost"] for r in rows if r["estimated_cost"] is not None]
            report["known_total_cost"] = sum(costs) if costs else None
            report["cost_known_rows"] = len(costs)
            report["completed_rows"] = len(rows)
            write_outputs(folder, rows, report)
    return 0 if rows and all(r["success"] for r in rows) else 1


def main():
    p = parser()
    args = p.parse_args()
    if args.requests < 1 or args.max_tokens < 1 or args.context_chars < 0 or any(c < 1 for c in args.concurrency):
        p.error("请求数、max-tokens、并发数必须为正整数，context-chars 不能为负数")
    if len(set(args.concurrency)) != len(args.concurrency):
        p.error("并发档位不能重复")
    for value in [args.timeout, args.cache_wait, args.input_price, args.cache_price, args.output_price]:
        if value is not None and (not math.isfinite(value) or value < 0):
            p.error("时间与价格必须是有限的非负数")
    if args.timeout == 0:
        p.error("timeout 必须大于 0")
    prices = [args.input_price, args.cache_price, args.output_price]
    if any(v is not None for v in prices) and not all(v is not None for v in prices):
        p.error("费用计算需要同时填写 input-price、cache-price、output-price")
    url = urlsplit(args.base_url)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        p.error("base-url 必须为无账号、密码、查询参数的 HTTP(S) API 基础地址")
    if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
        p.error("远程 API 必须使用 HTTPS")
    try:
        if args.prompt_file:
            base = args.prompt_file.read_text(encoding="utf-8-sig")
        else:
            line = "服务记录：系统接收请求，排队处理，生成回答，记录耗时、缓存用量和错误状态。\n"
            context = (line * (args.context_chars // len(line) + 1))[:args.context_chars]
            base = f"请根据以下资料，用中文分条解释 API 性能测试的步骤与注意事项，约 300 字。\n资料：\n{context}"
        if not base.strip():
            p.error("提示词文件不能为空")
    except (OSError, UnicodeError) as exc:
        p.error(f"无法读取 UTF-8 提示词文件：{type(exc).__name__}")
    stages = plan(args)
    count = sum(args.requests + (mode == "repeat") for _, _, mode in stages)
    print(f"模型={args.model} 思考={args.thinking} 场景={args.scenario} 最多请求={count}")
    print(f"提示词主体={len(base)}字符；每请求输出上限={args.max_tokens} token；实际输入 token 由 API 返回。")
    print("不自动重试；未配置单价时费用留空。")
    for name, concurrency, mode in stages:
        print(f"  {name}: 并发={concurrency}, 测量请求={args.requests}, 前缀={mode}")
    if args.dry_run:
        print("仅预览，未发送请求。")
        return 0
    key = os.environ.get(args.api_key_env, "").strip()
    if not key:
        p.error(f"环境变量 {args.api_key_env} 未设置，请在同一终端设置后运行")
    try:
        return asyncio.run(execute(args, base, stages, key))
    except KeyboardInterrupt:
        print("已中断。已完成请求保留；在途请求可能已计费但没有完整统计。")
        return 130


if __name__ == "__main__":
    sys.exit(main())
