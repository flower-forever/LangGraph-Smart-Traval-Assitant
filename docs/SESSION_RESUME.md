# 本机工作进度留存（opt-in 会话恢复）

## 这是什么

`frontend/src/lib/sessionRestore.ts` + `frontend/src/components/SessionResumePanel.tsx` 实现的
**默认关闭**的本机工作进度留存：用户显式点「在此浏览器保留工作进度」启用后，
页面把当前工作快照有界自动写到本浏览器 localStorage 的独立键；下次打开先展示待恢复概况，
用户点「恢复」才替换当前页面。全程只读本机存储，不联网、不同步设备。

## 键与格式

- 启用 flag：`travel-assistant:session-resume:enabled:v1`，值 `'1'` 才算启用。
- 数据键：`travel-assistant:session-resume:data:v1`，单记录 envelope：
  `{ format: 'travel-assistant.session-resume', version: 1, savedAt, session }`。
- `session` 为纯数据投影：`trip`（完整 Trip）、`draft`（forkTripId + newLegMode + editedDays，无未应用差异时为 null）、
  `budget`（binding: current/stale/unbound + budgetRaw + rows 原字符串）、
  `ui`（activeDay/draftMode/openedFromFile 三态：true 文件、false 明确页面内、null 旧记录未知）。
  缺字段或 null 在再次留存时仍写回 null，不会降成 false 冒充已确认非文件。
- 正式保存键 `travel-assistant:saved-trips:v1` 永不由本功能读写；关闭/删除留存不影响任何已保存行程或备份文件。

## 门禁与失败语义（全部 fail-closed、保旧）

- 写：整包 UTF-8 ≤ 1.5 MiB；Trip 部分沿用本地保存单份口径（640 KiB，id+savedAt+trip）。
  640 KiB 只是本地保存/留存的记录口径，**不是** createTripDraft / applyDraft 的输入上限。
- 读：超过读限（1.5 MiB + 64 KiB）或坏 JSON → `corrupt`；format/version 不符 → `unknown_version`；
  顶层或块级未知字段、结构校验失败 → `invalid`。三者都**原样保留 raw**、不提供恢复入口，
  只能显式「删除本机恢复副本」或等后续修复。
- 写失败（quota / SecurityError / too_large / 冲突）→ 停止自动写 + 显式提示，旧副本原样。
- localStorage getter 本身抛异常/返回 null → 明确显示“存储不可用、留存未启用”，点击启用只重试获取并继续提示；不会假装已启用。
- 删除同样 compare-then-remove：确认前按该界面冻结 raw 引导，确认时再比对；外部已换副本则拒绝删除、双方原样。
- 损坏/异常数据绝不部分恢复、不降级成空内容；金额的非法字符串是手工中间态，唯一不判异常的例外。

## 跨标签

写前重读与冻结 expectedRaw 比对 + storage 事件触发冲突暂停。冻结值来自产出 pending/empty 的那一次
读取（load 同时返回实际解析 raw，empty 也带当次 null/空串/空白），App 不再二次读取换基准；
恢复/放弃动作前再严格比对；外部已改则拒绝动作、双方数据不变，不靠二次 getItem 刷新基准。读比对 + 单次 setItem **不是原子 CAS**：本功能不承诺事务或任何未测量的
竞态窗口上界；检测到冲突即停写，接管只在用户显式操作后发生。

同页静默 flag 关闭（恢复 Minor）：同页 DevTools/扩展把启用 flag 置为非 '1' 不会派发 storage 事件（该事件本就不送达写入方页面），UI 不即时变化；只有在下一次既有自动写尝试检测到 flag 不为 '1' 时，本标签 UI 向下同步为 off 并停写，原 raw、当前 Trip/草稿/费用与 hasStoredData 原样，不写 flag、不读内容键、不删、不自动恢复或保存。外部再把 flag 置回 '1'（同样无事件）不会自动复活本标签，只有用户显式启用才重新读取 pending；不新增轮询、定时器、storage 拦截或自定义事件，也不声称同页写入可即时侦测。

## 恢复语义

- pending 概况先展示（标题/天数/草稿有无/费用条数/保存时间 + 未向服务器核对声明），
  期间自动写整体暂停，示例、新规划、导入文件或恢复已保存行程都只进内存，
  不能覆盖待恢复副本；只有显式恢复或确认放弃恢复才移交/替换。
- 显式恢复：取消全部在飞请求并推进序号（迟到 example/plan 不覆盖），草稿经
  `createTripDraft` + 组合投影 `checkTripShape` 重建（editedDays 每天恰有一个整天块且天号匹配，
  changedDays 由 `draftChangedDays` 重导，history 不留恢复），费用 current 按新会话 revision 重绑、
  stale 保持失配只读（沿用/新建后才能编辑）。
