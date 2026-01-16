"""
计算器 MCP 服务器
提供安全的数学计算和出行费用估算功能
"""
import math
import re
from mcp.server.fastmcp import FastMCP

# 初始化 MCP 服务器
mcp = FastMCP("CalculatorServer")

# 允许的数学函数（白名单）
SAFE_FUNCTIONS = {
    'abs': abs,
    'round': round,
    'min': min,
    'max': max,
    'sum': sum,
    'pow': pow,
    'sqrt': math.sqrt,
    'sin': math.sin,
    'cos': math.cos,
    'tan': math.tan,
    'log': math.log,
    'log10': math.log10,
    'exp': math.exp,
    'floor': math.floor,
    'ceil': math.ceil,
    'pi': math.pi,
    'e': math.e
}


def safe_eval(expression: str) -> float:
    """
    安全地计算数学表达式
    :param expression: 数学表达式
    :return: 计算结果
    """
    # 清理表达式
    expression = expression.strip()
    
    # 只允许数字、运算符和白名单函数
    allowed_pattern = r'^[\d\s\+\-\*\/\.\(\)\,\%\^a-z]+$'
    if not re.match(allowed_pattern, expression, re.IGNORECASE):
        raise ValueError("表达式包含不允许的字符")
    
    # 替换 ^ 为 **（幂运算）
    expression = expression.replace('^', '**')
    
    # 使用安全的函数字典计算
    try:
        result = eval(expression, {"__builtins__": {}}, SAFE_FUNCTIONS)
        return result
    except Exception as e:
        raise ValueError(f"计算错误: {e}")


@mcp.tool()
async def calculate(expression: str) -> str:
    """
    安全地计算数学表达式。
    支持: +, -, *, /, ^(幂), %, 括号, 以及数学函数(sqrt, sin, cos, log等)
    
    :param expression: 数学表达式，如 "2 + 3 * 4", "sqrt(16)", "2^10"
    :return: 计算结果
    """
    try:
        result = safe_eval(expression)
        # 格式化结果
        if isinstance(result, float):
            if result.is_integer():
                result = int(result)
            else:
                result = round(result, 6)
        return f"🔢 计算结果: {expression} = {result}"
    except Exception as e:
        return f"❌ 计算错误: {e}"


@mcp.tool()
async def calculate_fuel_cost(
    distance: float,
    fuel_consumption: float = 8.0,
    fuel_price: float = 7.5
) -> str:
    """
    计算自驾出行的油费。
    
    :param distance: 行驶距离（公里）
    :param fuel_consumption: 百公里油耗（升/100公里），默认 8.0
    :param fuel_price: 油价（元/升），默认 7.5
    :return: 油费估算
    """
    try:
        fuel_needed = (distance / 100) * fuel_consumption
        total_cost = fuel_needed * fuel_price
        
        return f"""
⛽ **油费估算**

📏 行驶距离: {distance} 公里
🚗 百公里油耗: {fuel_consumption} L/100km
💰 油价: ¥{fuel_price}/L

---
📊 预计耗油: {fuel_needed:.2f} 升
💵 预计油费: ¥{total_cost:.2f}
"""
    except Exception as e:
        return f"❌ 计算错误: {e}"


@mcp.tool()
async def calculate_travel_time(
    distance: float,
    speed: float = 80.0,
    rest_interval: float = 2.0,
    rest_duration: float = 0.25
) -> str:
    """
    估算自驾出行时间（包含休息时间）。
    
    :param distance: 行驶距离（公里）
    :param speed: 平均时速（公里/小时），默认 80
    :param rest_interval: 每隔多少小时休息一次，默认 2小时
    :param rest_duration: 每次休息时长（小时），默认 0.25（15分钟）
    :return: 时间估算
    """
    try:
        # 纯驾驶时间
        driving_time = distance / speed
        
        # 休息次数和时间
        rest_count = int(driving_time / rest_interval)
        total_rest = rest_count * rest_duration
        
        # 总时间
        total_time = driving_time + total_rest
        
        # 转换为时分格式
        hours = int(total_time)
        minutes = int((total_time - hours) * 60)
        
        return f"""
⏱️ **行程时间估算**

📏 行驶距离: {distance} 公里
🚗 平均时速: {speed} km/h
☕ 休息安排: 每 {rest_interval} 小时休息 {int(rest_duration * 60)} 分钟

---
🚙 纯驾驶时间: {driving_time:.1f} 小时
🛑 休息次数: {rest_count} 次
☕ 总休息时间: {total_rest * 60:.0f} 分钟
⏰ **预计总时长: {hours} 小时 {minutes} 分钟**
"""
    except Exception as e:
        return f"❌ 计算错误: {e}"


@mcp.tool()
async def calculate_travel_budget(
    days: int,
    accommodation: float = 300.0,
    food: float = 150.0,
    transport: float = 100.0,
    attractions: float = 100.0,
    shopping: float = 200.0
) -> str:
    """
    估算旅行预算。
    
    :param days: 旅行天数
    :param accommodation: 每天住宿费用（元），默认 300
    :param food: 每天餐饮费用（元），默认 150
    :param transport: 每天交通费用（元），默认 100
    :param attractions: 每天景点门票（元），默认 100
    :param shopping: 每天购物预算（元），默认 200
    :return: 预算估算
    """
    try:
        daily_total = accommodation + food + transport + attractions + shopping
        total_budget = daily_total * days
        
        return f"""
💰 **旅行预算估算**

📅 旅行天数: {days} 天

---
**每日花费明细:**
🏨 住宿: ¥{accommodation}/天
🍜 餐饮: ¥{food}/天
🚌 交通: ¥{transport}/天
🎫 门票: ¥{attractions}/天
🛍️ 购物: ¥{shopping}/天

---
📊 每日合计: ¥{daily_total}
💵 **总预算: ¥{total_budget}**

💡 建议额外准备 10-20% 应急资金
"""
    except Exception as e:
        return f"❌ 计算错误: {e}"


@mcp.tool()
async def convert_currency(
    amount: float,
    from_currency: str = "CNY",
    to_currency: str = "USD"
) -> str:
    """
    货币换算（使用固定汇率，仅供参考）。
    
    :param amount: 金额
    :param from_currency: 源货币代码（CNY/USD/EUR/JPY/GBP/HKD）
    :param to_currency: 目标货币代码
    :return: 换算结果
    """
    # 相对于人民币的汇率（仅供参考，实际汇率以银行为准）
    rates_to_cny = {
        "CNY": 1.0,
        "USD": 7.25,
        "EUR": 7.85,
        "JPY": 0.048,
        "GBP": 9.2,
        "HKD": 0.93,
        "KRW": 0.0054,
        "THB": 0.20,
        "SGD": 5.40
    }
    
    from_currency = from_currency.upper()
    to_currency = to_currency.upper()
    
    if from_currency not in rates_to_cny:
        return f"❌ 不支持的货币: {from_currency}"
    if to_currency not in rates_to_cny:
        return f"❌ 不支持的货币: {to_currency}"
    
    # 先转换为人民币，再转换为目标货币
    cny_amount = amount * rates_to_cny[from_currency]
    result = cny_amount / rates_to_cny[to_currency]
    
    return f"""
💱 **货币换算**

{amount} {from_currency} = {result:.2f} {to_currency}

⚠️ 汇率仅供参考，实际汇率请以银行为准
"""


if __name__ == "__main__":
    mcp.run(transport='stdio')
