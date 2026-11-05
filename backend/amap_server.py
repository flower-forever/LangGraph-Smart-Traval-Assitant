# -*- coding: utf-8 -*-
"""
高德地图 MCP 服务器
提供路线规划、POI搜索、地理编码等功能
"""
import os
import sys
import io
import logging
import re
import httpx
from urllib.parse import quote, unquote_plus
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

# 设置输出编码
if sys.stdout:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# 测试环境（PYTHON_DOTENV_DISABLED=1）不读取真实 .env，保证测试进程不加载用户凭据；
# 正常运行未设置该变量时行为不变。
if not os.environ.get("PYTHON_DOTENV_DISABLED"):
    load_dotenv()

# 高德地图 API 配置
AMAP_API_KEY = os.getenv("AMAP_API_KEY", "")
AMAP_BASE_URL = "https://restapi.amap.com/v3"

# ==================== 凭据信息安全 ====================
# 红线：任何异常原文都可能携带带 key=/appid= 的完整 URL 或密钥（httpx 异常、
# 代理配置、SSL 握手错误等），不得进入工具返回或日志。
# 对外异常一律走固定中文描述（_request_error / _api_error_reply），绝不返回 str(e)；
# redact_secrets 只用于确需保留的动态诊断文本（如 API 返回的业务 info 字段）做兜底脱敏。
# 本文件与 weather_server.py 各自保留一份相同实现：两个 server 是独立 stdio 进程，
# 不共享模块，属于冗余而非疏漏。
#
# 脱敏规则（对名称大小写不敏感，覆盖 URL 编码形式）：
# - 第一层：当前配置的真实密钥取值（原样与整体 URL 编码两种形态）在原文层与
#   解码层都要整体抹除。这一步必须先于字段级掩码执行：字段掩码的取值匹配会在
#   #、&、空白、引号等分隔字符处截断，先掩参数名会把含特殊字符的密钥切成两半，
#   残余的后半段再按完整密钥查找永远匹配不上——修复前
#   key=abc#SENSITIVE_TAIL99 会变成 key=[REDACTED]#SENSITIVE_TAIL99；
# - 第二层：key / api-key / appid / app_id / token / access_token / secret 等
#   敏感参数的取值，以 key=XXX、key:XXX、"appid":"XXX" 等形态替换为 [REDACTED]；
# - 再做有界的 URL 解码（key%3Dxxx、key%253Dxxx 等编码形态同样命中）；
# - 短密钥（长度 < _MIN_BARE_REDACT_LEN）不参与裸值兜底：短串在普通文本里
#   极易撞上造成误伤。这类配置下动态诊断文本一律不外发，由 _api_error_reply
#   换成固定通用错误文案，既不泄漏也不误伤；
# - 异常类型名只回显可信白名单内的名字（_TRUSTED_EXC_TYPE_NAMES），白名单之外
#   一律省略，避免类名被改造/构造后成为泄密侧道。

_SENSITIVE_PARAM_RE = re.compile(
    r"(?i)(?<![\w\-])"
    r"(?P<name>"
    r"access[_\\-]?token|refresh[_\\-]?token|client[_\\-]?secret|application[_\\-]?key|"
    r"auth[_\\-]?key|auth[_\\-]?token|api[_\\-]?key|api[_\\-]?secret|app[_\\-]?secret|"
    r"app[_\\-]?id|auth|signature|credentials|credential|"
    r"password|passwd|pass|pwd|secret|token|key"
    r")"
    r"(?P<sep>[\"']?\s*[=:]\s*[\"']?)"
    r"(?P<value>[^\s&#;\"']*)"
)


def _deep_unquote(text: str, rounds: int = 3) -> str:
    """有界 URL 解码：覆盖 key%3Dxxx 与 key%253Dxxx 等编码形态，不会无限循环。"""
    current = text
    for _ in range(rounds):
        try:
            decoded = unquote_plus(current)
        except Exception:
            return current
        if decoded == current:
            break
        current = decoded
    return current


