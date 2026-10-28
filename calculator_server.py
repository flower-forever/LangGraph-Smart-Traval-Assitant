"""
计算器 MCP 服务器
提供安全的数学计算和出行费用估算功能

安全策略：
- 用 AST 白名单替代 eval：只允许数字、四则运算、幂、取模、负号、
  括号、白名单函数和 pi/e，其余语法（属性访问、下标、比较、字符串等）直接拒绝
- 校验先于求值：先检查表达式长度、嵌套深度、节点数量，再做运算
- 幂运算按结果规模预判：整数幂在计算前用 log10(底数) * 指数估算结果的量级，
  超过 MAX_INT_MAGNITUDE（10**1000）的巨大幂（如 9**9**9）被立即拒绝，
  不会先算出天文数字；结果在限内的普通幂（如 2**100、10000**2）正常计算
- 普通二元/一元运算只接受有限 int/float；列表/元组只能作为 sum/min/max 的
  受限参数，[1] * 1000000000 这类序列运算在分配内存前就被拒绝
- 运算结果限定为有限 int/float，布尔、复数等不支持的结果直接报错
"""
import ast
import math

from mcp.server.fastmcp import FastMCP

# 初始化 MCP 服务器
mcp = FastMCP("CalculatorServer")

# 表达式规模限制
MAX_EXPRESSION_LENGTH = 200   # 表达式最大长度
MAX_DEPTH = 12                # 最大嵌套深度（括号、函数调用等）
MAX_NODES = 100               # AST 节点总数上限
MAX_INT_MAGNITUDE = 10 ** 1000  # 任意中间/最终整数结果的位数上限
MAX_POWER_EXPONENT = 1000000  # 幂运算整数指数绝对值上限（0/±1 底数除外）
MAX_SEQUENCE_LENGTH = 50      # 列表/元组作为 sum/min/max 参数时的元素个数上限

# MAX_INT_MAGNITUDE 的常用对数，用于幂运算的结果规模预判，由上方常量派生保持一致
_MAX_INT_MAGNITUDE_LOG10 = float(len(str(MAX_INT_MAGNITUDE)) - 1)
# 结果规模预判的安全余量：估算误差（约 1e-6）远小于它，
# 估算落在 [上限-0.5, 上限+0.5] 的临界情况交由真实计算后精确比较
_POW_ESTIMATE_MARGIN = 0.5

# 允许的数学函数（白名单）
SAFE_FUNCTIONS = {
    'abs': abs,
    'round': round,
    'min': min,
    'max': max,
    'sum': sum,
    'pow': None,  # 占位，实际使用下方带规模限制的 _safe_pow
    'sqrt': math.sqrt,
    'sin': math.sin,
    'cos': math.cos,
    'tan': math.tan,
    'log': math.log,
    'log10': math.log10,
    'exp': math.exp,
    'floor': math.floor,
    'ceil': math.ceil,
}

# 允许的常量名
SAFE_CONSTANTS = {
    'pi': math.pi,
    'e': math.e,
}

# 允许接收列表/元组作为参数的白名单函数（其余函数与普通运算只接收数值）
_SEQUENCE_FUNCTIONS = frozenset({'sum', 'min', 'max'})

# 允许的双目运算符
_BINARY_OPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.FloorDiv: lambda a, b: a // b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: None,  # 占位，实际走 _safe_pow
}


def _check_result(value):
    """检查运算结果类型与规模：只允许有限 int/float，拒绝 bool/complex 等。"""
    if isinstance(value, bool):
        raise ValueError("表达式不允许产生布尔值")
    if isinstance(value, complex):
        raise ValueError("表达式不支持复数结果")
    if isinstance(value, int):
        if abs(value) > MAX_INT_MAGNITUDE:
            raise ValueError("运算结果超出允许范围（中间数值过大）")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("运算结果超出允许范围（浮点溢出）")
        return value
    raise ValueError(f"表达式不支持的结果类型: {type(value).__name__}")