- 恢复不是保存：不写正式保存键，不显示「已保存」时间戳（`restoredAt` 不用于留存恢复）。
  来源只按快照 `openedFromFile` 自述展示；来自备份文件的进度恢复后仍标注「未向服务器核对」，
  旧记录缺来源字段时保守按未知处理，不冒充应用内生成；恢复后继续编辑/应用/留存仍保持未知，
  卸载重载后仍显示来源未知。只有用户明确打开文件或新生成/恢复已知来源时才写 true/false。
- 「放弃恢复并开始留存」需内联确认，会用当前页面内容覆盖副本；「关闭保留」只停写保数据；
  「删除本机恢复副本」独立内联确认，只删数据键。删除成功后自动留存保持暂停并明示重新开启路径，
  不会在同一过渡里立即重建副本；删除成功是独立暂停状态，不再显示“原始数据已原样保留”，
  只有写失败/冲突等真正保旧的失败才显示该提示。
- 关闭后的副本管理（Important 修复）：
  - 自动写成功即同步 `hasStoredData=true`（用写入结果 `writtenRaw` 作基准，不二次读存储），
    同页「关闭保留」后删除入口不丢失，可两步删除已知副本。
  - off（含关闭后 reload）默认仍零内容键读取：只显示「检查本机恢复副本」入口，
    点击才用严格读取拿一次 raw。检查不启用 flag、不写/删存储、不解析恢复、不改 Trip/草稿/费用；
    每次检查推进 management generation，检查打开的旧删除确认随之失效（防 ABA、静默换 B）。
  - 检查结果三分：null →「未找到」；任何存在 raw（空串/空白/坏 JSON/异版本均算）→ 冻结该 raw
    为可管理候选并作为删除 prepare 的比对基准，可独立两步删除；读取异常 → 诚实报错
    （不假称存在或未找到），存储原样可重试。
  - 删除仍走 prepare/confirm 两次严格比对冻结 raw；外部静默换 B 在 prepare 前或 confirm 前
    都拒绝删除、双方数据不变，off→off 候选变化不会复用旧确认。

## 明确不保留

草稿撤销历史（history）、编辑器未提交的单站表单输入（dirty 期间自动写暂停并提示）、
编辑器三个偏好（每日站数上限 / 结束时间 / 步行距离）、AI 候选与检查结论、天气/资料查询结果、
撤销应用快照、在途请求（不重放、不请求上游）。启用后面板帮助文案与上述一致，不声称刷新不丢任何输入。

## 测试

- `src/__tests__/sessionRestore.test.ts`：flag/envelope/门禁/协议/重建/删除与结构隔离、Trip 写前校验共 49 例。
- `src/__tests__/AppSessionRestoreIntegration.test.tsx`：App 接线 37 例（off 零写、启用写、
  pending 不被示例覆盖、迟到响应不覆盖恢复、草稿不自动应用、费用 current/stale、关闭/删除、
  损坏保旧、跨标签停写与外部开启不复活、文件来源与 legacy 未知三态、dirty 输入与提交后继续留存、
  无事件外部写恢复/放弃 CAS、empty 双读取窗口、读取异常安全、存储 getter 不可用重试、
  删除 compare-then-remove、prepare 成功后的确认窗口内外部静默写入（合法 pending 与损坏基线）、
  pending 期间导入/已保存恢复保原 raw、写成功关闭后删除入口、off 零读取→显式检查→独立删除、
  null/空/坏/异版本检查区分、检查零副作用、检查后静默 B 两窗口拒删、SecurityError 诚实反馈可重试、
  检查推进确认身份 ABA 不复用、同页静默 flag 关闭后下一次写尝试向下同步 off 且外部回 1 不复活、显式启用才恢复 pending 读取）；
  另有 `SessionResumePanel.test.tsx`：确认身份 1 例 + off 检查入口与检查身份 epoch 2 例。

## 恢复结构隔离与写入校验

恢复重建通过组合已编辑日与未编辑日，再由 `createTripDraft` 创建可编辑结构副本。
day、stop、location 和 leg 对象与原始留存记录独立；geometry 数组及其中的坐标点
沿用现有只读共享约定。草稿的 `base` 仍是原始 Trip，作为放弃、应用和差异比较的
只读基准；`changedDays`、撤销历史、fork 和出行方式的语义保持不变。

写入前对 Trip 使用读端的 `checkTripShape` 规则：会话投影发现非法 Trip 时返回
null，调用方沿既有失败路径暂停留存；直接写入函数则在总体积和单 Trip 体积门禁
之后，检查实际序列化内容里的 Trip，失败返回 `snapshot_failed`，保留旧副本。
总体积、单 Trip 体积超限仍返回 `too_large`，不改变原有错误分类。

这次新增的写入结构校验仅覆盖 Trip，不是整包恢复协议的完整写前校验。
draft、budget 和 UI 块仍沿用既有投影与读端验证规则；直接构造不符合这些规则的
payload，仍可能写出随后被读端判为 invalid 的记录。本次不新增 schema 字段，
不改变旧备份或恢复副本的读取协议。
