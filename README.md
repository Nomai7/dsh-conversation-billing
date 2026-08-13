# dsh-conversation-billing

DSH (DeepSeek Harness) 客户端插件：按**真实 token 用量**预估当前会话的累计对话费用（人民币 ¥）。

在输入框工具行右端、发送键左侧显示一个紧凑的费用徽章：

```
[输入框工具行 ...] [ ¥4.33 ] [发送键]
```

- 徽章只显示金额（最多两位小数），token 统计交给系统自带的 stats 行（避免重复与口径不一致）
- **悬停徽章**可查看各模型分项：`模型: ¥金额（输入 X · 输出 Y）`
- 无用量时显示 `¥0.00`

## 特性

- **真实用量**：从会话事件流读取 `assistant/message` / `assistant/chunk` 的 `usage`，按 (turn, step) 去重，非估算。
- **按模型计价**：每个请求的模型来自 `request/header`，flash / pro 分价。
- **普通会话与子代理会话都支持**：自动区分 `sessions.history` 与 `subagents.history`。
- **纯客户端**：不注册 Host 服务，通过 `connection.api` 分页读取事件流，前端计价。
- **显示位置**：`conversation.input.right` 槽位（输入框工具行右端、发送键左侧），不占用额外行、不挤压系统 stats 行。

## 价目表（¥ / 1M tokens，当前）

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- |
| deepseek-v4-flash | 0.02 | 1.0 | 2.0 |
| deepseek-v4-pro | 0.025 | 3.0 | 6.0 |

计费口径：未缓存输入与缓存写入按 miss 价，缓存读取按 hit 价，输出按 output 价。

> 价格内置在 `lib/client.js` 的 `RATES` 常量中，修改后重新构建/安装即可。
> 待官方峰谷涨价（2026-08-17 生效）后，可切换为峰谷价目表。

## 安装

这是一个标准 DSH 客户端插件包（声明 `dsh.client`，导出 `./client` bundle）。

### 方式一：从 npm 安装

```bash
npm install dsh-conversation-billing
```

### 方式二：从 GitHub 安装

```bash
npm install git+https://github.com/Nomai7/dsh-conversation-billing.git
```

### 在 DSH 组合中启用

在宿主组合或 agent 预设的 `cordis.yml` 中加入一行：

```yaml
- id: billing
  name: dsh-conversation-billing
```

重启 DSH 后，打开任意会话，发送键左侧即可看到费用徽章。

## 开发

```bash
# 本地构建（如需要）
npm install
npm run build   # 若有构建脚本；当前为纯 JS，可直接使用
```

## 许可

MIT