def _as_number(value, context: str):
    """普通运算与函数参数的入口检查：只接受有限的 int/float，拒绝 bool/复数/容器。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{context}只支持数值（int/float），拒绝 {type(value).__name__}")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{context}不支持非有限浮点数")
    if isinstance(value, int) and abs(value) > MAX_INT_MAGNITUDE:
        raise ValueError(f"{context}的整数数值过大")
    return value


def _safe_pow(base, exponent):
    """
    带结果规模预判的幂运算。不做底数/指数的固定小上限，而是按结果规模拦截：

    对整数底数和整数指数，计算前用 log10(|base|) * exponent 估算结果的常用对数，
    超过 MAX_INT_MAGNITUDE（10**1000）对数量级的结果直接拒绝，不先计算超大整数；
    估算值落在上限附近（±0.5，远大于浮点估算误差）的临界情况才真正计算，
    因此被允许计算的整数结果不超过约 1002 位，9**9**9 这类超大幂毫秒级拒绝。
    0/±1 底数的结果恒为 -1/0/1，不受指数上限影响；浮点溢出、复数结果、
    0 的负指数幂统一转成 ValueError。
    """
    base = _as_number(base, "幂运算底数")
    exponent = _as_number(exponent, "幂运算指数")

    if isinstance(base, int) and isinstance(exponent, int):
        # 0/±1 底数：任意合法整数指数的结果都是 O(1) 小数（0 的负指数报除零），
        # 不存在大数分配风险，不做指数与规模限制，直接落到下方计算
        if abs(base) > 1:
            if abs(exponent) > MAX_POWER_EXPONENT:
                raise ValueError(
                    f"幂运算指数过大（指数绝对值不能超过 {MAX_POWER_EXPONENT}）"
                )
            if exponent > 0:
                # 结果规模预判：log10(|base|**exponent) = exponent * log10(|base|)。
                # 底数不超过 10**1000、指数不超过 MAX_POWER_EXPONENT，
                # 浮点估算误差在 1e-6 量级，0.5 的余量足以覆盖：
                # - 估算 > 上限+0.5：真实结果必然超过 10**1000，计算前拒绝；
                # - 估算 < 上限-0.5：真实结果必然在限内，正常计算；
                # - 之间的临界情况：结果距上限 3 倍以内（至多约 1002 位），
                #   直接计算后交给 _check_result 精确比较，开销可忽略。
                estimated_log10 = exponent * math.log10(abs(base))
                if estimated_log10 > _MAX_INT_MAGNITUDE_LOG10 + _POW_ESTIMATE_MARGIN:
                    raise ValueError(
                        "幂运算结果过大（超过允许的 10**1000 规模上限）"
                    )

    try:
        result = base ** exponent
    except OverflowError:
        raise ValueError("计算错误: 幂运算指数或结果溢出") from None
    except ZeroDivisionError:
        raise ValueError("计算错误: 除数不能为零") from None
    return _check_result(result)


# 装配真实实现
SAFE_FUNCTIONS['pow'] = _safe_pow
_BINARY_OPS[ast.Pow] = _safe_pow


def _validate_ast(tree: ast.AST) -> None:
    """
    结构校验（不求值）：限制长度、深度、节点数，并只放行白名单节点。
    """
    if not isinstance(tree, ast.Expression):
        raise ValueError("表达式格式不正确")

    max_depth = 0
    node_count = 0
    stack = [(tree, 0)]
    while stack:
        node, depth = stack.pop()
        node_count += 1
        if node_count > MAX_NODES:
            raise ValueError("表达式过于复杂（节点数超限）")
        max_depth = max(max_depth, depth)
        if max_depth > MAX_DEPTH:
            raise ValueError("表达式嵌套过深")

        if isinstance(node, ast.Expression):
            stack.append((node.body, depth))
        elif isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("只允许数字常量")
            if isinstance(node.value, float) and not math.isfinite(node.value):
                raise ValueError("数字常量溢出")
            if isinstance(node.value, int) and abs(node.value) > 10 ** 100:
                raise ValueError("数字常量过大")
        elif isinstance(node, ast.Name):
            if node.id not in SAFE_CONSTANTS:
                raise ValueError(f"不支持的名称: {node.id}")
        elif isinstance(node, ast.BinOp):
            if type(node.op) not in _BINARY_OPS:
                raise ValueError("表达式包含不允许的运算符")
            stack.append((node.left, depth + 1))
            stack.append((node.right, depth + 1))
        elif isinstance(node, ast.UnaryOp):
            if not isinstance(node.op, (ast.USub, ast.UAdd)):
                raise ValueError("表达式包含不允许的一元运算符")
            stack.append((node.operand, depth + 1))
        elif isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in SAFE_FUNCTIONS:
                raise ValueError("不允许调用此函数")
            if node.keywords:
                raise ValueError("函数调用不支持关键字参数")
            func_name = node.func.id
            for index, arg in enumerate(node.args):
                if isinstance(arg, (ast.List, ast.Tuple)):
                    if func_name not in _SEQUENCE_FUNCTIONS:
                        raise ValueError(f"{func_name}() 不接受列表/元组参数")
                    if index != 0:
                        raise ValueError("列表/元组只能作为 sum/min/max 的第一个参数")
                    if len(arg.elts) > MAX_SEQUENCE_LENGTH:
                        raise ValueError(
                            f"列表/元组元素过多（{func_name} 最多接收 {MAX_SEQUENCE_LENGTH} 个）"
                        )
                    for element in arg.elts:
                        if isinstance(element, (ast.List, ast.Tuple)):
                            raise ValueError("列表/元组不支持嵌套")
                        stack.append((element, depth + 1))
                else:
                    stack.append((arg, depth + 1))
        elif isinstance(node, (ast.List, ast.Tuple)):
            # 列表/元组只能作为 sum/min/max 的受限参数，不能参与普通运算
            raise ValueError("列表/元组只能作为 sum/min/max 的参数，不能参与其他运算")
        else:
            raise ValueError(f"表达式包含不允许的语法: {type(node).__name__}")


def _eval_sequence(node: ast.AST) -> list:
    """求值 sum/min/max 的列表或元组参数：元素必须是有限数值，长度受限。"""
    if len(node.elts) > MAX_SEQUENCE_LENGTH:
        raise ValueError(f"列表/元组元素过多（最多 {MAX_SEQUENCE_LENGTH} 个）")
    return [_as_number(_eval_node(element), "列表/元组元素") for element in node.elts]


def _eval_node(node: ast.AST):
    """对已通过校验的 AST 自底向上求值，运算全程带类型与规模检查。"""
    if isinstance(node, ast.Expression):
        return _eval_node(node.body)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return SAFE_CONSTANTS[node.id]
    if isinstance(node, ast.UnaryOp):
        operand = _as_number(_eval_node(node.operand), "一元运算")
        if isinstance(node.op, ast.USub):
            return _check_result(-operand)
        return _check_result(+operand)
    if isinstance(node, ast.BinOp):
        left = _as_number(_eval_node(node.left), "二元运算")
        right = _as_number(_eval_node(node.right), "二元运算")
        if isinstance(node.op, ast.Pow):
            return _safe_pow(left, right)
        result = _BINARY_OPS[type(node.op)](left, right)
        return _check_result(result)
    if isinstance(node, ast.Call):
        args = []
        for arg in node.args:
            if isinstance(arg, (ast.List, ast.Tuple)):
                args.append(_eval_sequence(arg))
            else:
                args.append(_eval_node(arg))
        result = SAFE_FUNCTIONS[node.func.id](*args)
        return _check_result(result)
    if isinstance(node, (ast.List, ast.Tuple)):
        raise ValueError("列表/元组只能作为 sum/min/max 的参数，不能参与其他运算")
    # 校验阶段已拦截，正常不会走到这里
    raise ValueError(f"表达式包含不允许的语法: {type(node).__name__}")


def safe_eval(expression: str) -> float:
    """
    安全地计算数学表达式
    :param expression: 数学表达式
    :return: 计算结果
    """
    if not isinstance(expression, str):
        raise ValueError("表达式必须是字符串")

    # 清理表达式
    expression = expression.strip()

    if not expression:
        raise ValueError("表达式不能为空")
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise ValueError(f"表达式过长（最多 {MAX_EXPRESSION_LENGTH} 个字符）")

    # 替换 ^ 为 **（幂运算）
    expression = expression.replace('^', '**')

    try:
        tree = ast.parse(expression, mode='eval')
    except SyntaxError as e:
        raise ValueError(f"表达式语法错误: {e.msg}")

    # 结构校验先于任何求值，超大数不会在校验前被计算
    _validate_ast(tree)

    try:
        return _eval_node(tree)
    except ValueError:
        raise
    except ZeroDivisionError as e:
        raise ValueError(f"计算错误: 除数不能为零")
    except OverflowError:
        raise ValueError("计算错误: 数值溢出")
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
