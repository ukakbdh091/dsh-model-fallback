# dsh-model-fallback

> 模型没有回应时，就把当前会话自动切到备用模型，并在**同一步**里重试，而不是让整轮对话直接红字报错。

DeepSeek Harness 插件。备用模型可以直接在 DSH 的设置里，从模型列表里挑。

只挂在公开扩展点上（`agent/request-error`、`agent/request`、`agent/pre-step`），不改内核、不包装 adapter、不动 session 日志格式。

## 特性

- **只在模型无响应时切**：`TIMEOUT`、`TRANSPORT`、`SERVER`、`EMPTY_RESPONSE`。额度、鉴权、参数这类“模型答了、只是答的是错误”的情况不切；想放开就改 `codes`。
- **不打断这一轮**：在同一个 step 里换模型重试，用户只看到回答，看不到报错。
- **严格按列表顺序**：设置页里的第一行先试，不行再第二行，同一 step 里每个备用模型只试一次；走到链尾才把原错误交回上层。
- **会话内生效**：选择写进会话（`model/selection`），UI 的模型座位会跟着变，重开会话也记得。不改全局默认模型。
- **用户取消不算报错**：`signal` 已中止、或失败码是 `ABORTED`/`CANCELLED` 时，什么都不做。
- **三处可配**：设置页 / `~/.dsh/model-fallback.json` / profile 的 `cordis.patch.yml`，改完即生效，不用重启。

## 安装

需要 DSH 的 desktop（或任意带 settings 服务的 profile）。

### 一键安装（推荐）

在 DSH 的插件市场 / 插件管理里，直接输入包名：

```
dsh-model-fallback
```

或者在终端里一条命令：

```bash
dsh plugin --profile desktop add dsh-model-fallback
```

装完重启 Harness（或等 HMR 热重载），进 **设置 → 模型兜底** 选备用模型即可。

> 把 `desktop` 换成你实际用的 profile 名，比如 `web`。

### 从源码安装

```bash
git clone https://github.com/ukakbdh091/dsh-model-fallback.git
dsh plugin --profile desktop add ./dsh-model-fallback
```

### 验证装好了

```bash
dsh --profile desktop --dump-config | grep model-fallback
```

能看到 `id: model-fallback` 就说明挂上了。

## 配置

### A. 设置页（推荐）

**设置 → 模型兜底**：一行一个下拉，选项按 provider 分组，直接列出当前部署能选的所有模型（和输入框上的模型选择器同一份数据），选一个就同时定下 provider 和 model。至少可以放两个，不设上限。

### B. `~/.dsh/model-fallback.json`（改完即生效）

```json
{
  "fallbacks": [
    { "provider": "workbuddy-ai", "model": "deepseek-v4.1-flash" },
    { "provider": "slate", "model": "glm-5.3-flash" }
  ],
  "codes": ["TIMEOUT", "TRANSPORT", "SERVER", "EMPTY_RESPONSE"]
}
```

- `fallbacks`：按顺序尝试。当前模型不在链里时从第一个开始；在链里时就取它的下一个。
- `codes`：省略时只认无响应（`["TIMEOUT", "TRANSPORT", "SERVER", "EMPTY_RESPONSE"]`）；`["*"]` 表示任何失败都切；也可以自己列，比如只认额度：`["QUOTA", "ACCOUNT_QUOTA"]`。
- 文件不存在、格式坏掉、或 `fallbacks` 是空数组时，都退回插件配置里的链，不会报错。

### C. profile 的 `cordis.patch.yml`

```yaml
- id: model-fallback
  config:
    fallbacks:
      - provider: workbuddy-ai
        model: deepseek-v4.1-flash
    codes: ["*"]
```

**优先级**：`model-fallback.json` 里的非空 `fallbacks` > 设置页 / YAML 配置。两条路都行，别同时填。

## 判定逻辑