def _mask_param_value(match: re.Match) -> str:
    """保留参数名与分隔符，只替换取值，排查时可看出是哪个参数带了问题数据。"""
    return f"{match.group('name')}{match.group('sep')}[REDACTED]"


_MIN_BARE_REDACT_LEN = 8
_SHORT_KEY_ERROR_INFO = "请检查配置后重试"


def _secret_values() -> tuple[str, ...]:
    """本进程配置的真实密钥取值，用于裸值兜底（参数名之外的泄露）。"""
    return (AMAP_API_KEY,)


def _has_short_key() -> bool:
    """是否配置了非空且长度低于 _MIN_BARE_REDACT_LEN 的密钥。

    短密钥的裸值形态与普通文本几乎无法区分（给它做裸值替换会把普通文案一起
    毁掉），此时动态诊断文本一律不外发，由诊断出口换固定通用错误，
    机制上保证不泄漏也不误伤。
    """
    return any(
        isinstance(secret, str) and 0 < len(secret) < _MIN_BARE_REDACT_LEN
        for secret in _secret_values()
    )


def _secret_text_forms(secret: str) -> list[str]:
    """密钥可能落进文本的形态：原样与整体 URL 编码。"""
    forms = [secret]
    try:
        encoded = quote(secret, safe="")
        if encoded != secret and encoded:
            forms.append(encoded)
    except Exception:
        pass
    return forms


def _apply_once(s: str) -> str:
    """单层处理：先整体抹除配置密钥裸值（原样/编码形态），再做字段级掩码。

    顺序不可颠倒：字段掩码的取值匹配会在 #、&、空白、引号等分隔字符处截断，
    先掩参数名会把含特殊字符的密钥切成两半，残余的后半段再按完整密钥查找
    永远匹配不上。先做裸值替换，两步各自命中同一密钥的不同形态，
    结果都收敛为 [REDACTED]。
    """
    masked = s
    for secret in _secret_values():
        if isinstance(secret, str) and len(secret) >= _MIN_BARE_REDACT_LEN:
            for form in _secret_text_forms(secret):
                if form:
                    masked = re.sub(re.escape(form), "[REDACTED]", masked, flags=re.IGNORECASE)
    return _SENSITIVE_PARAM_RE.sub(_mask_param_value, masked)


def redact_secrets(text: object) -> str:
    """对任意文本脱敏凭据取值（大小写不敏感，覆盖原样与 URL 编码形态），永不抛异常。

    极端情况下脱敏本身失败时，宁可整体吞掉内容也决不让密钥裸奔。
    """
    try:
        if not isinstance(text, str):
            text = str(text)
    except Exception:
        return "[REDACTED]"
    if not text:
        return text
    try:
        masked = _apply_once(text)          # 原文层：裸值密钥（原样/编码）+ 字段级掩码
        decoded = _deep_unquote(masked)
        masked = _apply_once(decoded)       # 解码层：key%3Dxxx 形态 + 解码后现形的裸值
        return masked
    except Exception:
        return "[REDACTED]"


# 异常类型名可信白名单：类型名只回显 httpx / 标准库中实际会出现的名字；
# 白名单之外一律不注明——异常类可以被替换或构造，类名不能成为泄密侧道。
_TRUSTED_EXC_TYPE_NAMES = frozenset({
    "HTTPError", "RequestError", "TransportError", "TimeoutException",
    "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout",
    "NetworkError", "ConnectError", "ReadError", "WriteError", "CloseError",
    "ProtocolError", "LocalProtocolError", "RemoteProtocolError", "ProxyError",
    "UnsupportedProtocol", "DecodingError", "TooManyRedirects",
    "HTTPStatusError", "InvalidURL", "CookieConflict", "StreamError",
    "JSONDecodeError", "ValueError", "TypeError", "KeyError", "AttributeError",
    "OSError", "ConnectionError", "TimeoutError", "UnicodeDecodeError",
    "SSLError", "RuntimeError",
})


