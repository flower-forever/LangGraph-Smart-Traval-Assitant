# -*- coding: utf-8 -*-
"""规划链路（AMapClient）的 HTTP 日志隐私测试。

全程离线：假密钥 + ``httpx.MockTransport``，不访问高德、不读 .env、不发起真实网络请求。

背景：高德 Web 服务把密钥放在 query 参数里，httpx 0.28 每收到一个响应都会在
``httpx`` logger 上打一条 INFO，内容是完整请求 URL（含 ``key=<密钥>``）。只要
有人把 root logger 配成 INFO（FastMCP 1.30 构造时就是这么干的，用户的
``logging.basicConfig(level=INFO)`` 同理），密钥就跟着进 stderr 和日志文件。

这些测试做两件事：

1. 控制组复现泄漏，证明向量真实存在，并且泄漏的是 URL 编码形态。
2. 断言 ``AMapClient`` 走过的成功 / 500 / 传输异常路径都不再有密钥片段出现在
   LogRecord（``getMessage()`` 与 ``args``）或实际写给 stderr 的文本里，同时
   非敏感日志照常输出。
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import traceback
import urllib.parse
from contextlib import contextmanager, redirect_stderr

import httpx

import travel_itinerary
from travel_itinerary import AMapClient, AMapError, harden_httpx_logging

# 合成假密钥，与任何真实 key 无关。
PLAIN_KEY = "FAKE-AMAP-KEY-7c9c0d3f-SECRET"
# 带特殊字符的假密钥：用来覆盖百分号编码 / 加号编码形态。
SPECIAL_KEY = "fake key/with=chars&and?question 中文密钥"

_GEOCODE_OK = {
    "status": "1",
    "info": "OK",
    "geocodes": [
        {
            "formatted_address": "北京市东城区景山前街4号",
            "location": "116.397,39.916",
            "level": "兴趣点",
        }
    ],
}

_GEOCODE_SERVER_ERROR = {"status": "0", "info": "SERVER_ERROR", "infocode": "10004"}


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def run(coro):
    return asyncio.run(coro)


def sensitive_fragments(key: str) -> set[str]:
    """一个密钥在日志里可能出现的各种形态。

    包括原文、百分号编码、表单编码（空格变 ``+``），以及密钥里可读的分段。
    分段很有必要：编码后的 URL 里 ``%2B`` 之类仍然会露出 ``7c9c0d3f`` 这种原文片段。
    """

    fragments = {
        key,
        urllib.parse.quote(key, safe=""),
        urllib.parse.quote_plus(key, safe=""),
    }
    # 分段按非字母数字切开：编码后的 URL 里 %2B / %2F 之类仍会露出 7c9c0d3f
    # 这种可读片段，只比对整串会漏掉。
    for piece in re.split(r"[^0-9A-Za-z]+|_+", key):
        if len(piece) >= 5 or (len(piece) >= 2 and not piece.isascii()):
            fragments.add(piece)
    return {fragment for fragment in fragments if fragment}


def leaked_fragments(text: str, fragments: set[str]) -> list[str]:
    haystack = text.casefold()
    return sorted(fragment for fragment in fragments if fragment.casefold() in haystack)


def assert_no_leak(text: str, fragments: set[str], where: str) -> None:
    leaked = leaked_fragments(text, fragments)
    assert not leaked, f"{where} 里出现假密钥片段：{leaked}\n原文：{text}"


class _Collector(logging.Handler):
    """收集 LogRecord，供逐条检查 ``getMessage()`` / ``args``。"""

    def __init__(self) -> None:
        super().__init__(level=logging.NOTSET)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D102
        self.records.append(record)


@contextmanager
def noisy_logging(level: int = logging.INFO):
    """模拟“别人把 root 配成 INFO + stderr”的进程。

    只在 with 块内生效，退出时把 root / ``httpx`` 的 level、handlers、logging.disable
    全部还原，避免污染其他测试。yield ``(stderr_buffer, records)``。
    """

    root = logging.getLogger()
    httpx_logger = logging.getLogger("httpx")
    saved_root_level = root.level
    saved_root_handlers = list(root.handlers)
    saved_httpx_level = httpx_logger.level
    saved_httpx_propagate = httpx_logger.propagate
    saved_disable = logging.root.manager.disable

    collector = _Collector()
    stderr_buffer = io.StringIO()
    with redirect_stderr(stderr_buffer):
        # 先 redirect 再建 handler：logging.StreamHandler() 默认取当前的 sys.stderr。
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(
            logging.Formatter("%(levelname)s:%(name)s:%(message)s")
        )
        root.handlers = [stream_handler, collector]
        root.setLevel(level)
        logging.disable(logging.NOTSET)
        try:
            yield stderr_buffer, collector.records
        finally:
            root.handlers = saved_root_handlers
            root.setLevel(saved_root_level)
            httpx_logger.setLevel(saved_httpx_level)
            httpx_logger.propagate = saved_httpx_propagate
            logging.disable(saved_disable)


async def call_through_client(handler, action):
    """用 MockTransport 建客户端，走一次 ``action``。"""

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient(PLAIN_KEY, client=http_client)
        return await action(amap)


def scanning_records(records, fragments, where="日志记录"):
    """逐条检查 LogRecord 的格式化结果和原始参数。"""

    for record in records:
        assert_no_leak(record.getMessage(), fragments, f"{where}(getMessage msg={record.msg!r})")
        assert_no_leak(str(record.msg), fragments, f"{where}(msg)")
        assert_no_leak(str(record.args), fragments, f"{where}(args)")


def assert_no_httpx_info(records) -> None:
    offenders = [
        record
        for record in records
        if record.name.startswith("httpx") and record.levelno < logging.WARNING
    ]
    assert not offenders, [
        (record.name, record.levelno, record.getMessage()) for record in offenders
    ]


# --------------------------------------------------------------------------- #
# 控制组：证明泄漏向量真实存在
# --------------------------------------------------------------------------- #
def test_control_bare_httpx_leaks_key_at_info():
    """不经过 AMapClient 的裸 httpx 请求，在 root=INFO 时会把 URL 写进 stderr。

    这是控制组，不是回归目标：如果哪天它不再泄漏（httpx 去掉了 URL 日志），
    说明本文件的防护前提变了，需要重新评估，而不是默默通过。
    """

    fragments = sensitive_fragments(PLAIN_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_GEOCODE_OK)

    async def raw_request() -> None:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            await client.get(
                "https://restapi.amap.com/v3/geocode/geo",
                params={"address": "故宫", "key": PLAIN_KEY},
            )

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)  # 没人加固过
        run(raw_request())
        output = stderr_buffer.getvalue()

    assert "HTTP Request" in output
    assert leaked_fragments(output, fragments), "控制组没有复现出泄漏，防护前提已变"
    assert_any_httpx_info(records)
    # 记录里的 URL 已经过编码，args 里放的是 httpx.URL 对象。
    url_records = [r for r in records if r.name == "httpx" and "HTTP Request" in r.getMessage()]
    assert url_records
    assert any(leaked_fragments(str(r.args), fragments) for r in url_records)


def assert_any_httpx_info(records) -> None:
    assert any(
        record.name == "httpx" and record.levelno == logging.INFO for record in records
    ), [(record.name, record.levelno) for record in records]


def test_control_special_key_leaks_in_encoded_form():
    """特殊字符密钥：日志里出现的是编码形态（空格变 +、/ 变 %2F），原文反而不在。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_GEOCODE_OK)

    async def raw_request() -> None:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            await client.get(
                "https://restapi.amap.com/v3/geocode/geo",
                params={"address": "故宫", "key": SPECIAL_KEY},
            )

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        run(raw_request())
        output = stderr_buffer.getvalue()

    fragments = sensitive_fragments(SPECIAL_KEY)
    assert SPECIAL_KEY not in output
    assert urllib.parse.quote_plus(SPECIAL_KEY, safe="") in output
    assert leaked_fragments(output, fragments)
    assert any(leaked_fragments(str(r.args), fragments) for r in records if r.name == "httpx")


