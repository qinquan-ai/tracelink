# TraceLink 架构

[English](./architecture.md) | 简体中文

## 1. 产品分为四部分

```text
SDK -> Protocol -> Receiver -> Dashboard
```

| 部分 | 职责 | 是否跨语言共用 |
|---|---|---|
| SDK | 在应用进程内理解 span、父子关系、并发上下文与采集开关 | 否，每种语言分别实现 |
| Protocol | 定义 `TraceLog`、Header、Scope 控制与 Receiver API | 是 |
| Receiver | 接收事件、写文件、SSE 推送、保存 Scope 策略 | 是，只实现一次 |
| Dashboard | 日志、实时调用图、链路导图、时间轴 | 是，只实现一次 |



## 2. SDK 内部职责

| 目录 | 它回答的问题 |
|---|---|
| `engine/` | 一个 span 何时开始/结束，ID 怎么生成，父子关系如何继承，数据是否允许采集 |
| `runtime/` | 当前上下文存在哪里，如何跨同步调用、`await` 和并发任务保持隔离 |
| `transport/exporters/` | 已构造好的 `TraceLog` 发到哪里：内存、控制台、文件或 Receiver |
| `transport/propagators/` | 业务 HTTP Header 如何与 TraceContext 相互转换 |
| `transport/control/` | 如何接收 Receiver 推送的 Scope 采集策略 |
| `extensions/frameworks/` | 在框架生命周期的哪个时机提取、安装、恢复上下文，例如 FastAPI middleware |
| `extensions/instrumentations/` | 如何自动观察特定行为，例如浏览器 DOM 点击 |

Runtime 与 Framework Extension 不是一回事。Runtime 提供通用的上下文容器；
Extension 知道某个框架的请求何时进入、何时结束，并调用 Runtime。

## 3. 仓库目录

```text
protocol/
  schema/
  fixtures/
  CONFORMANCE.md
sdks/
  javascript/
    src/
      engine/
      runtime/{browser,node}/
      transport/{exporters,propagators,control}/
      extensions/{frameworks,instrumentations}/
    tests/
  python/
    src/tracelink/
      engine/
      runtime/
      transport/{exporters,propagators,control}/
      extensions/{frameworks,instrumentations}/
    tests/
receiver/
  service/
  hosts/{http,vite}/
  tests/
dashboard/
cli/
skills/
```

JavaScript SDK、Receiver、CLI 和内嵌 Dashboard 仍发布在一个 npm 包里。
源码目录不决定用户导入路径；`package.json#exports` 将它们映射为
`tracelink/browser`、`tracelink/node`、`tracelink/receiver/http` 等稳定入口。
Python SDK 独立发布到 PyPI，但遵守同一 Protocol。

## 4. 为什么父子关系不能交给 Receiver 推断

Receiver 看到的是网络到达顺序，不是程序真实调用栈。异步任务、并发请求、
缓冲和网络抖动都会让“先到的事件”不等于“父节点”。父 span 必须在应用进程
仍然拥有调用上下文时确定，再作为 `parentSpanId` 写入事件，或通过
`x-parent-span-id` 传给下一个进程。

因此，一个新语言的最小接入只需要构造并 POST `TraceLog`；但它只能获得手动
关联。要自动关联父子 span，还需要使用该语言的并发上下文原语实现 Engine/Runtime，
例如 Go `context.Context`、Java/Kotlin coroutine context、.NET `AsyncLocal<T>`、
Rust task-local。

## 5. 平台覆盖

| 场景 | 当前覆盖 |
|---|---|
| React / Vue / Svelte / Astro / 普通网页 | JavaScript browser runtime 可直接使用 |
| Node / Express / Nest / Electron 主进程 | JavaScript Node runtime 可使用；框架自动接入需逐个增加 Extension |
| Python / FastAPI / Starlette | Python SDK + FastAPI Extension |
| Electron 渲染进程 | JavaScript browser runtime |
| Tauri 前端 | JavaScript browser runtime；Rust 后端需要 Rust SDK 或手写最小 Exporter |
| React Native / Capacitor / Ionic | JavaScript 能运行不等于已验证；需按网络与运行时能力测试 |
| Android 原生 / iOS 原生 / Flutter / Go / Rust / Java 后端 | Protocol 与 Receiver/Dashboard 可复用，语言 SDK 尚未提供 |
| 微信等小程序 | 不能假设标准 DOM、`fetch` 和包系统可用，需要专门 Runtime/Exporter |

TraceLink 不应把“能运行 JavaScript”表述为“已经支持该平台”。只有运行时、
网络 API、上下文隔离和构建产物都验证通过后，才算正式覆盖。

## 6. 测试所有权

测试跟随被测边界，而不是统一堆在仓库根目录：JavaScript Engine、Runtime、
Exporter 与 Propagator 的测试位于 `sdks/javascript/tests/`；Receiver 路由、
持久化、SSE 与端口生命周期测试位于 `receiver/tests/`；Python SDK 使用
`sdks/python/tests/`。跨包发布验证由根目录脚本编排。详见[测试说明](./testing.zh-CN.md)。