def _trusted_exc_type_name(exc: BaseException) -> str:
    """白名单之外的异常类名返回空串，返回文案据此省略类型标注。"""
    name = type(exc).__name__
    return name if name in _TRUSTED_EXC_TYPE_NAMES else ""


def _request_error(exc: BaseException) -> str:
    """网络/服务异常的对外安全描述：固定中文文案，不带回任何异常原文。

    原因：httpx 系列异常与 JSON 解析异常的文本可能包含完整请求 URL（key=）
    或响应内容片段，属于真实网络异常的典型泄露路径。类型名仅当命中可信
    白名单时回显，未知类名直接省略这段标注。
    """
    message = "[错误] 请求失败: 网络异常或服务暂不可用，请稍后重试"
    name = _trusted_exc_type_name(exc)
    if name:
        message += f"（异常类型: {name}）"
    return message


def _api_error_reply(prefix: str, info: object) -> str:
    """保留高德业务错误（如地址解析不到、配额提示），仅做凭据兜底脱敏。

    配置了短密钥时动态 info 一律不外发：短密钥的裸值形态无法在普通文本里
    安全抹除，统一换成固定通用错误，牺牲这部分可读性换取不泄漏、不误伤。
    """
    if _has_short_key():
        return f"[错误] {prefix}: {_SHORT_KEY_ERROR_INFO}"
    if not isinstance(info, str):
        info = str(info)
    return f"[错误] {prefix}: {redact_secrets(info)}"


# 创建 MCP 服务器
mcp = FastMCP("amap-server")

# ==================== HTTP 日志隐私 ====================
# 高德 Web 服务的密钥只能走 query 参数，httpx 0.28 每收到一个响应（成功、4xx/5xx 都算）
# 就在 "httpx" logger 上打一条 INFO，内容是带 key=<密钥> 的完整请求 URL：
#
#   HTTP Request: GET https://restapi.amap.com/v3/place/text?...&key=<密钥> "HTTP/1.1 200 OK"
#
# FastMCP 1.30 构造时会调用 configure_logging(...)，把 root 配成 INFO + RichHandler(stderr)，
# 密钥因此进 stderr 和日志文件。加固必须写在这行之后：写在前面的会被它改回 INFO。
# 只抬不降：外部已设成 WARNING/ERROR 就原样保留，重复调用无副作用。
# 级别检查发生在 LogRecord 创建之前，比给 handler 挂 logging.Filter 可靠：
# filter 不会继承给 httpx._client 这类子 logger，level 会继承。
_HTTPX_LOGGER_NAME = "httpx"
_HTTPX_SAFE_LEVEL = logging.WARNING


def harden_httpx_logging() -> None:
    """让 httpx 的 INFO/DEBUG 日志（带完整请求 URL）进不了日志，幂等。"""

    httpx_logger = logging.getLogger(_HTTPX_LOGGER_NAME)
    level = httpx_logger.level
    if level != logging.NOTSET and level >= _HTTPX_SAFE_LEVEL:
        return
    httpx_logger.setLevel(_HTTPX_SAFE_LEVEL)


harden_httpx_logging()


def check_api_key() -> str | None:
    """检查 API Key 是否配置"""
    if not AMAP_API_KEY:
        return "[错误] 未配置 AMAP_API_KEY，请在 .env 文件中添加高德地图 API Key"
    return None


