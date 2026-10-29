# -*- coding: utf-8 -*-
"""MCP 双服务（amap_server / weather_server）异常路径凭据脱敏测试。

红线：真实网络异常的 str(e) 可能携带带 key= / appid= 的完整请求 URL 或明文密钥。
本文件用合成假密钥模拟该场景，并断言：任何假密钥 / 含密钥 URL 都不出现在
工具返回、stdout、stderr、pytest 捕获的日志记录里（原样、大小写变体、
URL 编码 / 双重编码形态一并覆盖）。

全部离线：
- PYTHON_DOTENV_DISABLED=1：两个 server 顶部的 load_dotenv() 直接短路，不读用户 .env；
- AMAP_API_KEY / OPENWEATHER_API_KEY 在 import 前注入合成假值；
- httpx.AsyncClient.get 被替换为本地假实现，不产生任何真实网络请求；
- 不导入任何模型 / agents 相关模块。

运行方式（cmd，项目根目录；本文件在 import 前会强制这组环境，命令行设置属于双保险）：
  set "PYTHON_DOTENV_DISABLED=1" & set "AMAP_API_KEY=TESTFAKE..." ^
  & set "OPENWEATHER_API_KEY=TESTFAKE..." ^
  & python -m pytest tests/test_mcp_error_redaction.py -v
"""

import asyncio
import contextlib
import io
import json
import os
import subprocess
import sys
import urllib.parse
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ---- 环境必须在导入被测模块之前固定（load_dotenv 在模块 import 时执行一次）----
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
FAKE_AMAP_KEY = "TESTFAKEAMAPKEY0123456789abcdefgh"
FAKE_OPENWEATHER_KEY = "TESTFAKEOWMKEY0123456789abcdefg"
os.environ["AMAP_API_KEY"] = FAKE_AMAP_KEY
os.environ["OPENWEATHER_API_KEY"] = FAKE_OPENWEATHER_KEY

# 模拟真实网络异常：异常文本自带带密钥的完整请求 URL
AMAP_SECRET_URL = (
    "https://restapi.amap.com/v3/place/text"
    "?keywords=%E6%95%85%E5%AE%AB&key=" + FAKE_AMAP_KEY + "&output=json"
)
OWM_SECRET_URL = (
    "https://api.openweathermap.org/data/2.5/weather"
    "?q=Beijing&appid=" + FAKE_OPENWEATHER_KEY + "&units=metric"
)


class _StdoutShim(io.TextIOBase):
    """amap_server 在 import 时会把 sys.stdout 包进 TextIOWrapper（需要 .buffer），
    这里临时给 pytest 捕获中的 stdout 补一个可用 buffer，导入完成即换回。"""

    def __init__(self, underlying):
        self._underlying = underlying
        self._buffer = io.BytesIO()

    @property
    def buffer(self):
        return self._buffer

    def write(self, data):
        return self._underlying.write(data)


_real_stdout = sys.stdout
try:
    sys.stdout = _StdoutShim(sys.stdout)
    import amap_server  # noqa: E402
finally:
    sys.stdout = _real_stdout

import weather_server  # noqa: E402


# ==================== 基础设施 ====================


def run_tool(factory):
    """同步执行一个 async 工具调用，同时捕获 stdout/stderr。返回 (result, stdout, stderr)。"""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        result = asyncio.run(factory())
    return result, out.getvalue(), err.getvalue()


class _FakeResponse:
    """带 json()/raise_for_status() 的最小假 Response。"""

    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def install_fake_http(monkeypatch, handler):
    """替换 httpx.AsyncClient.get。

    handler(url, params) 的返回值约定：
    - BaseException 实例 → 原样抛出（模拟网络异常，异常文本可故意携带假密钥）；
    - dict → 包成 _FakeResponse（成功载荷）；
    - 其他带 json()/raise_for_status() 的对象 → 原样返回（如表 401 用例）。
    """

    async def fake_get(self, url=None, params=None, timeout=None, **kwargs):
        outcome = handler(url, params)
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, dict):
            return _FakeResponse(outcome)
        return outcome

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)


