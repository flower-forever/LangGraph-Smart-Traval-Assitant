# config_preflight —— 离线部署配置预检

一个不联网、不启动服务、不读 `.env` 的静态配置检查工具。部署前跑一遍，
能对端口、key、CORS 这几类静态配置给出报告。工具本身不做耗时操作，
但运行时间取决于环境，不做任何具体时长的承诺。

## 它做什么、不做什么

**做：**

- 接收一个显式传入的 env Mapping（或 CLI 读取进程环境），只读不改；
- 输出结构化报告（JSON 可序列化）：稳定检查 `code`、`severity`
  （info / warning / error）、`ok`、可操作的 `remediation` 建议；
- 端口合法性（非整数 / 0 / 越界 / 特权端口）、非回环 host、
  三个 API key 的有无、CORS_ORIGINS 的几种口径；
- 报告里不含任何配置原值：key 不出现，未验证过的 host/port/origin
  原文也不拼进错误信息，所以报告可以直接进日志或工单。

**不做（边界）：**

- 不发起任何网络请求，不做端口扫描，不探测服务是否真的在跑；
- 不读取 `.env` 文件，不导入 `api_server` 等应用模块，不触发
  FastAPI / MCP / 模型 / 地图 / 天气调用；
- 不验证 key 的有效性——「已配置」只表示「环境里有这个值」，
  报告措辞是「已配置，未验证」，不代表服务可用；
- 不检查端口是否已被占用、host/origin 值是否合法可达，
  「无配置错误」仅指本次静态检查范围内的检查项都通过；
- 不修改任何运行时行为：本工具是旁路诊断，预检通过不等于服务配置正确，
  最终以服务器启动日志和运行时表现为准。

## CLI 用法

```bash
# 检查当前进程环境（默认；只读 os.environ，不读 .env）
python config_preflight.py

# 全空配置：看默认口径（默认 host/port、缺 key 的降级说明）
python config_preflight.py --empty-env

# 内置纯假示例配置：演示自定义端口、空 CORS、占位 key 等提示
python config_preflight.py --example

# JSON 输出（可与其他开关组合）
python config_preflight.py --empty-env --json
```

参数 `--empty-env` 与 `--example` 互斥；都不传时读进程环境。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 无 error（允许 warning / info）。缺 key 属于功能降级 warning，不影响退出码 |
| 2 | 存在配置 error（如端口非整数、越界），需要修复后再启动 |

这样设计的原因：只有浏览内置示例行程时，三个 key 全缺也能正常用服务；
如果缺 key 就非零退出，会让人误以为「示例预览必失败」。

## 检查项与报告结构

报告顶层字段：`tool` / `version`（报告格式版本，当前 1）/ `tool_version` /
`ok` / `counts`（error、warning、info、total）/ `summary` / `exit_code` /
`checks`。每条 check 结构：

```json
{
  "code": "API_PORT_NOT_INTEGER",
  "severity": "error",
  "ok": false,
  "message": "……",
  "remediation": "……"
}
```

`code` 是稳定标识（可被脚本/CI 依赖），当前全集：

| code | severity | 触发条件 |
| --- | --- | --- |
| `API_HOST_DEFAULT` | info | 未设置 API_HOST（默认 127.0.0.1） |
| `API_HOST_NOT_LOOPBACK` | warning | 设置了非回环地址；提示现行服务无认证/限流，仅描述现状，不新增防护 |
| `API_PORT_DEFAULT` | info | 未设置 API_PORT（默认 8000，与 Vite 代理一致） |
| `API_PORT_NOT_INTEGER` | error | 值不是整数；服务器现行行为是静默回退 8000，改端口意图失效 |
| `API_PORT_OUT_OF_RANGE` | error | 0、负数或 >65535；0 会让操作系统随机选端口 |
| `API_PORT_PRIVILEGED` | warning | 1-1023，非管理员可能无权监听 |
| `API_PORT_VITE_PROXY_MISMATCH` | warning | 非默认端口；Vite 开发代理写死 127.0.0.1:8000，需 VITE_API_BASE |
| `DASHSCOPE_API_KEY_MISSING` | warning | 缺失；/chat 与 /api/trips/plan 不可用（503），示例行程不受影响，服务仍能启动 |
| `DASHSCOPE_API_KEY_PLACEHOLDER` | warning | 值疑似占位符 |
| `DASHSCOPE_API_KEY_CONFIGURED_UNVERIFIED` | info | 已配置，未验证 |
| `AMAP_API_KEY_*`（同上三态） | 同上 | 缺失时真实坐标/导航降级（map_status 为 no_key），文字行程仍可用 |
| `OPENWEATHER_API_KEY_*`（同上三态） | 同上 | 缺失时仅天气 MCP 工具不可用 |
| `CORS_ORIGINS_UNSET_DEFAULT` | info | 未设置；默认 6 个本机 origin（5173/5181/5182 的 127.0.0.1 与 localhost） |
| `CORS_ORIGINS_EMPTY_FAIL_CLOSED` | warning | 显式空值；现行行为 fail-closed，跨域浏览器写请求被拒 |
| `CORS_ORIGINS_SET_OVERRIDE` | info | 已设置；逗号分隔列表是整体覆盖而非追加，改后需重启 |