# --------------------------------------------------------------------------- #
# 修复后的行为
# --------------------------------------------------------------------------- #
def test_success_path_keeps_key_out_of_logs_but_keeps_normal_logs():
    fragments = sensitive_fragments(PLAIN_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_GEOCODE_OK)

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        result = run(call_through_client(handler, lambda amap: amap.geocode("故宫", city="北京")))
        # 非敏感日志探针：普通 logger 的 INFO 仍应完整落在 stderr 里。
        travel_itinerary_logger = logging.getLogger("travel_itinerary.test")
        travel_itinerary_logger.info("geocode ok for %s", "故宫")
        output = stderr_buffer.getvalue()
        httpx_level = logging.getLogger("httpx").level

    assert result.formatted_address == "北京市东城区景山前街4号"
    assert httpx_level == logging.WARNING
    assert_no_leak(output, fragments, "stderr 输出")
    scanning_records(records, fragments)
    assert_no_httpx_info(records)
    assert "geocode ok for 故宫" in output
    assert any(r.name == "travel_itinerary.test" for r in records)


def test_http_500_path_keeps_key_out_of_logs():
    fragments = sensitive_fragments(PLAIN_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json=_GEOCODE_SERVER_ERROR)

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        try:
            run(call_through_client(handler, lambda amap: amap.geocode("故宫")))
        except AMapError as exc:
            error = exc
        else:  # pragma: no cover - 500 必须变成 AMapError
            raise AssertionError("500 响应没有抛出 AMapError")
        output = stderr_buffer.getvalue()

    assert error.code == "http_500"
    assert_no_leak(output, fragments, "stderr 输出")
    scanning_records(records, fragments)
    assert_no_httpx_info(records)
    # 异常本身也不该带出密钥（调用方常把 str(exc) 直接回显）。
    assert_no_leak(str(error), fragments, "AMapError 文本")
    assert_no_leak(repr(error), fragments, "AMapError repr")