def assert_no_leak(result, out, err, caplog=None):
    """返回 + 两个标准流 + pytest 日志记录里都不得出现假密钥或含密钥 URL。"""
    blob = str(result) + "\n" + out + "\n" + err
    for secret in (FAKE_AMAP_KEY, FAKE_OPENWEATHER_KEY):
        assert secret not in blob, blob
        assert urllib.parse.quote(secret, safe="") not in blob, blob
    assert "restapi.amap.com" not in blob, "错误返回不应携带原始请求 URL: " + blob
    assert "api.openweathermap.org" not in blob, "错误返回不应携带原始请求 URL: " + blob
    if caplog is not None:
        for record in caplog.records:
            msg = record.getMessage()
            assert FAKE_AMAP_KEY not in msg, msg
            assert FAKE_OPENWEATHER_KEY not in msg, msg
            assert "restapi.amap.com" not in msg, msg


# ==================== amap_server ====================


def ok_geocode_payload():
    return {
        "status": "1",
        "info": "OK",
        "geocodes": [
            {
                "location": "116.397,39.916",
                "formatted_address": "北京市东城区景山前街4号",
                "province": "北京市",
                "city": "北京市",
                "district": "东城区",
            }
        ],
    }


def ok_poi_payload():
    return {
        "status": "1",
        "info": "OK",
        "pois": [
            {
                "name": "故宫博物院",
                "address": "景山前街4号",
                "type": "风景名胜;国家级景点",
                "tel": "010-85007421",
            }
        ],
    }


def test_amap_search_poi_success_output_unchanged(monkeypatch):
    install_fake_http(monkeypatch, lambda url, params: ok_poi_payload())
    result, _, _ = run_tool(lambda: amap_server.search_poi("故宫", city="北京"))
    assert result.startswith("[搜索] 「故宫」在「北京」的结果")
    assert "故宫博物院" in result and "景山前街4号" in result
    assert "[错误]" not in result


def test_amap_geocode_success_output_unchanged(monkeypatch):
    install_fake_http(monkeypatch, lambda url, params: ok_geocode_payload())
    result, _, _ = run_tool(lambda: amap_server.geocode("北京市朝阳区"))
    assert result.startswith("[地址解析结果]")
    assert "116.397,39.916" in result


def test_amap_get_district_success_output_unchanged(monkeypatch):
    install_fake_http(
        monkeypatch,
        lambda url, params: {
            "status": "1",
            "districts": [
                {"name": "朝阳区", "level": "district", "center": "116.4,39.9", "districts": []}
            ],
        },
    )
    result, _, _ = run_tool(lambda: amap_server.get_district("朝阳区"))
    assert "[行政区划] 朝阳区" in result and "区/县" in result


@pytest.mark.parametrize(
    ("tool_name", "kwargs"),
    [
        ("search_poi", {"keywords": "故宫", "city": "北京"}),
        ("geocode", {"address": "北京市朝阳区"}),
        ("reverse_geocode", {"location": "116.481488,39.990464"}),
        ("get_district", {"keywords": "朝阳区"}),
        ("search_around", {"location": "116.481488,39.990464", "keywords": "餐厅"}),
    ],
    ids=["search_poi", "geocode", "reverse_geocode", "get_district", "search_around"],
)
def test_amap_tool_connect_error_fixed_message_no_secrets(tool_name, kwargs, monkeypatch, caplog):
    """五个直连类工具：网络异常必须收敛为固定中文文案，且任何流都不含假密钥/URL。"""
    caplog.set_level("INFO")
    install_fake_http(
        monkeypatch,
        lambda url, params: httpx.ConnectError("connect failed for " + AMAP_SECRET_URL),
    )
    result, out, err = run_tool(lambda: getattr(amap_server, tool_name)(**kwargs))
    assert result.startswith("[错误] 请求失败:"), result
    assert "网络异常或服务暂不可用，请稍后重试" in result, result
    assert "异常类型: ConnectError" in result, result
    assert_no_leak(result, out, err, caplog)


def test_amap_json_parse_error_never_returns_original(monkeypatch):
    """response.json() 抛错：解析异常原文（含响应内容片段）也不得回传。"""

    class BadJSON:
        def json(self):
            raise json.JSONDecodeError("Expecting value: line 1 column 1 (char 0)", "not-json", 0)

    install_fake_http(monkeypatch, lambda url, params: BadJSON())
    result, _, _ = run_tool(lambda: amap_server.search_poi("故宫", city="北京"))
    assert result.startswith("[错误] 请求失败:"), result
    assert "Expecting value" not in result, result
    assert "异常类型: JSONDecodeError" in result, result


