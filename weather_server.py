"""
天气查询 MCP 服务器
提供全球天气查询功能，使用 OpenWeatherMap API
"""
import os
import re
import httpx
from typing import Optional
from datetime import datetime
from urllib.parse import quote, unquote_plus
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

# 加载环境变量。测试环境（PYTHON_DOTENV_DISABLED=1）不读取真实 .env，
# 保证测试进程不加载用户凭据；正常运行未设置该变量时行为不变。
if not os.environ.get("PYTHON_DOTENV_DISABLED"):
    load_dotenv()

# 初始化 MCP 服务器
mcp = FastMCP("WeatherServer")

# OpenWeatherMap API 配置
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5"

# ==================== 凭据信息安全 ====================
# 红线：任何异常原文都可能携带带 appid= 的完整 URL 或密钥（httpx 异常、
# 代理配置、SSL 握手错误、raise_for_status 的 HTTPStatusError 等），不得进入工具返回或日志。
# 对外异常一律走固定中文描述（_fetch_error / _forecast_error），绝不返回 str(e)；
# redact_secrets 用于对确需保留的动态诊断文本做兜底脱敏（见 format_weather 的 error 透传）。
# 本文件与 amap_server.py 各自保留一份相同实现：两个 server 是独立 stdio 进程，
# 不共享模块，属于冗余而非疏漏。
#
# 脱敏规则（对名称大小写不敏感，覆盖 URL 编码形式）：
# - 第一层：当前配置的真实密钥取值（原样与整体 URL 编码两种形态）在原文层与
#   解码层都要整体抹除。这一步必须先于字段级掩码执行：字段掩码的取值匹配会在
#   #、&、空白、引号等分隔字符处截断，先掩参数名会把含特殊字符的密钥切成两半，
#   残余的后半段再按完整密钥查找永远匹配不上（appid=abc#TAIL99 同理）；
# - 第二层：key / appid / app_id / token / access_token / secret 等敏感参数的取值，
#   以 key=XXX、appid:XXX、"appid":"XXX" 等形态替换为 [REDACTED]；
# - 再做有界的 URL 解码（appid%3Dxxx、appid%253Dxxx 等编码形态同样命中）；
# - 短密钥（长度 < _MIN_BARE_REDACT_LEN）不参与裸值兜底：短串在普通文本里
#   极易撞上造成误伤。这类配置下动态诊断文本一律不外发，由 format_weather 的
#   error 透传换成固定通用错误文案，既不泄漏也不误伤；
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
    """有界 URL 解码：覆盖 appid%3Dxxx 与 appid%253Dxxx 等编码形态，不会无限循环。"""
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
_SHORT_KEY_ERROR_INFO = "网络异常或服务暂不可用，请稍后重试"


def _secret_values() -> tuple[str, ...]:
    """本进程配置的真实密钥取值，用于裸值兜底（参数名之外的泄露）。"""
    return (OPENWEATHER_API_KEY,)


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
        masked = _apply_once(decoded)       # 解码层：appid%3Dxxx 形态 + 解码后现形的裸值
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


def _fetch_error(exc: BaseException) -> str:
    """天气请求异常的对外安全描述：固定中文文案，不带回任何异常原文。

    原因：httpx 系列异常与 JSON 解析异常的文本可能包含完整请求 URL（appid=）
    或响应内容片段，属于真实网络异常的典型泄露路径。类型名仅当命中可信
    白名单时回显，未知类名直接省略。
    """
    message = "请求失败: 网络异常或服务暂不可用，请稍后重试"
    name = _trusted_exc_type_name(exc)
    if name:
        message += f"（异常类型: {name}）"
    return message


def _forecast_error(exc: BaseException) -> str:
    """天气预报异常的对外安全描述：固定中文文案，不带回任何异常原文。

    特别提示：raise_for_status 抛出的 HTTPStatusError 原文自带完整请求 URL（含 appid），
    旧代码泛捕获分支正是最大的泄露源，这里只返回固定文案。类型名仅当命中
    可信白名单时回显，未知类名直接省略。
    """
    message = "❌ 获取预报失败: 网络异常或服务暂不可用，请稍后重试"
    name = _trusted_exc_type_name(exc)
    if name:
        message += f"（异常类型: {name}）"
    return message


