# -*- coding: utf-8 -*-
"""calculator_server AST 白名单与运算规模限制测试。

覆盖：原示例与常用运算正确、危险语法被拒、超大幂按结果规模在计算前快速拒绝
（不先计算）、结果规模限内的普通幂不被误伤、非白名单名称/函数被拒、
深度和长度限制生效。
"""

import asyncio
import math
import time

import pytest

from calculator_server import calculate, safe_eval


# ---------------------------------------------------------------- 常用运算正确


def test_original_examples():
    assert safe_eval("2 + 3 * 4") == 14
    assert safe_eval("sqrt(16)") == 4.0
    assert safe_eval("2^10") == 1024


def test_basic_operations():
    assert safe_eval("(2 + 3) * 4") == 20
    assert safe_eval("10 % 3") == 1
    assert safe_eval("7 / 2") == 3.5
    assert safe_eval("7 // 2") == 3
    assert safe_eval("-5 + 3") == -2
    assert safe_eval("2**8") == 256
    assert safe_eval("3^2") == 9
    assert safe_eval("2^3^2") == 512          # 右结合
    assert safe_eval("2 ** -3") == 0.125
    assert safe_eval("-(2**5)") == -32


def test_math_functions_and_constants():
    assert safe_eval("abs(-5)") == 5
    assert safe_eval("round(3.7)") == 4
    assert safe_eval("floor(3.9)") == 3
    assert safe_eval("ceil(3.1)") == 4
    assert safe_eval("min(3, 1, 2)") == 1
    assert safe_eval("max(3, 1, 2)") == 3
    assert safe_eval("sum([1, 2, 3])") == 6
    assert safe_eval("pow(2, 10)") == 1024
    assert abs(safe_eval("pi") - math.pi) < 1e-12
    assert abs(safe_eval("e") - math.e) < 1e-12
    assert abs(safe_eval("sin(pi/2)") - 1) < 1e-12
    assert abs(safe_eval("log(2.718281828459045)") - 1) < 1e-9
    assert abs(safe_eval("log10(100)") - 2) < 1e-12


def test_calculate_tool_output_and_error():
    result = asyncio.run(calculate("2 + 3 * 4"))
    assert "14" in result

    err = asyncio.run(calculate("1/0"))
    assert "❌" in err
    assert "计算错误" in err


# ---------------------------------------------------------------- 危险语法拒绝


@pytest.mark.parametrize(
    "bad_expr",
    [
        "__import__('os').system('dir')",
        "().__class__",
        "(lambda: 1)()",
        "1 if True else 2",
        "'a' + 'b'",
        "x = 1",
        "1; 2",
        "import os",
        "",
        "   ",
        "unknown_name + 1",
        "abs",                    # 裸函数名
        "sqrt[4]",
        "[1, 2][0]",
        "1 @ 2",
        "2 << 10",
        "5 % 0",
        "1/0",
        "1e400",                  # 浮点常量溢出
        "1" + "+1" * 200,         # 超长表达式
        "1+" * 25 + "1",          # 嵌套过深
    ],
)
def test_dangerous_syntax_rejected(bad_expr):
    with pytest.raises(ValueError):
        safe_eval(bad_expr)


def test_huge_power_9_9_9_rejected_fast():
    """9**9**9 必须被快速拒绝，不能先算出 387420489 位的巨大整数。"""
    start = time.perf_counter()
    with pytest.raises(ValueError):
        safe_eval("9**9**9")
    assert time.perf_counter() - start < 1.0


@pytest.mark.parametrize(
    "bad_expr",
    [
        "9**9**9",
        "9^9^9",
        "pow(9, 9**9)",           # 超大指数从函数调用进来同样被拒
        "pow(2, 100000)",         # 结果约 10**30103，函数形式同样被拒
        "2**100000",              # 结果约 10**30103，超过 10**1000
        "10**1001",               # 恰好超过结果规模上限
        "2**999999999999",        # 指数远超上限
        "2**(10**6)",             # 结果约 10**301030
        "10**(10**5)",            # 结果为 10**100000
        "(9**9)**(9**9)",         # 中间结果构成超大幂，等价于 9**(9**10)
        "(10**300)**4",           # 中间结果做底数，结果约 10**1200
        "(10**500)**3",           # 同上，约 10**1500
        "(2**500)**(2**500)",     # 中间结果做指数，远超任何允许规模
        "2.0**10000",             # 浮点溢出快速失败
        "1e308 * 10",             # 浮点乘法溢出为 inf
    ],
)
def test_huge_power_and_overflow_rejected_fast(bad_expr):
    start = time.perf_counter()
    with pytest.raises(ValueError):
        safe_eval(bad_expr)
    assert time.perf_counter() - start < 2.0


def test_calculate_tool_rejects_huge_power_quickly():
    """MCP 工具层同样快速返回可读错误，而不是卡死。"""
    start = time.perf_counter()
    result = asyncio.run(calculate("9**9**9"))
    elapsed = time.perf_counter() - start
    assert "❌" in result
    assert elapsed < 2.0


def test_large_but_allowed_math_still_works():
    """白名单内的大数运算仍然可用：10^100 与合法幂组合。"""
    assert safe_eval("10**50") == 10 ** 50
    assert safe_eval("1000**10") == 10 ** 30
    assert safe_eval("99999999999 * 99999999999") == 99999999999 ** 2


