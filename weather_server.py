"""
天气查询 MCP 服务器
提供全球天气查询功能，使用 OpenWeatherMap API
"""
import os
import httpx
from typing import Optional
from datetime import datetime
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 初始化 MCP 服务器
mcp = FastMCP("WeatherServer")

# OpenWeatherMap API 配置
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5"


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
            return {"error": f"请求失败: {str(e)}"}


def format_weather(data: dict) -> str:
    """
    格式化天气数据为可读字符串
    :param data: 天气数据字典
    :return: 格式化后的天气信息
    """
    if "error" in data:
        return f"❌ {data['error']}"
    
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
        return f"❌ 数据解析错误: {str(e)}"


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
            return f"❌ 获取预报失败: {str(e)}"


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
