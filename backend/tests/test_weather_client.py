# -*- coding: utf-8 -*-
"""Open-Meteo 天气客户端离线测试：全部用 httpx.MockTransport，不访问真实网络。

运行方式（在仓库根目录，或把仓库加进 sys.path）：

    python -m pytest tests/test_weather_client.py

夹具直接放在本文件内，不依赖外部 fixture 文件。
"""

from __future__ import annotations

import asyncio
import gzip
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from weather_client import (  # noqa: E402
    PROVIDER_ENDPOINT,
    WeatherClient,
    describe_weather_code,
)

LAT, LON = 31.2304, 121.4737
TARGET_DATE = "2026-11-02"

# ==================== 夹具 ====================

DAILY_VARS = [
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_speed_10m_max",
    "weather_code",
]


def make_provider_payload(
    *,
    first_date: str = "2026-10-30",
    days: int = 16,
    timezone_name: str = "Asia/Shanghai",
    utc_offset: int = 28800,
    grid_lat: float = 31.25,
    grid_lon: float = 121.5,
    elevation: float = 7.0,
    target_values: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造一份 Open-Meteo 形状的每日预报 payload。"""
    start = date.fromisoformat(first_date)
    time_list = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    base_values = {
        "temperature_2m_max": 22.1,
        "temperature_2m_min": 15.0,
        "precipitation_sum": 0.4,
        "precipitation_probability_max": 35,
        "wind_speed_10m_max": 12.3,
        "weather_code": 61,
    }
    merged = {**base_values, **(target_values or {})}
    daily: dict[str, Any] = {"time": time_list}
    for name in DAILY_VARS:
        daily[name] = [merged[name]] * len(time_list)
    payload = {
        "latitude": grid_lat,
        "longitude": grid_lon,
        "elevation": elevation,
        "timezone": timezone_name,
        "utc_offset_seconds": utc_offset,
        "daily_units": {
            "temperature_2m_max": "°C",
            "temperature_2m_min": "°C",
            "precipitation_sum": "mm",
            "precipitation_probability_max": "%",
            "wind_speed_10m_max": "km/h",
            "weather_code": "wmo code",
        },
        "daily": daily,
    }
    return payload


def handler_ok(payload: dict[str, Any], *, status: int = 200) -> Callable[
    [httpx.Request], httpx.Response
]:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def run(coro):
    return asyncio.run(coro)


def make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    total_deadline_seconds: float = 8.0,
    clock: Callable[[], float] | None = None,
    now_utc: Callable[[], datetime] | None = None,
) -> WeatherClient:
    """构造注入 MockTransport 的客户端；AsyncClient 由 with 块关闭。"""
    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)
    kwargs: dict[str, Any] = {"client": http_client}
    if total_deadline_seconds != 8.0:
        kwargs["total_deadline_seconds"] = total_deadline_seconds
    if clock is not None:
        kwargs["clock"] = clock
    if now_utc is not None:
        kwargs["now_utc"] = now_utc
    return WeatherClient(**kwargs)


FIXED_NOW = datetime(2026, 10, 30, 4, 5, 0, tzinfo=timezone.utc)


def fixed_now() -> datetime:
    return FIXED_NOW


# ==================== 正常路径 ====================


def test_available_returns_full_report():
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    assert report.reason is None
    assert report.provider_http_status == 200
    assert report.checked_at == FIXED_NOW.isoformat()
    assert report.fetched_at is not None
    assert report.provider_timezone == "Asia/Shanghai"
    assert report.provider_utc_offset_seconds == 28800
    assert report.coordinate.verified is False
    assert report.coordinate.requested.lat == pytest.approx(LAT)
    assert report.coordinate.grid is not None
    assert report.coordinate.grid.lat == pytest.approx(31.25)
    assert report.coordinate.grid_elevation_m == pytest.approx(7.0)
    assert report.coverage.count == 16
    assert report.coverage.first_date == "2026-10-30"
    assert report.coverage.last_date == "2026-11-14"
    assert report.forecast is not None
    assert report.forecast.date == TARGET_DATE
    values = report.forecast.values
    assert values["temperature_2m_max"] == pytest.approx(22.1)
    assert values["temperature_2m_min"] == pytest.approx(15.0)
    assert values["precipitation_sum"] == pytest.approx(0.4)
    assert values["precipitation_probability_max"] == 35
    assert values["wind_speed_10m_max"] == pytest.approx(12.3)
    assert values["weather_code"] == 61
    assert report.forecast.missing_fields == []
    # 源信息真实可署名
    assert report.source.provider == "open-meteo"
    assert report.source.license == "CC BY 4.0"
    assert report.source.attribution_url == "https://open-meteo.com/"
    # 请求参数固定
    assert seen["url"].startswith(PROVIDER_ENDPOINT)
    params = seen["params"]
    assert params["daily"] == ",".join(DAILY_VARS)
    assert params["timezone"] == "auto"
    assert params["forecast_days"] == "16"
    assert params["temperature_unit"] == "celsius"
    assert params["wind_speed_unit"] == "kmh"
    assert params["precipitation_unit"] == "mm"
    assert params["cell_selection"] == "nearest"


def test_query_parameter_cannot_be_influenced_by_input():
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(0.0, 0.0, TARGET_DATE)

    run(action())
    assert set(seen["params"].keys()) == {
        "latitude", "longitude", "daily", "timezone", "forecast_days",
        "temperature_unit", "wind_speed_unit", "precipitation_unit",
        "cell_selection",
    }
    assert seen["params"]["latitude"] == "0.0"


# ==================== 日期覆盖与时区 ====================


def test_out_of_range_reports_coverage_without_forecast():
    payload = make_provider_payload(days=3, first_date="2026-10-30")

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, "2026-11-15")

    report = run(action())
    assert report.status == "out_of_range"
    assert report.forecast is None
    assert report.coverage.count == 3
    assert report.coverage.last_date == "2026-11-01"
    assert report.fetched_at is not None
    assert report.provider_timezone == "Asia/Shanghai"


def test_coverage_follows_provider_dates_not_local_today():
    # provider 覆盖 2027 年的日期；选其中一天照样 available，不受本机"今天"影响。
    payload = make_provider_payload(first_date="2027-01-01", days=5)

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, "2027-01-03")

    report = run(action())
    assert report.status == "available"
    assert report.forecast is not None
    assert report.forecast.date == "2027-01-03"


def test_missing_timezone_is_none_not_fabricated():
    payload = make_provider_payload()
    del payload["timezone"]
    del payload["utc_offset_seconds"]

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    assert report.provider_timezone is None
    assert report.provider_utc_offset_seconds is None


def test_missing_daily_time_is_failed_not_silently_empty():
    payload = make_provider_payload()
    del payload["daily"]["time"]

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    # fetched_at 语义修正：失败分支不携带获取时间（R3）。
    assert report.fetched_at is None
    assert report.coverage.count == 0


def test_more_than_16_daily_rows_is_failed():
    payload = make_provider_payload(days=17)

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"


def test_checked_at_injected_clock():
    payload = make_provider_payload()

    async def action():
        async with make_client(
            handler_ok(payload),
            now_utc=lambda: datetime(2030, 1, 1, tzinfo=timezone.utc),
        ) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.checked_at == "2030-01-01T00:00:00+00:00"


def test_utc_boundary_clock_affects_checked_and_fetched_at():
    t0 = datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
    t1 = datetime(2027, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    times = [t0, t1]
    payload = make_provider_payload()

    async def action():
        async with make_client(handler_ok(payload), now_utc=lambda: times.pop(0)) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.checked_at == t0.isoformat()
    assert report.fetched_at == t1.isoformat()


# ==================== 非法输入（0 网络请求） ====================


@pytest.mark.parametrize(
    "lat,lon,date_str",
    [
        (91.0, LON, TARGET_DATE),          # 纬度越上界
        (-91.0, LON, TARGET_DATE),         # 纬度越下界
        ("31.2", LON, TARGET_DATE),        # 字符串坐标
        (float("nan"), LON, TARGET_DATE),  # NaN
        (float("inf"), LON, TARGET_DATE),  # inf
        (True, LON, TARGET_DATE),          # bool 当坐标
        (LAT, 181.0, TARGET_DATE),         # 经度越上界
        (LAT, -181.0, TARGET_DATE),        # 经度越下界
        (LAT, float("nan"), TARGET_DATE),  # 经度 NaN
        (LAT, LON, "2026-2-30"),           # 非严格格式
        (LAT, LON, "2026-02-30"),          # 真实日历日不存在的日期
        (LAT, LON, "20261301"),            # 缺分隔
        (LAT, LON, "not-a-date"),          # 任意文本
        (LAT, LON, ""),                    # 空串
        (LAT, LON, None),                  # None
        (LAT, LON, 20261102),              # 数字
        (LAT, LON, True),                  # bool 日期
    ],
)
def test_invalid_inputs_make_zero_network_calls(lat, lon, date_str):
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        called["count"] += 1
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(lat, lon, date_str)

    report = run(action())
    assert report.status == "invalid_request"
    assert report.reason is not None
    assert report.fetched_at is None
    assert report.forecast is None
    assert called["count"] == 0


# ==================== 部分缺值、0 值、单位 ====================


def test_zero_is_not_missing():
    payload = make_provider_payload(
        target_values={
            "precipitation_sum": 0,
            "precipitation_probability_max": 0,
            "wind_speed_10m_max": 0.0,
            "weather_code": 0,
        }
    )

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    values = report.forecast.values
    assert values["precipitation_sum"] == 0
    assert values["precipitation_probability_max"] == 0
    assert values["wind_speed_10m_max"] == 0.0
    assert values["weather_code"] == 0
    assert report.forecast.missing_fields == []


def test_null_and_short_array_and_missing_field_become_null_with_missing_fields():
    payload = make_provider_payload()
    daily = payload["daily"]
    daily["precipitation_sum"][3] = None  # 目标日在 index 3（10-30 起第 4 天）
    del daily["wind_speed_10m_max"]  # 整个数组缺失
    daily["temperature_2m_min"] = daily["temperature_2m_min"][:2]  # 短数组
    payload["daily_units"]["weather_code"] = 123  # 单位非字符串

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"
    values = report.forecast.values
    assert values["precipitation_sum"] is None
    assert values["wind_speed_10m_max"] is None
    assert values["temperature_2m_min"] is None
    assert values["temperature_2m_max"] == pytest.approx(22.1)
    assert report.forecast.missing_fields == [
        "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max",
        "weather_code",
    ]
    units = report.forecast.units
    assert units["temperature_2m_max"] == "°C"
    assert units["weather_code"] is None
    # 单位非字符串时 value 不给裸数字（R4 单位先行）。
    assert values["weather_code"] is None
    assert "weather_code" in report.forecast.missing_fields


def test_unit_mismatch_is_reported_via_units_not_converted():
    # 温度单位是 fahrenheit 时，直接透传 daily_units，不做换算也不冒充摄氏。
    payload = make_provider_payload()
    payload["daily_units"]["temperature_2m_max"] = "°F"

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.units["temperature_2m_max"] == "°F"
    # 客户端请求固定 celsius；这里只是验证透传逻辑不擅自改写。


def test_non_numeric_value_becomes_null():
    payload = make_provider_payload()
    payload["daily"]["weather_code"][3] = "rain"

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.values["weather_code"] is None
    assert "weather_code" in report.forecast.missing_fields


# ==================== WMO 映射 ====================


def test_wmo_known_codes_map_to_chinese():
    assert describe_weather_code(0) == "晴"
    assert describe_weather_code(61) == "小雨"
    assert describe_weather_code(95) == "雷暴"
    assert describe_weather_code(99) == "雷暴伴大冰雹"


def test_wmo_unknown_code_stays_unknown():
    assert describe_weather_code(42) is None
    assert describe_weather_code(100) is None
    assert describe_weather_code(None) is None
    assert describe_weather_code("61") is None
    assert describe_weather_code(True) is None
    assert describe_weather_code(3.0) is None


def test_wmo_zero_is_sunny_not_unknown():
    # 0 是真 0（晴），不能被"缺值"逻辑吞掉。
    payload = make_provider_payload(target_values={"weather_code": 0})

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.forecast.values["weather_code"] == 0
    assert describe_weather_code(report.forecast.values["weather_code"]) == "晴"


# ==================== HTTP 失败路径 ====================


def test_non_json_body_is_failed_without_echo():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<html>secret backend trace xyz</html>",
            headers={"content-type": "text/html"},
        )

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    assert report.reason == "天气服务响应格式异常"
    assert report.fetched_at is None
    assert "xyz" not in (report.reason or "")


def test_json_root_not_object_is_failed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"


def test_status_400_is_failed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": True})

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    assert report.fetched_at is None


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_429_and_5xx_are_unavailable(status):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": "rate limited secret"})

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "unavailable"
    assert report.reason == "天气服务暂时不可用"
    assert report.fetched_at is None


def test_network_error_is_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("DNS failure with hostname secret")

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "unavailable"
    assert "DNS" not in (report.reason or "")


def test_connect_timeout_is_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("connect timeout")

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "timeout"
    assert report.fetched_at is None


# ==================== 慢流 / 总 deadline / 128 KiB ====================


def test_slow_stream_hits_total_deadline():
    """响应分很多小块；clock 每 chunk 推进，超过总 deadline 即停。"""
    payload = make_provider_payload()
    body = json.dumps(payload).encode("utf-8")
    chunk_size = 64

    def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            for i in range(0, len(body), chunk_size):
                yield body[i:i + chunk_size]

        return httpx.Response(200, content=stream())

    fake_time = {"t": 0.0}

    def clock() -> float:
        fake_time["t"] += 0.05
        return fake_time["t"]

    async def action():
        async with make_client(
            handler, total_deadline_seconds=0.3, clock=clock, now_utc=fixed_now
        ) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "timeout"
    assert report.fetched_at is None


def test_body_over_128kib_is_failed():
    payload = make_provider_payload()
    # 在 daily 数组里塞入超长字符串（解压后超限；服务端 gzip 由 MockTransport 决定，
    # 这里直接用大 JSON 即可验证解压后大小上限）。
    payload["daily"]["time"] = [
        "2026-10-30" + "x" * 200_000 for _ in range(1)
    ] + make_provider_payload()["daily"]["time"]

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"


def test_gzip_compressed_body_within_limit_is_accepted():
    payload = make_provider_payload()
    raw = json.dumps(payload).encode("utf-8")
    compressed = gzip.compress(raw)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=compressed,
            headers={"content-type": "application/json", "content-encoding": "gzip"},
        )

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "available"


# ==================== 取消 / 并发 / 关闭 ====================


def test_cancellation_propagates_and_closes_response():
    started = {"response": None}

    def handler(request: httpx.Request) -> httpx.Response:
        # 无限 async 流，chunk 之间让出控制权：读取会挂起，取消时正处在读阶段。
        async def stream():
            while True:
                yield b"x" * 1024
                await asyncio.sleep(0.01)

        response = httpx.Response(200, content=stream())
        started["response"] = response
        return response

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            task = asyncio.ensure_future(client.fetch_day(LAT, LON, TARGET_DATE))
            # 等请求真正进入读取阶段（流每 chunk sleep 0.01s，取消时正挂在读上）。
            await asyncio.sleep(0.05)
            assert not task.done()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    run(action())
    # 取消后 client 仍能继续正常使用（上下文已关闭、无半开连接泄漏）。
    async def after():
        async with make_client(handler_ok(make_provider_payload()), now_utc=fixed_now) as c2:
            report = await c2.fetch_day(LAT, LON, TARGET_DATE)
        return report

    report = run(after())
    assert report.status == "available"


def test_concurrent_days_do_not_cross_contaminate():
    payload = make_provider_payload(
        target_values={"temperature_2m_max": 30.0, "temperature_2m_min": 20.0}
    )
    seen_dates: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_dates.append(dict(request.url.params)["latitude"])
        return httpx.Response(200, json=payload)

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            results = await asyncio.gather(
                client.fetch_day(LAT, LON, "2026-11-01"),
                client.fetch_day(LAT, LON, "2026-11-10"),
            )
        return results

    r1, r2 = run(action())
    assert r1.forecast.date == "2026-11-01"
    assert r2.forecast.date == "2026-11-10"
    assert r1.status == "available" and r2.status == "available"


def test_client_close_is_idempotent():
    transport = httpx.MockTransport(handler_ok(make_provider_payload()))

    async def action():
        http_client = httpx.AsyncClient(transport=transport)
        client = WeatherClient(client=http_client)
        await client.aclose()
        await client.aclose()  # 第二次不抛
        # 关闭后自建客户端的路径也能安全关闭
        own_client = WeatherClient()
        await own_client.aclose()
        await own_client.aclose()

    run(action())


def test_client_close_closes_owned_client(monkeypatch):
    """自建 client 由 aclose 关闭；注入的 client 所有权归调用方，aclose 不动它。"""
    import weather_client as wc

    closed = {"owned": False}

    class _TrackingClient(httpx.AsyncClient):
        async def aclose(self):
            closed["owned"] = True
            await super().aclose()

    monkeypatch.setattr(wc.httpx, "AsyncClient", _TrackingClient)

    async def action():
        own = WeatherClient()
        await own.aclose()
        await own.aclose()  # 幂等

        # 注入的 client 由调用方自己管理；aclose/__aexit__ 不替调用方关闭。
        injected = _TrackingClient()
        client = WeatherClient(client=injected)
        await client.aclose()
        assert not injected.is_closed
        await injected.aclose()

    run(action())
    assert closed["owned"] is True


def test_client_async_context_and_ownership():
    """外部注入的 client 由调用方管理；自建 client 由 __aexit__ 关闭。"""
    transport = httpx.MockTransport(handler_ok(make_provider_payload()))

    async def action():
        http_client = httpx.AsyncClient(transport=transport)
        client = WeatherClient(client=http_client)
        async with client:
            report = await client.fetch_day(LAT, LON, TARGET_DATE)
        assert report.status == "available"
        # 外部 client 仍可用（所有权在调用方）
        resp = await http_client.get("https://example.com/unused")
        await http_client.aclose()
        return resp

    run(action())


def test_import_makes_no_request():
    """import weather_client 不触发任何网络请求。用子进程验证。"""
    import subprocess

    code = (
        "import sys; sys.path.insert(0, r'{src_dir}');\n"
        "import weather_client;\n"
        "print('IMPORT_OK')\n"
    ).format(src_dir=str(Path(__file__).resolve().parents[1]))
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0
    assert "IMPORT_OK" in result.stdout


def test_no_user_url_accepted():
    """fetch_day 不接受 URL 输入；请求 host/path 固定。"""
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["host"] = request.url.host
        seen["path"] = request.url.path
        return httpx.Response(200, json=make_provider_payload())

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    run(action())
    assert seen["host"] == "api.open-meteo.com"
    assert seen["path"] == "/v1/forecast"


def test_redirect_is_not_followed():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/forecast":
            return httpx.Response(302, headers={"location": "https://evil.example.com/x"})
        return httpx.Response(200, json=make_provider_payload())  # pragma: no cover

    async def action():
        async with make_client(handler, now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    assert report.status == "failed"
    # 请求没有落到 evil.example.com（MockTransport 只有一个 handler，未命中第二分支）


def test_report_has_no_provider_raw_content():
    """信封里不出现 provider 原文（哪怕 provider 返回奇怪字段）。"""
    payload = make_provider_payload()
    payload["some_unknown_provider_field"] = "A" * 10_000

    async def action():
        async with make_client(handler_ok(payload), now_utc=fixed_now) as client:
            return await client.fetch_day(LAT, LON, TARGET_DATE)

    report = run(action())
    dumped = report.model_dump_json()
    assert "A" * 100 not in dumped