def test_normal_powers_no_longer_rejected():
    """结果规模限内的普通幂不再被底数/指数的固定小上限误伤（兼容性回归）。"""
    assert safe_eval("10000**2") == 100000000
    assert safe_eval("pow(10000, 2)") == 100000000
    assert safe_eval("2**100") == 2 ** 100
    assert safe_eval("pow(2, 100)") == 2 ** 100
    assert safe_eval("10**65") == 10 ** 65
    assert safe_eval("2**1000") == 2 ** 1000
    assert safe_eval("(9**9)**9") == 9 ** 81     # 中间结果做底数，结果约 10**77
    assert safe_eval("9**(9*9)") == 9 ** 81      # 指数为表达式，结果同样在限内
    assert safe_eval("(-10000)**3") == -(10 ** 12)


def test_power_result_size_boundary():
    """恰好在 MAX_INT_MAGNITUDE = 10**1000 边界上的幂：一侧允许、一侧拒绝。"""
    assert safe_eval("10**1000") == 10 ** 1000
    with pytest.raises(ValueError, match="过大"):
        safe_eval("10**1001")
    # 2**3321 < 10**1000 < 2**3322
    assert safe_eval("2**3321") == 2 ** 3321
    with pytest.raises(ValueError, match="过大"):
        safe_eval("2**3322")


def test_special_bases_and_negative_exponents():
    """0/±1 底数与负指数的边界：结果恒为小数，不受指数上限影响。"""
    assert safe_eval("0**0") == 1
    assert safe_eval("0**7") == 0
    assert safe_eval("1**1000000000000") == 1
    assert safe_eval("(-1)**999") == -1
    assert safe_eval("(-1)**1000") == 1
    assert safe_eval("1**-3") == 1.0
    assert safe_eval("2**-10") == 1 / 1024
    assert safe_eval("2**-100") == 2 ** -100
    with pytest.raises(ValueError):              # 0 的负指数幂按除零拒绝
        safe_eval("0**-1")
    with pytest.raises(ValueError):
        safe_eval("0 ** -1000000000000")


# ---------------------------------------------------------------- 序列字面量与数值类型边界


def test_sequence_multiplication_rejected_before_allocation():
    """[1] * 1000000000 必须在内存分配前被拒，而不是先算出 8GB 列表。

    修复后结构校验先于求值，列表字面量不能参与普通二元运算。
    """
    start = time.perf_counter()
    with pytest.raises(ValueError) as excinfo:
        safe_eval("[1] * 1000000000")
    elapsed = time.perf_counter() - start

    message = str(excinfo.value)
    assert "列表" in message or "元组" in message, message
    assert elapsed < 1.0


@pytest.mark.parametrize(
    "bad_expr",
    [
        "[1] * 1000000000",       # 未限制的序列乘法（危险）
        "sum([1] * 1000000000)",  # 藏在函数参数里的序列乘法
        "[1] * 3",                # 即使规模很小也不允许参与普通运算
        "[1] + [2]",              # 列表相加
        "-[1]",                   # 列表参与一元运算
        "abs([1])",               # 非序列函数接收列表
        "sqrt([4])",              # 同上
        "[1, 2]",                 # 裸列表
        "(1, 2)",                 # 裸元组
        "sum([[1], [2]])",        # 嵌套列表
        "pow([2], 3)",            # pow 不接受列表
        "max([1, 2], [3, 4])",    # 列表只能占第一个参数位
    ],
)
def test_sequence_literals_rejected_outside_bounded_functions(bad_expr):
    start = time.perf_counter()
    with pytest.raises(ValueError):
        safe_eval(bad_expr)
    assert time.perf_counter() - start < 1.0


def test_bounded_sequences_still_work():
    """sum/min/max 的列表、元组参数仍然正常工作。"""
    assert safe_eval("sum([1, 2, 3])") == 6
    assert safe_eval("sum([1, 2], 3)") == 6
    assert safe_eval("sum((1, 2, 3))") == 6
    assert safe_eval("sum([1.5, 2.5])") == 4.0
    assert safe_eval("sum([sqrt(4), 2])") == 4.0
    assert safe_eval("min([3, 1, 2])") == 1
    assert safe_eval("max([3, 1, 2])") == 3
    assert safe_eval("min(1, 2)") == 1
    assert safe_eval("max(1, 2)") == 2


def test_sequence_length_is_bounded():
    expr = "sum([" + ",".join(["1"] * 51) + "])"
    with pytest.raises(ValueError, match="元素过多"):
        safe_eval(expr)


def test_unsupported_numeric_results_rejected():
    """负数开方等得到复数时直接报错，不把 complex 返回给调用方。"""
    with pytest.raises(ValueError, match="复数"):
        safe_eval("(-2) ** 0.5")
    with pytest.raises(ValueError, match="复数"):
        safe_eval("(-8) ** (1/3)")
    with pytest.raises(ValueError):
        safe_eval("True")
    with pytest.raises(ValueError):
        safe_eval("1 + True")


def test_float_base_power_does_not_escape():
    """带 float 底数的幂溢出必须变成可读 ValueError，不能把 OverflowError 抛给调用方。"""
    with pytest.raises(ValueError):
        safe_eval("2.0 ** 10000")
    with pytest.raises(ValueError):
        safe_eval("pow(2.0, 10000)")

    start = time.perf_counter()
    result = asyncio.run(calculate("2.0 ** 10000"))
    assert "❌" in result
    assert time.perf_counter() - start < 2.0