def test_amap_business_info_error_preserved(monkeypatch):
    """API 业务错误（info 字段）原样保留，不做无谓改写。"""
    for payload in ({"status": "0", "info": "有效期不足"}, {"status": "0", "info": "INVALID_USER_KEY"}):
        install_fake_http(monkeypatch, lambda url, params: payload)
        result, _, _ = run_tool(lambda: amap_server.search_poi("故宫", city="北京"))
        assert result == "[错误] 查询失败: " + payload["info"], result


def test_amap_geocode_no_result_error_unchanged(monkeypatch):
    install_fake_http(monkeypatch, lambda url, params: {"status": "1", "geocodes": []})
    result, _, _ = run_tool(lambda: amap_server.geocode("不存在的地方xyz"))
    assert result == "[错误] 无法解析地址: 不存在的地方xyz", result


def test_amap_no_key_message_unchanged(monkeypatch):
    monkeypatch.setattr(amap_server, "AMAP_API_KEY", "")
    result, _, _ = run_tool(lambda: amap_server.search_poi("故宫"))
    assert result == "[错误] 未配置 AMAP_API_KEY，请在 .env 文件中添加高德地图 API Key", result


def test_amap_route_driving_degrades_on_geocode_failure(monkeypatch, caplog):
    """路线工具先用 geocode：geocode 报网络错误时，路线工具退回原有「无法解析起点」语义。"""
    caplog.set_level("INFO")
    install_fake_http(
        monkeypatch,
        lambda url, params: httpx.ConnectError("connect failed for " + AMAP_SECRET_URL),
    )
    result, out, err = run_tool(lambda: amap_server.route_driving("北京", "上海"))
    assert result == "[错误] 无法解析起点「北京」的位置", result
    assert_no_leak(result, out, err, caplog)


def test_amap_route_driving_internal_error_no_secrets(monkeypatch, caplog):
    """geocode 正常、_driveing 请求抛带密钥 URL 的异常 → 工具自身 except 收敛为固定文案。"""
    caplog.set_level("INFO")

    def handler(url, params):
        if url.endswith("/geocode/geo"):
            return ok_geocode_payload()
        return httpx.ConnectError("drive failed for " + AMAP_SECRET_URL)

    install_fake_http(monkeypatch, handler)
    result, out, err = run_tool(lambda: amap_server.route_driving("北京朝阳", "上海外滩"))
    assert result.startswith("[错误] 请求失败:"), result
    assert "网络异常或服务暂不可用" in result, result
    assert_no_leak(result, out, err, caplog)


def test_amap_route_transit_internal_error_no_secrets(monkeypatch, caplog):
    caplog.set_level("INFO")

    def handler(url, params):
        if url.endswith("/geocode/geo"):
            return ok_geocode_payload()
        return httpx.ConnectError("transit failed for " + AMAP_SECRET_URL)

    install_fake_http(monkeypatch, handler)
    result, out, err = run_tool(lambda: amap_server.route_transit("王府井", "颐和园", "北京"))
    assert result.startswith("[错误] 请求失败:"), result
    assert "网络异常或服务暂不可用" in result, result
    assert_no_leak(result, out, err, caplog)


# ==================== weather_server ====================

OW_OK = {
    "name": "Beijing",
    "sys": {"country": "CN"},
    "weather": [{"main": "Clouds", "description": "多云"}],
    "main": {"temp": 12.3, "feels_like": 11.0, "humidity": 40},
    "wind": {"speed": 2.5},
}

FORECAST_OK = {
    "city": {"name": "Beijing"},
    "list": [
        {
            "dt": 1730000000 + i * 86400,
            "main": {"temp": 10 + i},
            "weather": [{"description": "晴"}],
        }
        for i in range(24)
    ],
}


def test_weather_query_success_output_unchanged(monkeypatch):
    install_fake_http(monkeypatch, lambda url, params: OW_OK)
    result, _, _ = run_tool(lambda: weather_server.query_weather("北京"))
    assert "Beijing" in result and "多云" in result and "12.3" in result, result
    assert "❌" not in result