async def fetch_weather(city: str) -> dict:
    """
    从 OpenWeatherMap API 获取天气数据
    :param city: 城市名称（英文）
    :return: 天气数据字典
    """
    if not OPENWEATHER_API_KEY:
        return {"error": "未配置 OPENWEATHER_API_KEY"}
    
    url = f"{OPENWEATHER_BASE_URL}/weather"
    params = {
        "q": city,
        "appid": OPENWEATHER_API_KEY,
        "units": "metric",  # 使用摄氏度
        "lang": "zh_cn"     # 中文描述
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            return {"error": f"API 错误: {e.response.status_code}"}
        except Exception as e:
            return {"error": _fetch_error(e)}


def format_weather(data: dict) -> str:
    """
    格式化天气数据为可读字符串
    :param data: 天气数据字典
    :return: 格式化后的天气信息
    """
    if "error" in data:
        if _has_short_key():
            # 短密钥场景：动态诊断文本一律不外发，统一以固定通用错误替代。
            return f"❌ {_SHORT_KEY_ERROR_INFO}"
        return f"❌ {redact_secrets(data['error'])}"
    
    try:
        city_name = data.get("name", "未知城市")
        country = data.get("sys", {}).get("country", "")
        weather_desc = data.get("weather", [{}])[0].get("description", "未知")
        temp = data.get("main", {}).get("temp", "N/A")
        feels_like = data.get("main", {}).get("feels_like", "N/A")
        humidity = data.get("main", {}).get("humidity", "N/A")
        wind_speed = data.get("wind", {}).get("speed", "N/A")
        
        # 获取天气图标
        weather_main = data.get("weather", [{}])[0].get("main", "").lower()
        icons = {
            "clear": "☀️",
            "clouds": "☁️",
            "rain": "🌧️",
            "drizzle": "🌦️",
            "thunderstorm": "⛈️",
            "snow": "❄️",
            "mist": "🌫️",
            "fog": "🌫️"
        }
        icon = icons.get(weather_main, "🌈")
        
        result = f"""
{icon} **{city_name}, {country}** 天气信息

📊 **当前状况**: {weather_desc}
🌡️ **温度**: {temp}°C（体感 {feels_like}°C）
💧 **湿度**: {humidity}%
💨 **风速**: {wind_speed} m/s
📅 **更新时间**: {datetime.now().strftime("%Y-%m-%d %H:%M")}
"""
        return result.strip()
    
    except Exception as e:
        name = _trusted_exc_type_name(e)
        if name:
            return f"❌ 天气数据解析失败，请稍后重试（异常类型: {name}）"
        return "❌ 天气数据解析失败，请稍后重试"


# 城市名称中英文映射
CITY_MAPPING = {
    "北京": "Beijing",
    "上海": "Shanghai",
    "广州": "Guangzhou",
    "深圳": "Shenzhen",
    "杭州": "Hangzhou",
    "南京": "Nanjing",
    "成都": "Chengdu",
    "重庆": "Chongqing",
    "武汉": "Wuhan",
    "西安": "Xian",
    "苏州": "Suzhou",
    "天津": "Tianjin",
    "青岛": "Qingdao",
    "厦门": "Xiamen",
    "三亚": "Sanya",
    "大连": "Dalian",
    "香港": "Hong Kong",
    "澳门": "Macau",
    "台北": "Taipei"
}


@mcp.tool()
async def query_weather(city: str) -> str:
    """
    查询指定城市的实时天气信息。
    支持中文城市名（如：北京、上海）或英文城市名（如：London、Tokyo）。
    
    :param city: 城市名称（中文或英文）
    :return: 格式化后的天气信息
    """
    # 尝试转换中文城市名
    city_en = CITY_MAPPING.get(city, city)
    
    data = await fetch_weather(city_en)
    return format_weather(data)


@mcp.tool()
async def get_weather_forecast(city: str, days: int = 3) -> str:
    """
    获取指定城市的天气预报（未来几天）。
    注意：免费 API 仅支持 5 天预报。
    
    :param city: 城市名称（中文或英文）
    :param days: 预报天数（1-5天）
    :return: 天气预报信息
    """
    if not OPENWEATHER_API_KEY:
        return "❌ 未配置 OPENWEATHER_API_KEY"
    
    city_en = CITY_MAPPING.get(city, city)
    days = min(max(days, 1), 5)  # 限制在 1-5 天
    
    url = f"{OPENWEATHER_BASE_URL}/forecast"
    params = {
        "q": city_en,
        "appid": OPENWEATHER_API_KEY,
        "units": "metric",
        "lang": "zh_cn",
        "cnt": days * 8  # 每天 8 条数据（3小时一条）
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, timeout=10.0)
            response.raise_for_status()
            data = response.json()
            
            # 解析预报数据
            forecasts = []
            seen_dates = set()
            
            for item in data.get("list", []):
                dt = datetime.fromtimestamp(item["dt"])
                date_str = dt.strftime("%Y-%m-%d")
                
                if date_str not in seen_dates and len(seen_dates) < days:
                    seen_dates.add(date_str)
                    temp = item["main"]["temp"]
                    desc = item["weather"][0]["description"]
                    forecasts.append(f"📅 {date_str}: {temp}°C, {desc}")
            
            city_name = data.get("city", {}).get("name", city)
            result = f"🌤️ **{city_name}** 未来 {days} 天天气预报:\n\n"
            result += "\n".join(forecasts)
            return result
            
        except Exception as e:
            return _forecast_error(e)


@mcp.tool()
async def get_weather_tips(season: str) -> str:
    """
    获取指定季节的出行贴士。
    
    :param season: 季节名称 (spring/春季, summer/夏季, autumn/秋季, winter/冬季)
    :return: 出行贴士
    """
    # 支持中英文
    season_map = {
        "春季": "spring", "春天": "spring", "春": "spring",
        "夏季": "summer", "夏天": "summer", "夏": "summer",
        "秋季": "autumn", "秋天": "autumn", "秋": "autumn", "fall": "autumn",
        "冬季": "winter", "冬天": "winter", "冬": "winter"
    }
    
    season_key = season_map.get(season, season.lower())
    
    tips = {
        "spring": """
🌸 **春季出行贴士**

1. **穿着建议**: 
   - 早晚温差大，建议穿着可脱卸的多层衣物
   - 准备一件轻便外套或风衣

2. **健康提醒**:
   - 花粉季节，过敏体质者备好口罩和药物
   - 注意春季流感预防

3. **出行装备**:
   - 折叠伞必备，春雨绵绵
   - 防晒霜和墨镜（紫外线渐强）

4. **推荐活动**: 赏花、踏青、放风筝
""",
        "summer": """
☀️ **夏季出行贴士**

1. **防暑措施**:
   - 避开 11:00-15:00 高温时段户外活动
   - 随身携带防暑药品（藿香正气水等）

2. **穿着建议**:
   - 浅色、透气的衣物
   - 遮阳帽和太阳镜必备

3. **补水提醒**:
   - 每小时喝 200-300ml 水
   - 避免冰饮过量

4. **推荐活动**: 海边游泳、避暑山区、夜游
""",
        "autumn": """
🍂 **秋季出行贴士**

1. **穿着建议**:
   - 昼夜温差大，建议洋葱式穿搭
   - 准备薄款羽绒服或抓绒衣

2. **健康提醒**:
   - 秋燥明显，多喝水、吃润肺食物
   - 注意保暖，预防感冒

3. **出行装备**:
   - 润唇膏、保湿霜
   - 秋高气爽，适合摄影

4. **推荐活动**: 赏红叶、登山、采摘
""",
        "winter": """
❄️ **冬季出行贴士**

1. **保暖措施**:
   - 帽子、手套、围巾三件套
   - 保暖内衣 + 羽绒服组合

2. **安全提醒**:
   - 注意路面结冰，穿防滑鞋
   - 自驾检查防冻液和轮胎

3. **健康建议**:
   - 温泉养生，暖身补气
   - 注意室内外温差，预防感冒

4. **推荐活动**: 滑雪、泡温泉、观雪景
"""
    }
    
    return tips.get(season_key, f"❓ 未知季节: {season}。请使用: spring/summer/autumn/winter 或对应中文")


@mcp.tool()
async def get_clothing_suggestion(temperature: float) -> str:
    """
    根据温度给出穿衣建议。
    
    :param temperature: 当前温度（摄氏度）
    :return: 穿衣建议
    """
    if temperature < 0:
        return """
🥶 **严寒天气 (<0°C)**
- 厚羽绒服/棉服
- 保暖内衣
- 帽子、围巾、手套
- 厚袜子 + 保暖靴
"""
    elif temperature < 10:
        return """
🧥 **寒冷天气 (0-10°C)**
- 羽绒服或厚外套
- 毛衣/抓绒衣
- 长裤
- 围巾可选
"""
    elif temperature < 20:
        return """
👔 **凉爽天气 (10-20°C)**
- 薄外套/夹克
- 长袖衬衫/卫衣
- 长裤
- 可备薄围巾
"""
    elif temperature < 28:
        return """
👕 **舒适天气 (20-28°C)**
- 短袖/薄长袖
- 薄长裤/裙装
- 可带薄外套（空调房）
"""
    else:
        return """
☀️ **炎热天气 (>28°C)**
- 短袖、短裤
- 浅色透气面料
- 遮阳帽 + 太阳镜
- 防晒霜必备
"""


if __name__ == "__main__":
    mcp.run(transport='stdio')
