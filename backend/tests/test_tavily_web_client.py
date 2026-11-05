# -*- coding: utf-8 -*-
"""Tavily 网页资料搜索客户端离线测试：全部 httpx.MockTransport，不访问真实网络。

运行方式（在仓库根目录）：

    python -m pytest tests/test_tavily_web_client.py

本批次业务外网预算为 0：包括 Tavily 本身，任何误触真实网络都是红灯。
夹具直接放在本文件内。覆盖：

0. 模块级 autouse 守卫：真实 httpx transport 在任何 DNS/HTTP 出站前直接
   AssertionError；漏绑 MockTransport 的自建/注入 client 同样被拦
1. 请求契约：单次 POST 固定官方 endpoint、Bearer header、固定 body 六字段、
   Key 绝不进 URL/query；一次 search 只有一次 upstream 尝试
2. available 信封：requested_query 回显全等、checked_at/fetched_at 语义、
   snippet 截断标注、超长 title 置 null 保留条目、score/raw_content 不透出
3. no_results（上游真空数组）/ no_usable_results（有条目但全被 URL 策略拒绝）
4. invalid_request：trim 后 0 码点 / 301 码点 / 非 str / 孤立代理码点，
   全部 0 请求；300 码点（含 astral 码点）合法，合法代理对解码的 emoji 合法
5. no_key：Key 缺失 0 请求
6. 失败状态矩阵：429/432 rate_limited、401/403 unauthorized、5xx 与网络错误
   unavailable、总 deadline timeout、重定向/坏 JSON/超 256KiB/缺 results failed
7. publication_date 归一化：ISO 日期、RFC1123、缺失、垃圾 → None，不用当前时间
8. URL 安全矩阵：userinfo/IP 字面量/十六进制与八进制别名/localhost 及本地
   后缀/单 label/非字母末 label/非 443 端口/控制空白/非 ASCII host 拒绝；
   标准 https 域名、443 端口、punycode、Unicode path 接受
9. 条目上限：results_seen 如实记录、超请求 max_results 截断有说明、结构坏条目
   不计入可用结果
10. 并发请求 provider_http_status 请求局部隔离
11. CancelledError 原样上抛；owned/injected client 关闭所有权
12. 日志与异常文案不含 Key、不含上游响应原文
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tavily_web_client import (  # noqa: E402
    PROVIDER_DOCS_URL,
    PROVIDER_ENDPOINT,
    TavilyWebClient,
    is_shareable_https_url,
    normalize_search_query,
)


# ==================== punycode A-label 校验（本批回归） ====================
#
# 缺陷：_is_dns_label/_last_label_has_alpha_tld 只查 ASCII 形状，不验证
# ``xn--`` label 的 punycode payload 可解码。无效 A-label（如 xn--a）被
# 后端放行，而浏览器 WHATWG URL 解析拒绝，导致前端整包折算 bad_payload、
# 同批合法结果一并丢失。修复后：所有 xn-- label 必须 punycode 可解码；
# 保守差异（IDNA2003 拒、UTS46 收，如 xn--zca/ß）按拒绝处理并已在
# docs/TAVILY_WEB_SOURCES.md 声明，不宣称 WHATWG 等价。

FAKE_KEY = "tvly-fake-key-for-tests"

FIXED_NOW = datetime(2026, 11, 3, 8, 0, 0, tzinfo=timezone.utc)


def fixed_now() -> datetime:
    return FIXED_NOW


# ==================== 0. 真实网络出站守卫（autouse） ====================
#
# 与 test_poi_sources_client.py 同一口径：任何真实 httpx transport 在
# handle_async_request / handle_request 入口立即 AssertionError。MockTransport
# 是独立 transport 类，不经过这两个方法，完全不受影响。


@pytest.fixture(autouse=True)
def _block_real_network(monkeypatch):
    def _refuse_async(self, request):
        raise AssertionError(
            "测试试图通过真实 AsyncHTTPTransport 出站（异步路径）："
            f"{request.method} {request.url.host} —— 本模块只允许 MockTransport"
        )

    def _refuse_sync(self, request):
        raise AssertionError(
            "测试试图通过真实 HTTPTransport 出站（同步路径）："
            f"{request.method} {request.url.host} —— 本模块只允许 MockTransport"
        )

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", _refuse_async
    )
    monkeypatch.setattr(
        httpx.HTTPTransport, "handle_request", _refuse_sync
    )
    yield


def test_guard_blocks_async_transport_entrypoint() -> None:
    request = httpx.Request("GET", "https://api.tavily.com/search")
    with pytest.raises(AssertionError, match="AsyncHTTPTransport"):
        httpx.AsyncHTTPTransport.handle_async_request(object(), request)


def test_guard_blocks_sync_transport_entrypoint() -> None:
    request = httpx.Request("GET", "https://api.tavily.com/search")
    with pytest.raises(AssertionError, match="HTTPTransport"):
        httpx.HTTPTransport.handle_request(object(), request)


# ==================== 夹具 ====================


class Recorder:
    """记录 upstream 请求次数与最后一次请求，用于 0 请求/单次尝试断言。"""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response]):
        self.calls = 0
        self.requests: list[httpx.Request] = []
        self.responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        self.requests.append(request)
        return self.responder(request)


def make_client(
    recorder: Recorder | None = None,
    *,
    api_key: str | None = FAKE_KEY,
    **kwargs: Any,
) -> tuple[TavilyWebClient, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(recorder or (lambda request: httpx.Response(200)))
    )
    client = TavilyWebClient(api_key=api_key, client=http_client, **kwargs)
    return client, http_client


def ok_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "query": "西湖 旅游",
        "results": [
            {
                "title": "杭州西湖旅游攻略",
                "url": "https://www.example-travel.com/xihu-guide",
                "content": "西湖位于杭州市西湖区，是著名风景名胜区。" * 5,
                "published_date": "2025-06-01",
                "score": 0.91,
                "raw_content": "不应该透出的原文全文",
            }
        ],
        "response_time": 1.2,
        "request_id": "req-should-not-leak",
    }
    payload.update(overrides)
    return payload


def json_responder(payload: Any, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# ==================== 1. 请求契约 ====================


def test_search_sends_one_post_with_official_contract() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("  西湖 旅游  "))
        assert report.status == "available"
        assert recorder.calls == 1
        request = recorder.requests[0]
        assert request.method == "POST"
        assert str(request.url) == PROVIDER_ENDPOINT
        assert request.headers["authorization"] == f"Bearer {FAKE_KEY}"
        body = json.loads(request.content)
        assert body == {
            "query": "西湖 旅游",
            "search_depth": "basic",
            "max_results": 3,
            "include_answer": False,
            "include_raw_content": False,
            "include_published_date": True,
        }
        # Key 绝不进 URL / query 串。
        assert FAKE_KEY not in str(request.url)
        assert not request.url.params
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_search_reports_max_results_from_constructor() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder, max_results=5)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        assert report.max_results == 5
        body = json.loads(recorder.requests[0].content)
        assert body["max_results"] == 5
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_constructor_rejects_out_of_range_max_results() -> None:
    with pytest.raises(ValueError):
        TavilyWebClient(api_key=FAKE_KEY, max_results=0)
    with pytest.raises(ValueError):
        TavilyWebClient(api_key=FAKE_KEY, max_results=6)
    with pytest.raises(TypeError):
        TavilyWebClient(api_key=FAKE_KEY, max_results=True)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        TavilyWebClient(api_key=FAKE_KEY, total_deadline_seconds=0)
    with pytest.raises(TypeError):
        TavilyWebClient(api_key=FAKE_KEY, clock=None)  # type: ignore[arg-type]


# ==================== 2. available 信封 ====================


def test_available_envelope_fields_and_unverified_content() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖 旅游"))
        assert report.status == "available"
        assert report.requested_query == "西湖 旅游"
        assert report.provider_http_status == 200
        assert report.checked_at is not None
        assert report.fetched_at is not None
        assert report.reason is None
        assert report.results_seen == 1
        assert report.content_status == "unverified"
        assert report.source.provider == "tavily"
        assert report.source.endpoint == PROVIDER_ENDPOINT
        assert report.source.docs_url == PROVIDER_DOCS_URL
        result = report.results[0]
        assert result.title == "杭州西湖旅游攻略"
        assert result.url == "https://www.example-travel.com/xihu-guide"
        assert result.snippet is not None and result.snippet != ""
        assert result.snippet_truncated is False
        assert result.publication_date == "2025-06-01"
        dumped = json.dumps(report.model_dump(mode="json"), ensure_ascii=False)
        assert "score" not in dumped
        assert "raw_content" not in dumped
        assert "不应透出的原文全文" not in dumped
        assert FAKE_KEY not in dumped
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_snippet_truncation_marks_flag_beyond_500_codepoints() -> None:
    long_snippet = "西" * 600
    payload = ok_payload(
        results=[
            {
                "title": "长摘要条目",
                "url": "https://www.example-travel.com/long",
                "content": long_snippet,
            }
        ]
    )
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        result = report.results[0]
        assert result.snippet is not None
        assert len(result.snippet) == 500
        assert result.snippet_truncated is True
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_overlong_title_becomes_null_but_entry_is_kept() -> None:
    payload = ok_payload(
        results=[
            {
                "title": "标" * 301,
                "url": "https://www.example-travel.com/long-title",
                "content": "正文摘要",
            }
        ]
    )
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        assert report.results[0].title is None
        assert report.results[0].url == "https://www.example-travel.com/long-title"
        assert any("标题过长" in note for note in report.notes)
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 3. no_results / no_usable_results ====================


def test_empty_results_is_no_results_with_fetched_at() -> None:
    recorder = Recorder(json_responder(ok_payload(results=[])))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("不存在的查询组合"))
        assert report.status == "no_results"
        assert report.results == []
        assert report.results_seen == 0
        assert report.fetched_at is not None
        assert report.provider_http_status == 200
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_all_entries_rejected_by_url_policy_is_no_usable_results() -> None:
    payload = ok_payload(
        results=[
            {"title": "A", "url": "http://www.example.com/a", "content": "x"},
            {"title": "B", "url": "https://user@example.com/b", "content": "y"},
            {"title": "C", "url": "https://localhost/c", "content": "z"},
        ]
    )
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "no_usable_results"
        assert report.results == []
        assert report.results_seen == 3
        assert report.fetched_at is not None
        assert any("无法安全展示" in note for note in report.notes)
        assert any("3 条" in note for note in report.notes)
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_malformed_entries_are_not_silent_available() -> None:
    payload = ok_payload(results=["not-a-dict", 42, None])
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "no_usable_results"
        assert report.results_seen == 3
        assert report.results == []
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 4. invalid_request（0 请求） ====================


@pytest.mark.parametrize(
    "bad_query",
    ["", "    ", 123, None, "西" * 301, "\ud800abc", "abc\udfff"],
)
def test_invalid_query_returns_invalid_request_without_request(
    bad_query: Any,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search(bad_query))
        assert report.status == "invalid_request"
        assert report.requested_query is None
        assert recorder.calls == 0
        assert report.provider_http_status is None
        assert report.fetched_at is None
        # invalid_request 信封自身也必须可编码为 UTF-8（不得回显孤立代理）。
        dumped = json.dumps(report.model_dump(mode="json"), ensure_ascii=False)
        dumped.encode("utf-8")
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_query_boundary_300_codepoints_including_astral() -> None:
    query = "🚀" * 300  # 每个 emoji 是 1 个 Python 码点、2 个 UTF-16 units
    assert len(query) == 300
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search(query))
        assert report.status == "available"
        assert report.requested_query == query
        body = json.loads(recorder.requests[0].content)
        assert body["query"] == query
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_normalize_search_query_trims_and_counts_codepoints() -> None:
    assert normalize_search_query("  西湖 \n") == "西湖"
    assert normalize_search_query("🚀" * 300) == "🚀" * 300
    assert normalize_search_query("🚀" * 301) is None
    assert normalize_search_query(None) is None  # type: ignore[arg-type]
    assert normalize_search_query(0.5) is None  # type: ignore[arg-type]


def test_normalize_search_query_rejects_lone_surrogates_but_keeps_real_emoji() -> None:
    # 合法 JSON 代理对（\uD83D\uDE80）解码为单个 astral emoji，必须继续合法。
    paired = json.loads('"\\ud83d\\ude80"')
    assert paired == "🚀"
    assert normalize_search_query(paired) == paired
    # Python 里两个未配对的代理码点仍是孤立代理，必须拒绝。
    assert normalize_search_query("\ud83d\ude80") is None
    assert normalize_search_query("\ud800abc") is None
    assert normalize_search_query("abc\udfff") is None
    # 正常 BMP + astral 混合不受影响。
    assert normalize_search_query("西湖 🚀") == "西湖 🚀"


# ==================== 5. no_key（0 请求） ====================


@pytest.mark.parametrize("missing_key", [None, ""])
def test_missing_key_returns_no_key_without_request(missing_key: str | None) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder, api_key=missing_key)
    try:
        report = run(client.search("西湖"))
        assert report.status == "no_key"
        assert report.requested_query == "西湖"
        assert recorder.calls == 0
        assert report.provider_http_status is None
        assert report.fetched_at is None
        assert report.results == []
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_whitespace_key_is_treated_as_missing() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder, api_key="   ")
    try:
        report = run(client.search("西湖"))
        assert report.status == "no_key"
        assert recorder.calls == 0
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 6. 失败状态矩阵 ====================


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (429, "rate_limited"),
        (432, "rate_limited"),
        (401, "unauthorized"),
        (403, "unauthorized"),
        (500, "unavailable"),
        (503, "unavailable"),
        (400, "failed"),
        (404, "failed"),
    ],
)
def test_http_status_mapping(status: int, expected: str) -> None:
    recorder = Recorder(json_responder({"detail": {"error": "上游错误原文不应回显"}}, status))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == expected
        assert report.provider_http_status == status
        assert report.fetched_at is None
        assert report.results == []
        assert report.requested_query == "西湖"
        dumped = json.dumps(report.model_dump(mode="json"), ensure_ascii=False)
        assert "上游错误原文不应回显" not in dumped
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_network_error_is_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    recorder = Recorder(handler)
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "unavailable"
        assert report.provider_http_status is None
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_total_deadline_is_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        time_sleep = asyncio.sleep
        future = asyncio.get_event_loop().create_future()
        loop = asyncio.get_event_loop()
        loop.create_task(_sleep_then_respond(future))
        return httpx.Response(200, json=ok_payload())  # pragma: no cover

    async def _sleep_then_respond(future: Any) -> None:
        await asyncio.sleep(5)

    async def slow_handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json=ok_payload())  # pragma: no cover

    recorder = Recorder(slow_handler)
    client, http_client = make_client(
        recorder, total_deadline_seconds=0.05
    )
    try:
        report = run(client.search("西湖"))
        assert report.status == "timeout"
        assert report.provider_http_status is None
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_redirect_is_failed() -> None:
    recorder = Recorder(
        lambda request: httpx.Response(
            302, headers={"Location": "https://evil.example/search"}
        )
    )
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "failed"
        assert report.provider_http_status == 302
    finally:
        run(client.aclose())
        run(http_client.aclose())


@pytest.mark.parametrize(
    "payload",
    [
        "not json at all",
        [1, 2, 3],
        {"no_results_key": True},
        {"results": "not-a-list"},
    ],
)
def test_bad_structure_is_failed_without_fetched_at(payload: Any) -> None:
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "failed"
        assert report.fetched_at is None
        assert report.provider_http_status == 200
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_oversized_body_is_failed() -> None:
    big = b"x" * (256 * 1024 + 1)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=big)

    recorder = Recorder(handler)
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "failed"
        assert report.provider_http_status == 200
    finally:
        run(client.aclose())
        run(http_client.aclose())


def _raw_payload_with_bad_field(field: str, marker: str = "UPSTREAM_SECRET") -> bytes:
    """构造含孤立代理转义的合法 ASCII JSON（json.loads 会解码出 \\uD800）。"""

    entry: dict[str, str] = {
        "title": "正常标题",
        "url": "https://www.example-travel.com/bad",
        "content": "正常摘要",
        "published_date": "2025-01-01",
    }
    entry[field] = f"__{marker}__"
    text = json.dumps({"results": [entry]}, ensure_ascii=True)
    text = text.replace(f"__{marker}__", "\\ud800" + marker)
    return text.encode("ascii")


@pytest.mark.parametrize("field", ["title", "content", "published_date"])
def test_upstream_lone_surrogate_field_is_failed_and_encodable(field: str) -> None:
    raw = _raw_payload_with_bad_field(field)
    recorder = Recorder(lambda request: httpx.Response(200, content=raw))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "failed"
        assert report.fetched_at is None
        assert report.provider_http_status == 200
        assert report.results == []
        assert recorder.calls == 1
        dumped = json.dumps(report.model_dump(mode="json"), ensure_ascii=False)
        dumped.encode("utf-8")  # 不得因孤立代理再次崩溃
        assert "UPSTREAM_SECRET" not in dumped
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_upstream_lone_surrogate_url_is_dropped_not_failed_or_500() -> None:
    raw = _raw_payload_with_bad_field("url")
    # URL 字段放孤立代理：按不安全链接丢弃，整份报告仍要可编码。
    recorder = Recorder(lambda request: httpx.Response(200, content=raw))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "no_usable_results"
        assert report.fetched_at is not None
        assert report.results == []
        dumped = json.dumps(report.model_dump(mode="json"), ensure_ascii=False)
        dumped.encode("utf-8")
        assert "UPSTREAM_SECRET" not in dumped
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 7. publication_date 归一化 ====================


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2025-06-01", "2025-06-01"),
        ("Tue, 11 Mar 2025 17:00:00 GMT", "2025-03-11"),
        (None, None),
        ("not a date", None),
        ("2025-13-40", None),
        (12345, None),
    ],
)
def test_publication_date_normalization(raw: Any, expected: str | None) -> None:
    report = _single_result_report({"published_date": raw})
    result = report.results[0] if report.results else None
    if report.status == "available":
        assert result is not None
        assert result.publication_date == expected


def test_missing_publication_date_is_not_filled_with_current_time() -> None:
    report = _single_result_report({}, dropped_key="published_date")
    assert report.results[0].publication_date is None


def _single_result_report(
    overrides: dict[str, Any], *, dropped_key: str | None = None
):
    entry: dict[str, Any] = {
        "title": "条目",
        "url": "https://www.example-travel.com/item",
        "content": "摘要",
    }
    entry.update(overrides)
    if dropped_key:
        entry.pop(dropped_key, None)
    recorder = Recorder(json_responder(ok_payload(results=[entry])))
    client, http_client = make_client(recorder)
    try:
        return run(client.search("西湖"))
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 8. URL 安全矩阵 ====================


@pytest.mark.parametrize(
    "url",
    [
        # userinfo
        "https://user@example.com/a",
        "https://user:pass@example.com/a",
        # IP 字面量（v4/v6）
        "https://127.0.0.1/a",
        "https://1.1.1.1/a",
        "https://192.168.1.1/a",
        "https://[::1]/a",
        "https://[2001:db8::1]/a",
        # 整数 / 十六进制 / 八进制别名（末 label 非字母，天然拒绝）
        "https://2130706433/",
        "https://0x7f000001/",
        "https://0177.0.0.1/",
        # 本地域
        "https://localhost/a",
        "https://api.localhost/a",
        "https://service.local/a",
        "https://service.internal/a",
        # 结构不足 / 非法
        "https://example/",
        "https://example.c/",
        "https://example.com1/",
        "https://example.com./a",
        # 端口
        "https://example.com:8443/a",
        "https://example.com:0/a",
        "https://example.com:notaport/a",
        # scheme
        "http://www.example.com/a",
        "ftp://www.example.com/a",
        # 控制字符与空白
        "https://www.example.com/a b",
        " https://www.example.com/a",
        "https://www.example.com/a\n",
        # 孤立代理码点（无法编码为 UTF-8 响应）
        "https://www.example.com/\ud800",
        # 非 ASCII host（首批策略：拒绝并说明）
        "https://例え.jp/a",
        "https://www.西湖.com/a",
        # 超长
        "https://www.example.com/" + "a" * 2048,
    ],
)
def test_unsafe_urls_are_rejected(url: str) -> None:
    assert is_shareable_https_url(url) is False


@pytest.mark.parametrize(
    "url",
    [
        "https://www.example-travel.com/xihu-guide",
        "https://example.com",
        "https://example.travel/path?q=1#frag",
        "https://EXAMPLE.COM/Path",
        "https://www.example.com:443/a",
        "https://xn--e1afmkfd.xn--p1ai/a",
        "https://www.example.com/杭州西湖",
        "https://sub.domain.example.co.uk/a/b/c",
    ],
)
def test_safe_urls_are_accepted(url: str) -> None:
    assert is_shareable_https_url(url) is True


def test_http_results_are_filtered_and_counted() -> None:
    payload = ok_payload(
        results=[
            {"title": "安全", "url": "https://www.example-travel.com/ok", "content": "a"},
            {"title": "不安全", "url": "http://www.example-travel.com/no", "content": "b"},
        ]
    )
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        assert report.results_seen == 2
        assert len(report.results) == 1
        assert report.results[0].url == "https://www.example-travel.com/ok"
        assert any("1 条" in note for note in report.notes)
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 8b. 无效 punycode A-label（本批回归） ====================


@pytest.mark.parametrize(
    "url",
    [
        # TLD 位坏 A-label（HANDOFF 原例）
        "https://example.xn--a/a",
        # 大写前缀（host.lower() 后同样必须拒绝）
        "https://example.XN--a/a",
        # 首 label 坏
        "https://xn--a.example.org/x",
        # 好/坏 label 混在同一 host（xn--p1ai 本身合法）
        "https://xn--p1ai.xn--a.example.com/x",
        # 两个坏 label
        "https://xn--a.xn--b.example.com/x",
        # 尾连字符 / 空 payload（语法即坏，防回归）
        "https://xn--.example.com/a",
        "https://example.xn--abc-/a",
        # 保守差异样本：ß(xn--zca) 在 UTS46 nontransitional 可解码，
        # 但 stdlib IDNA2003 拒绝——按项目保守策略拒绝，不宣称 WHATWG 等价。
        "https://xn--zca.example.com/a",
    ],
)
def test_invalid_punycode_a_labels_are_rejected(url: str) -> None:
    assert is_shareable_https_url(url) is False


@pytest.mark.parametrize(
    "url",
    [
        "https://example.xn--p1ai/a",
        "https://xn--80ak6aa92e.com/a",
        "https://www.example.xn--fiqs8s/a",
        "https://xn--e1afmkfd.xn--p1ai/a",
        "https://xn--bcher-kva.example.com/a",
        "https://EXAMPLE.XN--P1AI/a",
    ],
)
def test_valid_punycode_a_labels_are_still_accepted(url: str) -> None:
    assert is_shareable_https_url(url) is True


def test_all_invalid_punycode_batch_is_no_usable_results() -> None:
    payload = ok_payload(
        results=[
            {"title": "A", "url": "https://example.xn--a/a", "content": "x"},
            {"title": "B", "url": "https://xn--a.example.org/b", "content": "y"},
            {"title": "C", "url": "https://xn--p1ai.xn--a.example.com/c", "content": "z"},
        ]
    )
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "no_usable_results"
        assert report.results == []
        assert report.results_seen == 3
        assert report.fetched_at is not None
        assert any("无法安全展示" in note for note in report.notes)
        assert any("3 条" in note for note in report.notes)
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_mixed_valid_and_invalid_punycode_batch_keeps_valid_results() -> None:
    payload = ok_payload(
        results=[
            {"title": "好一", "url": "https://www.example.com/ok-1", "content": "a"},
            {"title": "坏", "url": "https://example.xn--a/bad", "content": "b"},
            {"title": "好二", "url": "https://www.example.org/ok-2", "content": "c"},
        ]
    )
    recorder = Recorder(json_responder(payload))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        assert report.results_seen == 3
        kept = [r.url for r in report.results]
        assert kept == [
            "https://www.example.com/ok-1",
            "https://www.example.org/ok-2",
        ]
        assert any("1 条结果链接未通过安全检查" in note for note in report.notes)
        # 前端复验口径：修后放行的每条 URL 必须能通过 WHATWG 语义下的
        # 同形状检查（浏览器 new URL 不再拒绝），不再触发整包 bad_payload。
        assert all(is_shareable_https_url(u) for u in kept)
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 9. 条目上限 ====================


def test_results_capped_at_requested_max_with_note() -> None:
    entries = [
        {
            "title": f"条目{i}",
            "url": f"https://www.example-travel.com/p{i}",
            "content": "摘要",
        }
        for i in range(8)
    ]
    recorder = Recorder(json_responder(ok_payload(results=entries)))
    client, http_client = make_client(recorder, max_results=3)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        assert report.results_seen == 8
        assert len(report.results) == 3
        assert report.results[0].url == "https://www.example-travel.com/p0"
        assert any("仅保留前 3 条" in note for note in report.notes)
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_oversized_results_list_is_bounded_before_projection() -> None:
    entries = [
        {
            "title": f"条目{i}",
            "url": f"https://www.example-travel.com/p{i}",
            "content": "x" * 600,
        }
        for i in range(30)
    ]
    recorder = Recorder(json_responder(ok_payload(results=entries)))
    client, http_client = make_client(recorder, max_results=5)
    try:
        report = run(client.search("西湖"))
        assert report.status == "available"
        assert report.results_seen == 30
        assert len(report.results) == 5
        assert any("仅处理前" in note for note in report.notes)
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 10. 并发隔离 ====================


def test_concurrent_requests_do_not_cross_provider_http_status() -> None:
    state = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["count"] += 1
        if state["count"] == 1:
            return httpx.Response(429, json={"detail": {"error": "rate"}})
        return httpx.Response(200, json=ok_payload())

    recorder = Recorder(handler)
    client, http_client = make_client(recorder)
    try:
        async def scenario() -> tuple[Any, Any]:
            return await asyncio.gather(
                client.search("查询一"), client.search("查询二")
            )

        first, second = run(scenario())
        assert first.status == "rate_limited"
        assert first.provider_http_status == 429
        assert second.status == "available"
        assert second.provider_http_status == 200
    finally:
        run(client.aclose())
        run(http_client.aclose())


# ==================== 11. 取消与所有权 ====================


def test_cancelled_error_propagates() -> None:
    async def slow_handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(200, json=ok_payload())  # pragma: no cover

    recorder = Recorder(slow_handler)
    client, http_client = make_client(recorder, total_deadline_seconds=60)

    async def scenario() -> None:
        task = asyncio.ensure_future(client.search("西湖"))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    try:
        run(scenario())
    finally:
        run(client.aclose())
        run(http_client.aclose())


def test_owned_client_close_is_idempotent() -> None:
    async def scenario() -> None:
        async with TavilyWebClient(api_key=FAKE_KEY) as client:
            assert client._closed is False
        assert client._closed is True
        await client.aclose()  # 幂等：重复关闭无副作用

    run(scenario())


def test_injected_client_is_not_closed_by_wrapper() -> None:
    async def scenario() -> None:
        recorder = Recorder(json_responder(ok_payload()))
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
        client = TavilyWebClient(api_key=FAKE_KEY, client=http_client)
        await client.aclose()
        assert http_client.is_closed is False
        await http_client.aclose()
        assert http_client.is_closed is True

    run(scenario())


def test_search_after_close_raises_runtime_error() -> None:
    async def scenario() -> None:
        client, http_client = make_client()
        await client.aclose()
        with pytest.raises(RuntimeError):
            await client.search("西湖")

    run(scenario())


# ==================== 12. 日志与文案卫生 ====================


def test_no_reason_echoes_upstream_or_key(caplog: pytest.LogCaptureFixture) -> None:
    recorder = Recorder(json_responder({"detail": {"error": "机密上游错误详情"}}, 429))
    client, http_client = make_client(recorder)
    try:
        import logging

        with caplog.at_level(logging.DEBUG):
            report = run(client.search("西湖"))
        assert report.status == "rate_limited"
        combined = json.dumps(report.model_dump(mode="json"), ensure_ascii=False)
        combined += "".join(record.getMessage() for record in caplog.records)
        assert FAKE_KEY not in combined
        assert "机密上游错误详情" not in combined
        assert "reason 固定" not in combined
    finally:
        run(client.aclose())
        run(http_client.aclose())