def test_weather_format_success_fields_exist():
    result = weather_server.format_weather(OW_OK)
    assert "Beijing, CN" in result and "12.3" in result and "多云" in result


def test_weather_forecast_success_output_unchanged(monkeypatch):
    install_fake_http(monkeypatch, lambda url, params: FORECAST_OK)
    result, _, _ = run_tool(lambda: weather_server.get_weather_forecast("北京", days=3))
    assert "未来 3 天天气预报" in result, result
    assert "Beijing" in result and "11°C" in result and "晴" in result, result


def test_weather_query_connect_error_fixed_message(monkeypatch, caplog):
    caplog.set_level("INFO")
    install_fake_http(
        monkeypatch,
        lambda url, params: httpx.ConnectError("connect failed for " + OWM_SECRET_URL),
    )
    result, out, err = run_tool(lambda: weather_server.query_weather("北京"))
    assert result.startswith("❌ 请求失败: 网络异常或服务暂不可用，请稍后重试"), result
    assert "异常类型: ConnectError" in result, result
    assert_no_leak(result, out, err, caplog)


def test_weather_http_status_error_keeps_status_code_drops_url(monkeypatch, caplog):
    """raise_for_status 抛 HTTPStatusError（原文自带 URL+appid）：沿用「只留状态码」的既有行为。"""
    caplog.set_level("INFO")

    class Err401:
        def raise_for_status(self):
            response = httpx.Response(401, request=httpx.Request("GET", OWM_SECRET_URL))
            response.raise_for_status()  # 抛出 httpx.HTTPStatusError，message 含完整 URL

        def json(self):
            return {}

    install_fake_http(monkeypatch, lambda url, params: Err401())
    result, out, err = run_tool(lambda: weather_server.query_weather("Beijing"))
    assert result == "❌ API 错误: 401", result
    assert_no_leak(result, out, err, caplog)


def test_weather_forecast_generic_error_hides_appid(monkeypatch, caplog):
    """旧代码最大的泄露点：forecast 泛捕获把 HTTPStatusError/ConnectError 原文带回，
    现在必须收敛为固定文案。"""
    caplog.set_level("INFO")
    install_fake_http(
        monkeypatch,
        lambda url, params: httpx.ConnectError("forecast failed for " + OWM_SECRET_URL),
    )
    result, out, err = run_tool(lambda: weather_server.get_weather_forecast("北京", days=3))
    assert result == (
        "❌ 获取预报失败: 网络异常或服务暂不可用，请稍后重试（异常类型: ConnectError）"
    ), result
    assert_no_leak(result, out, err, caplog)


def test_weather_format_error_passthrough_redacted():
    """format_weather 的 error 透传是动态诊断入口，必须经 redact_secrets 兜底。"""
    out = weather_server.format_weather(
        {"error": "诊断信息: appid=" + FAKE_OPENWEATHER_KEY + "&x=1"}
    )
    assert FAKE_OPENWEATHER_KEY not in out, out
    assert out.startswith("❌")


def test_weather_no_key_messages_unchanged(monkeypatch):
    monkeypatch.setattr(weather_server, "OPENWEATHER_API_KEY", "")
    result, _, _ = run_tool(lambda: weather_server.query_weather("北京"))
    assert result == "❌ 未配置 OPENWEATHER_API_KEY", result


# ==================== redact_secrets 单元 ====================

BOTH_REDACT = [amap_server.redact_secrets, weather_server.redact_secrets]
IDS = ["amap", "weather"]


@pytest.mark.parametrize("redact", BOTH_REDACT, ids=IDS)
@pytest.mark.parametrize(
    "name",
    ["key", "KEY", "Key", "kEy", "appid", "APPID", "AppID", "app_id", "app-id",
     "api_key", "API-KEY", "apikey", "token", "TOKEN", "access_token"],
)
def test_redact_case_insensitive_param_names(redact, name):
    """敏感参数名大小写/连字符变体都必须命中——不能只替换一种写法。"""
    secret = "SECRETVAL-" + name + "-7788990011"
    out = redact("https://internal.host/harmless?" + name + "=" + secret + "&city=x")
    assert secret not in out, out
    assert name.lower() in out.lower(), out
    assert "[REDACTED]" in out, out


