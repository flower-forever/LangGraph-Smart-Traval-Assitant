# -*- coding: utf-8 -*-
"""
高德地图 MCP 服务器
提供路线规划、POI搜索、地理编码等功能
"""
import os
import sys
import io
import httpx
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

# 设置输出编码
if sys.stdout:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

load_dotenv()

# 高德地图 API 配置
AMAP_API_KEY = os.getenv("AMAP_API_KEY", "")
AMAP_BASE_URL = "https://restapi.amap.com/v3"

# 创建 MCP 服务器
mcp = FastMCP("amap-server")


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
                return f"[错误] 查询失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


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
                return f"[错误] 地理编码失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


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
                return f"[错误] 路线规划失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


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
                return f"[错误] 路线规划失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


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
                return f"[错误] 逆地理编码失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


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
                return f"[错误] 周边搜索失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


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
                return f"[错误] 查询失败: {data.get('info', '未知错误')}"
            
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
            return f"[错误] 请求失败: {str(e)}"


if __name__ == "__main__":
    mcp.run()