## 口径依据与边界声明

以上「服务器现行行为」的描述均以 `api_server.Configuration`
（`API_PORT` 非法回退 8000、`_resolve_cors_origins` 的三态、
`DEFAULT_CORS_ORIGINS`、非回环监听警告）与项目 README 的对应章节为证据。
本工具与服务器各自独立实现读取逻辑，没有共享代码；如果将来
`api_server` 改了这些行为，需要同步更新本工具与测试（见下方
「行为漂移防护」）。

### 行为漂移防护

由于没有共享代码，「同步更新」靠的是测试对口径本身的显式断言，
而不是自动差分。当前测试锁住的口径包括：

- `test_integer_with_underscores_matches_server_int_parsing`：
  `int()` 接受 `8_000` 这类下划线写法，预检与服务器同口径不误报；
- `test_non_integer_port_is_error_and_no_raw_echo` 等：
  非法/越界端口为 error，且原值不回显；
- key 三态（缺失/占位符/已配置未验证）的 severity 与措辞约束；
- CORS 三态（默认/显式空/覆盖）的 severity 与语义措辞。

若 `api_server` 的解析或 CORS 行为发生变化，这些测试会因口径断言
被破坏而失败，提醒同步更新本工具；但不会自动感知服务器源码变化，
更新服务器行为时请人工核对上面列出的测试。

CORS 提示只复述现行的默认/覆盖/fail-closed 语义，不含一套独立的
来源授权算法，也不改变应用行为。

## 安全说明

- 报告、文本渲染、CLI 输出均不含 key 值、原始 env mapping 或任何
  可能含凭据的配置原文；测试用明显假的哨兵值覆盖 text/JSON 路径。
- 非整数/越界的 port 原文不拼进错误信息；未验证的 host 原文同样不回显。
- CLI 默认模式只读取本工具用到的 6 个环境键（`PREFLIGHT_ENV_KEYS`），
  不复制整个 `os.environ`，宿主环境里的其他变量不会进入本工具。
- `--example` 的示例 key 是 `example-*-key-0001` 形式的假值，
  报告口径与真实 key 相同：按「已配置，未验证」（`CONFIGURED_UNVERIFIED`）
  处理而不是 `PLACEHOLDER`——它不匹配占位符集合，这个提示本身
  也演示了「存在但未验证」的语义。输出中不会出现假 key 的值。

## 测试

```bash
.venv/Scripts/python.exe -m pytest tests/test_config_preflight.py -v
```

测试全部离线：空配置、显式默认值、自定义端口、非法/越界/0 端口、
缺 key 降级、已配置未验证、占位符、非回环 host、CORS 三态、
输入不被修改、带 guard 的子进程无 socket/无应用导入/无 .env 读取、
默认模式只读白名单键、假 secret 不泄漏、
CLI JSON 与退出码。

## 与服务器的职责边界（一句话版）

预检回答「配置写得对不对、缺什么、改端口会不会踩坑」；
服务器启动日志回答「实际监听在哪、CORS 实际放行了谁」。两者互不替代。

## 中文 Windows 控制台的显示问题

报告措辞是中文，程序以 UTF-8 写出。在默认代码页为 GBK 的控制台
直接运行可能看到乱码：这是终端解码与程序输出编码不一致，
不是 CLI 的缺陷，JSON 内容与退出码不受影响。处理方式：

- 程序侧：设置 `PYTHONIOENCODING=utf-8`，让 Python 稳定以 UTF-8 写出；
- 终端侧：`chcp 65001` 或使用 Windows Terminal / VS Code 终端，
  让解码端也是 UTF-8；
- 程序化捕获输出时（如 `subprocess` + `text=True`），
  显式传 `encoding="utf-8"`，否则父进程会用系统默认编码（GBK）解码，
  中文变空或乱码——本项目测试就是这么处理的。

不要为这个问题改全局 locale 或系统代码页。