@pytest.mark.parametrize("redact", BOTH_REDACT, ids=IDS)
@pytest.mark.parametrize(
    "text",
    [
        '{"appid": "TESTFAKEOWMKEY0123456789abcdefg"}',
        '"AppID":"TESTFAKEOWMKEY0123456789abcdefg"',
        "appid: TESTFAKEOWMKEY0123456789abcdefg",
        "  APPID = TESTFAKEOWMKEY0123456789abcdefg",
        'fetch failed {"key":"/x6y7z8/9a0b1c2d3e4f5g6h"}',
    ],
)
def test_redact_json_and_colon_forms(redact, text):
    out = redact(text)
    for secret in ("TESTFAKEOWMKEY0123456789abcdefg", "x6y7z8/9a0b1c2d3e4f5g6h"):
        if secret in text:
            assert secret not in out, out


@pytest.mark.parametrize("redact", BOTH_REDACT, ids=IDS)
def test_redact_percent_encoded_param(redact):
    raw = (
        "https://restapi.amap.com/v3/place/text"
        "?keywords=%E5%8C%97%E4%BA%AC&key%3DTESTFAKEAMAPKEY0123456789abcdefgh"
    )
    out = redact(raw)
    assert "TESTFAKEAMAPKEY0123456789abcdefgh" not in out, out
    assert "北京" in out, out  # 非密钥内容保持可读


@pytest.mark.parametrize("redact", BOTH_REDACT, ids=IDS)
def test_redact_percent_double_encoded_param(redact):
    raw = "err key%253DTESTFAKEAMAPKEY0123456789abcdefgh end"
    out = redact(raw)
    assert "TESTFAKEAMAPKEY0123456789abcdefgh" not in out, out


@pytest.mark.parametrize("redact", BOTH_REDACT, ids=IDS)
def test_redact_plus_encoded_secret_value(redact):
    """'+' 属于取值类字符：必须整体掩盖，不能切到一半留下尾巴。"""
    out = redact("proxy err key=ABC+DEF-SECRETXY&city=x")
    assert "ABC+DEF-SECRETXY" not in out, out
    assert "DEF" not in out, out


@pytest.mark.parametrize("redact", BOTH_REDACT, ids=IDS)
def test_redact_preserves_normal_business_text(redact):
    """非密钥普通文本与既有业务错误串不得误伤。"""
    for text in ("有效期不足", "城市不存在", "INVALID_USER_KEY", "连接超时", "DAILY_QUERY_OVER_LIMIT"):
        assert redact(text) == text, text


def test_redact_masks_bare_configured_key_value(monkeypatch):
    monkeypatch.setattr(amap_server, "AMAP_API_KEY", FAKE_AMAP_KEY)
    out = amap_server.redact_secrets("handshake ref=" + FAKE_AMAP_KEY + " tail")
    assert FAKE_AMAP_KEY not in out, out


def test_redact_masks_configured_key_with_special_chars(monkeypatch):
    special = "K8#abc==9z%41XY"
    monkeypatch.setattr(amap_server, "AMAP_API_KEY", special)
    encoded = urllib.parse.quote(special, safe="")
    out = amap_server.redact_secrets("resp key_ref=" + encoded + "!")
    assert special not in out, out
    assert special not in urllib.parse.unquote_plus(out), out


def test_redact_never_raises_on_weird_input():
    class Ugly:
        def __str__(self):
            raise RuntimeError("转换必坏")

    for redact in BOTH_REDACT:
        for value in (None, 12345, b"plain-bytes-12345", Ugly()):
            result = redact(value)  # 不得抛异常
            assert isinstance(result, str)
        assert redact(Ugly()) == "[REDACTED]"


# ==================== 新增：短密钥 / 特殊字符密钥 / 异常类名白名单 / dotenv 门控 ====================

SHORT_KEY = "Kw9"                            # 长度 < 8 的合成短密钥
FRAG_KEY = "abc#SENSITIVE_TAIL99"            # 含 # 的合成密钥（修复前残留 #SENSITIVE_TAIL99 尾巴）
SPECIAL_KEY = "K8#abc==9z%41XY"              # 含 #、=、% 的复合特殊字符合成密钥


def _leaky_exc_class(prefix: str):
    """动态构造类名携带假密钥的异常类型：类名里的内容不进返回才算通过。"""
    return type(prefix + FAKE_AMAP_KEY, (Exception,), {})