def test_transport_error_path_keeps_key_out_of_logs():
    fragments = sensitive_fragments(PLAIN_KEY)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("模拟连接失败", request=request)

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        try:
            run(call_through_client(handler, lambda amap: amap.geocode("故宫")))
        except AMapError as exc:
            error = exc
        else:  # pragma: no cover
            raise AssertionError("传输异常没有抛出 AMapError")
        output = stderr_buffer.getvalue()

    assert error.code == "http_error"
    assert_no_leak(output, fragments, "stderr 输出")
    scanning_records(records, fragments)
    assert_no_httpx_info(records)
    cause = error.__cause__
    assert cause is not None
    assert_no_leak(str(cause), fragments, "底层异常文本")
    assert_no_leak(repr(cause), fragments, "底层异常 repr")
    formatted = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    assert_no_leak(formatted, fragments, "完整 traceback")
    # 没有把 request 对象塞进异常参数（httpx 自己会保留在 .request 属性上，见报告）。
    assert "restapi.amap.com" not in str(cause)


def test_special_character_key_encoded_forms_never_logged():
    fragments = sensitive_fragments(SPECIAL_KEY)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=_GEOCODE_OK)

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient(SPECIAL_KEY, client=http_client)
            return await amap.geocode("故宫")

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        run(action())
        output = stderr_buffer.getvalue()

    # 请求确实带着密钥发出去了（功能没变），只是没进日志。
    assert leaked_fragments(seen["url"], fragments)
    assert_no_leak(output, fragments, "stderr 输出")
    scanning_records(records, fragments)
    assert_no_httpx_info(records)


def test_runtime_reconfiguration_back_to_info_still_does_not_leak():
    """运行期有人把 httpx 调回 INFO：下一次请求前会重新压回 WARNING。"""

    fragments = sensitive_fragments(PLAIN_KEY)
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(200, json=_GEOCODE_OK)

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient(PLAIN_KEY, client=http_client)
            first = await amap.geocode("故宫")
            logging.getLogger("httpx").setLevel(logging.INFO)  # 有人重新打开 INFO
            second = await amap.geocode("天安门")
            return first, second

    with noisy_logging() as (stderr_buffer, records):
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        run(action())
        output = stderr_buffer.getvalue()

    assert calls["count"] == 2
    assert_no_leak(output, fragments, "stderr 输出")
    scanning_records(records, fragments)
    assert_no_httpx_info(records)


def test_harden_httpx_logging_is_idempotent_and_only_raises_level():
    httpx_logger = logging.getLogger("httpx")
    saved = httpx_logger.level
    try:
        httpx_logger.setLevel(logging.NOTSET)
        harden_httpx_logging()
        assert httpx_logger.level == logging.WARNING
        harden_httpx_logging()
        assert httpx_logger.level == logging.WARNING

        # 比自己更严格的等级要保持原样，不能被“降级”回 WARNING。
        httpx_logger.setLevel(logging.ERROR)
        harden_httpx_logging()
        assert httpx_logger.level == logging.ERROR

        # 被人重新打开成 DEBUG 时再次压回去。
        httpx_logger.setLevel(logging.DEBUG)
        harden_httpx_logging()
        assert httpx_logger.level == logging.WARNING
    finally:
        httpx_logger.setLevel(saved)


def test_handler_attached_directly_to_httpx_logger_sees_nothing():
    """即使有 handler 直接挂在 ``httpx`` logger 上（跳过 root），也收不到记录。"""

    fragments = sensitive_fragments(PLAIN_KEY)
    collected = io.StringIO()

    class _Sink(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:  # noqa: D102
            collected.write(record.getMessage() + "\n")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_GEOCODE_OK)

    httpx_logger = logging.getLogger("httpx")
    saved_level = httpx_logger.level
    saved_propagate = httpx_logger.propagate
    sink = _Sink()
    httpx_logger.addHandler(sink)
    try:
        with noisy_logging() as (stderr_buffer, records):
            httpx_logger.setLevel(logging.NOTSET)
            httpx_logger.propagate = False
            run(call_through_client(handler, lambda amap: amap.geocode("故宫")))
            output = stderr_buffer.getvalue()
    finally:
        httpx_logger.removeHandler(sink)
        httpx_logger.setLevel(saved_level)
        httpx_logger.propagate = saved_propagate

    assert_no_leak(collected.getvalue(), fragments, "直挂 handler 的输出")
    assert_no_leak(output, fragments, "stderr 输出")
    scanning_records(records, fragments)
    assert_no_httpx_info(records)