@mcp.tool()
async def search_poi(keywords: str, city: str = "全国", page_size: int = 5) -> str:
    """
    搜索兴趣点（POI），如景点、餐厅、酒店等
    
    Args:
        keywords: 搜索关键词，如"故宫"、"火锅"、"五星级酒店"
        city: 城市名称，默认全国搜索
        page_size: 返回结果数量，默认5条
    """
    if err := check_api_key():
        return err
    
    url = f"{AMAP_BASE_URL}/place/text"
    params = {
        "key": AMAP_API_KEY,
        "keywords": keywords,
        "city": city,
        "offset": page_size,
        "output": "json"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("查询失败", data.get("info", "未知错误"))
            
            pois = data.get("pois", [])
            if not pois:
                return f"[搜索] 未找到与「{keywords}」相关的地点"
            
            results = [f"[搜索] 「{keywords}」在「{city}」的结果:\n"]
            for i, poi in enumerate(pois, 1):
                name = poi.get("name", "未知")
                address = poi.get("address", "地址未知")
                ptype = poi.get("type", "").split(";")[0] if poi.get("type") else "未分类"
                tel = poi.get("tel", "无")
                
                results.append(f"{i}. {name}")
                results.append(f"   类型: {ptype}")
                results.append(f"   地址: {address}")
                if tel and tel != "无":
                    results.append(f"   电话: {tel}")
                results.append("")
            
            return "\n".join(results)
        except Exception as e:
            return _request_error(e)


@mcp.tool()
async def geocode(address: str) -> str:
    """
    地理编码：将地址转换为经纬度坐标
    
    Args:
        address: 详细地址，如"北京市朝阳区阜通东大街6号"
    """
    if err := check_api_key():
        return err
    
    url = f"{AMAP_BASE_URL}/geocode/geo"
    params = {
        "key": AMAP_API_KEY,
        "address": address,
        "output": "json"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("地理编码失败", data.get("info", "未知错误"))
            
            geocodes = data.get("geocodes", [])
            if not geocodes:
                return f"[错误] 无法解析地址: {address}"
            
            geo = geocodes[0]
            location = geo.get("location", "")
            formatted = geo.get("formatted_address", address)
            province = geo.get("province", "")
            city = geo.get("city", "")
            district = geo.get("district", "")
            
            return f"""[地址解析结果]
地址: {formatted}
区域: {province} {city} {district}
坐标: {location}"""
        except Exception as e:
            return _request_error(e)


@mcp.tool()
async def route_driving(origin: str, destination: str, strategy: int = 0) -> str:
    """
    驾车路线规划
    
    Args:
        origin: 起点，可以是地名或坐标(经度,纬度)
        destination: 终点，可以是地名或坐标(经度,纬度)
        strategy: 策略 0-速度优先 1-费用优先 2-距离优先
    """
    if err := check_api_key():
        return err
    
    # 先获取起点和终点的坐标
    origin_loc = await geocode(origin)
    dest_loc = await geocode(destination)
    
    if "[错误]" in origin_loc:
        return f"[错误] 无法解析起点「{origin}」的位置"
    if "[错误]" in dest_loc:
        return f"[错误] 无法解析终点「{destination}」的位置"
    
    # 提取坐标
    origin_coord = origin_loc.split("坐标: ")[1].split("\n")[0] if "坐标:" in origin_loc else origin
    dest_coord = dest_loc.split("坐标: ")[1].split("\n")[0] if "坐标:" in dest_loc else destination
    
    url = f"{AMAP_BASE_URL}/direction/driving"
    params = {
        "key": AMAP_API_KEY,
        "origin": origin_coord,
        "destination": dest_coord,
        "strategy": strategy,
        "output": "json"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=15.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("路线规划失败", data.get("info", "未知错误"))
            
            route = data.get("route", {})
            paths = route.get("paths", [])
            
            if not paths:
                return "[错误] 未找到可用路线"
            
            path = paths[0]
            distance = int(path.get("distance", 0)) / 1000
            duration = int(path.get("duration", 0)) / 60
            tolls = path.get("tolls", "0")
            
            hours = int(duration // 60)
            minutes = int(duration % 60)
            time_str = f"{hours}小时{minutes}分钟" if hours > 0 else f"{minutes}分钟"
            
            result = f"""[驾车路线规划] {origin} -> {destination}

总距离: {distance:.1f} 公里
预计时间: {time_str}
过路费: {tolls}元

路线概要:
"""
            steps = path.get("steps", [])
            for i, step in enumerate(steps[:8], 1):
                instruction = step.get("instruction", "")
                step_distance = int(step.get("distance", 0))
                if step_distance >= 1000:
                    dist_str = f"{step_distance/1000:.1f}km"
                else:
                    dist_str = f"{step_distance}m"
                result += f"  {i}. {instruction} ({dist_str})\n"
            
            if len(steps) > 8:
                result += f"  ... 共 {len(steps)} 步\n"
            
            return result.strip()
        except Exception as e:
            return _request_error(e)


@mcp.tool()
async def route_transit(origin: str, destination: str, city: str) -> str:
    """
    公交/地铁路线规划
    
    Args:
        origin: 起点地名
        destination: 终点地名
        city: 城市名称（必须指定）
    """
    if err := check_api_key():
        return err
    
    # 获取坐标
    origin_loc = await geocode(f"{city}{origin}")
    dest_loc = await geocode(f"{city}{destination}")
    
    if "[错误]" in origin_loc:
        return f"[错误] 无法解析起点「{origin}」"
    if "[错误]" in dest_loc:
        return f"[错误] 无法解析终点「{destination}」"
    
    origin_coord = origin_loc.split("坐标: ")[1].split("\n")[0] if "坐标:" in origin_loc else None
    dest_coord = dest_loc.split("坐标: ")[1].split("\n")[0] if "坐标:" in dest_loc else None
    
    if not origin_coord or not dest_coord:
        return "[错误] 坐标解析失败"
    
    url = f"{AMAP_BASE_URL}/direction/transit/integrated"
    params = {
        "key": AMAP_API_KEY,
        "origin": origin_coord,
        "destination": dest_coord,
        "city": city,
        "output": "json"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=15.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("路线规划失败", data.get("info", "未知错误"))
            
            route = data.get("route", {})
            transits = route.get("transits", [])
            
            if not transits:
                return "[错误] 未找到公交路线"
            
            result = f"[公交路线] {origin} -> {destination} ({city})\n\n"
            
            for idx, transit in enumerate(transits[:3], 1):
                duration = int(transit.get("duration", 0)) / 60
                cost = transit.get("cost", "0")
                walking_dist = int(transit.get("walking_distance", 0))
                
                hours = int(duration // 60)
                minutes = int(duration % 60)
                time_str = f"{hours}小时{minutes}分钟" if hours > 0 else f"{minutes}分钟"
                
                result += f"方案{idx}: {time_str} | 票价{cost}元 | 步行{walking_dist}米\n"
                
                segments = transit.get("segments", [])
                for seg in segments:
                    bus = seg.get("bus", {})
                    if bus and bus.get("buslines"):
                        busline = bus["buslines"][0]
                        name = busline.get("name", "")
                        departure = busline.get("departure_stop", {}).get("name", "")
                        arrival = busline.get("arrival_stop", {}).get("name", "")
                        via_num = busline.get("via_num", 0)
                        result += f"   乘坐 {name}: {departure} -> {arrival} ({via_num}站)\n"
                    
                    walking = seg.get("walking", {})
                    if walking and int(walking.get("distance", 0)) > 100:
                        result += f"   步行 {walking.get('distance', 0)}米\n"
                
                result += "\n"
            
            return result.strip()
        except Exception as e:
            return _request_error(e)


@mcp.tool()
async def reverse_geocode(location: str) -> str:
    """
    逆地理编码：将经纬度坐标转换为地址
    
    Args:
        location: 经纬度坐标，格式为"经度,纬度"，如"116.481488,39.990464"
    """
    if err := check_api_key():
        return err
    
    url = f"{AMAP_BASE_URL}/geocode/regeo"
    params = {
        "key": AMAP_API_KEY,
        "location": location,
        "output": "json"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("逆地理编码失败", data.get("info", "未知错误"))
            
            regeo = data.get("regeocode", {})
            formatted = regeo.get("formatted_address", "未知地址")
            
            component = regeo.get("addressComponent", {})
            province = component.get("province", "")
            city = component.get("city", "") or province
            district = component.get("district", "")
            township = component.get("township", "")
            
            return f"""[坐标解析结果]
坐标: {location}
地址: {formatted}
区域: {province} {city} {district} {township}"""
        except Exception as e:
            return _request_error(e)


@mcp.tool()
async def search_around(location: str, keywords: str = "", radius: int = 1000) -> str:
    """
    周边搜索：搜索指定位置附近的POI
    
    Args:
        location: 中心点坐标，格式为"经度,纬度"，或地名（会自动转换）
        keywords: 搜索关键词，如"餐厅"、"停车场"
        radius: 搜索半径（米），默认1000米
    """
    if err := check_api_key():
        return err
    
    # 如果不是坐标格式，先进行地理编码
    if not ("," in location and location.replace(",", "").replace(".", "").isdigit()):
        geo_result = await geocode(location)
        if "[错误]" in geo_result:
            return geo_result
        location = geo_result.split("坐标: ")[1].split("\n")[0]
    
    url = f"{AMAP_BASE_URL}/place/around"
    params = {
        "key": AMAP_API_KEY,
        "location": location,
        "radius": radius,
        "offset": 10,
        "output": "json"
    }
    
    if keywords:
        params["keywords"] = keywords
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("周边搜索失败", data.get("info", "未知错误"))
            
            pois = data.get("pois", [])
            if not pois:
                return f"[搜索] 在 {radius}米 范围内未找到相关地点"
            
            keyword_text = f"「{keywords}」" if keywords else "地点"
            results = [f"[周边搜索] {keyword_text} (半径{radius}米):\n"]
            
            for i, poi in enumerate(pois[:10], 1):
                name = poi.get("name", "未知")
                address = poi.get("address", "地址未知")
                distance = poi.get("distance", "?")
                ptype = poi.get("type", "").split(";")[0] if poi.get("type") else ""
                
                results.append(f"{i}. {name} ({distance}米)")
                if ptype:
                    results.append(f"   类型: {ptype}")
                results.append(f"   地址: {address}")
                results.append("")
            
            return "\n".join(results)
        except Exception as e:
            return _request_error(e)


@mcp.tool()
async def get_district(keywords: str, sub_district: int = 1) -> str:
    """
    查询行政区划信息
    
    Args:
        keywords: 行政区名称，如"北京"、"朝阳区"
        sub_district: 显示下级行政区数量，0-3
    """
    if err := check_api_key():
        return err
    
    url = f"{AMAP_BASE_URL}/config/district"
    params = {
        "key": AMAP_API_KEY,
        "keywords": keywords,
        "subdistrict": sub_district,
        "output": "json"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            data = response.json()
            
            if data.get("status") != "1":
                return _api_error_reply("查询失败", data.get("info", "未知错误"))
            
            districts = data.get("districts", [])
            if not districts:
                return f"[错误] 未找到行政区: {keywords}"
            
            district = districts[0]
            name = district.get("name", "")
            level = district.get("level", "")
            center = district.get("center", "")
            
            level_map = {
                "country": "国家", "province": "省/直辖市",
                "city": "城市", "district": "区/县", "street": "街道"
            }
            
            result = f"""[行政区划] {name}
级别: {level_map.get(level, level)}
中心坐标: {center}
"""
            
            sub_districts = district.get("districts", [])
            if sub_districts:
                result += f"\n下级行政区 ({len(sub_districts)}个):\n"
                for sub in sub_districts[:20]:
                    result += f"  - {sub.get('name', '')}\n"
                if len(sub_districts) > 20:
                    result += f"  ... 共 {len(sub_districts)} 个\n"
            
            return result.strip()
        except Exception as e:
            return _request_error(e)


if __name__ == "__main__":
    mcp.run()