1. 监听每一步的模型请求失败。
2. 按 `codes` 判断该不该切：默认只认“无响应”——`TIMEOUT`、`TRANSPORT`、`SERVER`、`EMPTY_RESPONSE`。用户取消永远不切。
3. 按设置页里的顺序从上到下挑下一个还没试过的模型（同一 step 内不回头）。
4. 用 `ctx.llm.resolveCallConfig` 校验该模型在当前部署里真的存在；不存在就跳过这一格。
5. 把选择写进会话，让 loop 在同一步重试；这一次请求会打到备用模型。
6. 备用模型也失败就继续沿链往下走；链尾都没有，把原错误交回上层。

**瞬态错误仍然先由 `llm-retry` 退避重试。** 它比本插件先注册，默认对 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 重试 5 次；只有它放弃之后，失败才会落到本插件手里。所以一次普通的限流不会立刻把模型换掉。

## 一个容易踩的点

DSH 的模型选择是在 **pre-step** 的 system-prompt 组装时快照的，而失败发生在 step 进行中。只改 `selection` 的话，**同一步的重试**仍会用旧模型。所以插件在 `agent/request` 上做了一次一次性覆盖，等进入下一步就撤掉——这就是 `agent/pre-step` 那条监听的全部作用。

## 目录结构

```
dsh-model-fallback/
├── lib/index.js          宿主半边：错误监听、切换、写状态文件
├── client/client.js      浏览器半边：设置页（模型下拉）
├── cordis.patch.yml      插入 DSH 组合的补丁
├── test/
│   ├── smoke.mjs         宿主逻辑（15 项断言）
│   ├── boot.mjs          真实 cordis 装配 + Config 校验
│   └── client.mjs        客户端模块加载 + 设置页渲染
└── package.json
```

## 开发与测试

```bash
npm install     # 只有测试需要：cordis / cosmokit / schemastery
npm test
```

单独跑：

```bash
node test/smoke.mjs    # 宿主逻辑
node test/boot.mjs     # 真实 cordis 装配 + Config 校验
node test/client.mjs   # 浏览器半边：模块加载 + 设置页注册 + 下拉渲染
```

覆盖：无响应触发、额度/鉴权/限流不触发、`codes` 收窄与 `['*']` 放开、取消不触发、主模型切链头、重试请求被改写、链式推进、header 未刷新也不重复、下一步重新从链头开始、链尾交回、备用模型不可用、空链、JSON 文件覆盖、volatile 链实时生效、设置页两个空位。

插件每次装配都会写一个 `~/.dsh/model-fallback.status.json`（时间、链长度、生效的 codes、pid），用来确认它真的在跑：

```json
{ "plugin": "dsh-model-fallback", "loadedAt": "2026-10-19T11:05:16.195Z", "fallbacks": 2, "codes": ["*"], "pid": 19672 }
```

## 已知限制

- 只在 desktop profile 上实测过；其它 profile 只要带 settings 服务应该也能用。
- 设置页写的是 volatile 配置字段，依赖 DSH 的 settings 服务；如果某个版本把该字段改成非 volatile，保存会报 `Config field ... is not volatile`。
- 不会自动切回主模型——什么时候回去由你自己决定。
- 备用模型必须能用 `resolveCallConfig` 解析出来，否则会被跳过（配置里写错 provider/model 不会炸，只是不生效）。

## 许可

[MIT](./LICENSE)

---

## English

A DeepSeek Harness plugin: when the primary model stops responding, switch the current session to the next backup model **inside the same step** and retry, instead of failing the turn.

- Switches only when the model gives **no response** (`TIMEOUT`, `TRANSPORT`, `SERVER`, `EMPTY_RESPONSE`); widen it with `codes` (`['*']` = any error).
- Walks the list **top to bottom**, trying each backup once per step; when the list is exhausted the original error is rethrown.
- Never switches on user cancellation (`ABORTED` / `CANCELLED`).
- Session-scoped only; the global default model is untouched.
- Configure in **Settings → Model fallback** (model picker), in `~/.dsh/model-fallback.json`, or in the profile's `cordis.patch.yml`.

```bash
# 一行装好
dsh plugin --profile desktop add dsh-model-fallback
```

MIT licensed.