def test_amap_short_key_diagnostic_returns_fixed_generic(monkeypatch, caplog):
    """短密钥（<8 字符）配置下，动态诊断文本必须一律不外发，换为固定通用错误。"""
    caplog.set_level("INFO")
    monkeypatch.setattr(amap_server, "AMAP_API_KEY", SHORT_KEY)
    install_fake_http(
        monkeypatch,
        lambda url, params: {"status": "0", "info": "user ref=" + SHORT_KEY + " over quota"},
    )
    result, out, err = run_tool(lambda: amap_server.search_poi("故宫", city="北京"))
    assert result == "[错误] 查询失败: 请检查配置后重试", result
    assert SHORT_KEY not in result + out + err, (result, out, err)
    assert_no_leak(result, out, err, caplog)


def test_redact_param_anchored_short_key_masked(monkeypatch):
    """短密钥出现在敏感参数名后（锚定形态）仍会被字段级掩码覆盖。"""
    monkeypatch.setattr(amap_server, "AMAP_API_KEY", SHORT_KEY)
    for redact in BOTH_REDACT:
        out = redact("quota key=Kw9&city=x")
        assert "Kw9" not in out, out
        assert out == "quota key=[REDACTED]&city=x", out


@pytest.mark.parametrize(
    ("redact", "mod", "attr"),
    [
        (amap_server.redact_secrets, amap_server, "AMAP_API_KEY"),
        (weather_server.redact_secrets, weather_server, "OPENWEATHER_API_KEY"),
    ],
    ids=["amap", "weather"],
)
def test_redact_special_char_key_no_tail_residue(redact, mod, attr, monkeypatch):
    """含 # 的合成密钥：参数名形态、并接 &、裸值、单层/双层编码都不残留关键片段。"""
    monkeypatch.setattr(mod, attr, FRAG_KEY)
    for text in (
        "info='key=abc#SENSITIVE_TAIL99'",
        "info='key=abc#SENSITIVE_TAIL99&x=1'",
        "记录 abc#SENSITIVE_TAIL99 结束",
        "enc key=abc%23SENSITIVE_TAIL99",
        "dbl key%253Dabc%2523SENSITIVE_TAIL99",
    ):
        out = redact(text)
        assert "SENSITIVE_TAIL99" not in out, (text, out)
        assert "abc#" not in out, (text, out)
        # 脱敏后的解码产物也不得再出现关键片段
        assert "SENSITIVE_TAIL99" not in urllib.parse.unquote_plus(out), (text, out)


def test_weather_special_char_key_diag_no_leak(monkeypatch):
    """weather 诊断路径遇到含 #/=/% 的合成密钥同样整体遮蔽、不残留片段。"""
    monkeypatch.setattr(weather_server, "OPENWEATHER_API_KEY", SPECIAL_KEY)
    encoded = urllib.parse.quote(SPECIAL_KEY, safe="")
    for text in (
        "diag: appid=" + SPECIAL_KEY + "!end",
        "diag: appid=" + SPECIAL_KEY + "&x=1",
        "diag: ref=" + encoded + " done",
        "diag email " + SPECIAL_KEY + " 已记录",
    ):
        out = weather_server.format_weather({"error": text})
        assert SPECIAL_KEY not in out, (text, out)
        assert SPECIAL_KEY not in urllib.parse.unquote_plus(out), (text, out)


def test_amap_special_char_key_keeps_business_info(monkeypatch):
    """配置特殊字符长密钥时，不含密钥的正常业务错误照常透传（不换模板文案）。"""
    monkeypatch.setattr(amap_server, "AMAP_API_KEY", SPECIAL_KEY)
    assert amap_server._api_error_reply("查询失败", "有效期不足") == "[错误] 查询失败: 有效期不足"
    install_fake_http(
        monkeypatch,
        lambda url, params: {"status": "0", "info": "INVALID_USER_KEY"},
    )
    result, _, _ = run_tool(lambda: amap_server.search_poi("故宫"))
    assert result == "[错误] 查询失败: INVALID_USER_KEY", result


def test_amap_dynamic_exception_class_name_never_leaked(monkeypatch, caplog):
    """动态构造的异常类名不得原样回显（白名单机制），收敛为固定文案。"""
    caplog.set_level("INFO")
    forged = _leaky_exc_class("Leaked_")()
    install_fake_http(monkeypatch, lambda url, params: forged)
    result, out, err = run_tool(lambda: amap_server.search_poi("故宫"))
    assert result == "[错误] 请求失败: 网络异常或服务暂不可用，请稍后重试", result
    assert "Leaked_" not in result, result
    assert_no_leak(result, out, err, caplog)


def test_weather_dynamic_exception_class_name_never_leaked(monkeypatch, caplog):
    caplog.set_level("INFO")
    forged = _leaky_exc_class("Wm_")()
    install_fake_http(monkeypatch, lambda url, params: forged)
    result, out, err = run_tool(lambda: weather_server.query_weather("北京"))
    assert result == "❌ 请求失败: 网络异常或服务暂不可用，请稍后重试", result
    assert "Wm_" not in result, result
    assert_no_leak(result, out, err, caplog)


def test_weather_forecast_dynamic_exception_name_never_leaked(monkeypatch, caplog):
    caplog.set_level("INFO")
    forged = _leaky_exc_class("Ghost_")()
    install_fake_http(monkeypatch, lambda url, params: forged)
    result, out, err = run_tool(lambda: weather_server.get_weather_forecast("北京", days=2))
    assert result == "❌ 获取预报失败: 网络异常或服务暂不可用，请稍后重试", result
    assert "Ghost_" not in result, result
    assert_no_leak(result, out, err, caplog)


def test_weather_format_parse_failure_dynamic_exc_name_never_leaked():
    """format_weather 解析失败分支同样不吃白名单外的类名。"""

    class _EvilFormat(dict):
        def get(self, *args, **kwargs):
            raise _leaky_exc_class("Parse_Ghost_")()

    out = weather_server.format_weather(_EvilFormat())
    assert out == "❌ 天气数据解析失败，请稍后重试", out


def test_trusted_exception_type_names_still_annotated():
    """白名单内的标准类型名照常注回，便于排查。"""
    assert "（异常类型: ConnectError）" in amap_server._request_error(httpx.ConnectError("x"))
    assert "（异常类型: ConnectTimeout）" in weather_server._fetch_error(httpx.ConnectTimeout("x"))
    forged_json_err = json.JSONDecodeError("Expecting value", "not-json", 0)
    assert "（异常类型: JSONDecodeError）" in weather_server._forecast_error(forged_json_err)


def _server_import_available() -> bool:
    try:
        import mcp.server.fastmcp  # noqa: F401
        import dotenv  # noqa: F401

        return True
    except Exception:
        return False


@pytest.mark.skipif(
    not _server_import_available(),
    reason="当前解释器无法 import mcp 1.x，跳过 dotenv 门控子进程测试",
)
def test_load_dotenv_gate_honored_by_servers(tmp_path):
    """PYTHON_DOTENV_DISABLED=1 必须真正跳过 load_dotenv（sentinel 不进子进程环境）；
    未设置该变量时 .env 照常加载。sentinel .env 放在系统临时目录，不碰项目内文件。"""
    env_file = tmp_path / ".env"
    env_file.write_text("DOTENV_SENTINEL_9X8Y7Z=1\n", encoding="utf-8")
    import_code = (
        "import os, sys\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"
        "import amap_server\n"
        "print('SENTINEL', 'DOTENV_SENTINEL_9X8Y7Z' in os.environ)\n"
    )
    base_env = {k: v for k, v in os.environ.items() if k != "DOTENV_SENTINEL_9X8Y7Z"}

    def _run(extra_env):
        env = dict(base_env)
        env.pop("PYTHON_DOTENV_DISABLED", None)
        env.update(extra_env)
        return subprocess.run(
            [sys.executable, "-c", import_code],
            env=env,
            cwd=str(tmp_path),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )

    gated = _run({"PYTHON_DOTENV_DISABLED": "1"})
    ungated = _run({})
    assert gated.returncode == 0 and "SENTINEL False" in gated.stdout, (
        gated.returncode, gated.stdout, gated.stderr,
    )
    assert ungated.returncode == 0 and "SENTINEL True" in ungated.stdout, (
        ungated.returncode, ungated.stdout, ungated.stderr,
    )
