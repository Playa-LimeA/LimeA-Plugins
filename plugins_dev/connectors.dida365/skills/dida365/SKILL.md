---
name: dida365
description: 使用滴答清单（国内版 Dida365）连接器查询和管理收集箱、清单与任务时的字段约定、优先级映射与全量更新注意事项。调用 connectors.dida365 工具前阅读。
---

# 滴答清单使用指南

## 1. 收集箱（Inbox）与清单

- `list_projects` 仅返回用户自建清单，**不包含收集箱**。
- 读取收集箱中的待办任务时，直接调用 `get_project_tasks({ projectId: "inbox" })`（或省略 `projectId`，默认即 `"inbox"`）。
- `update_project` 与 `delete_project` 不可用于 `"inbox"`。

## 2. 优先级映射

滴答清单 Open API v1 的 `priority` 仅接受以下四个整数：

| 数值 | 含义 |
| --- | --- |
| `0` | 无优先级（默认） |
| `1` | 低优先级 |
| `3` | 中优先级 |
| `5` | 高优先级 |

## 3. 日期时间格式

`startDate` 与 `dueDate` 使用带时区偏移的 ISO 8601 格式，例如北京时间：`2026-12-01T18:00:00+0800`。全天任务可设置 `isAllDay: true`。

## 4. `update_task` 为全量更新（重要）

- 滴答清单的 `POST /open/v1/task/{taskId}` 采用**整条替换语义**，未传入的字段可能被清空。
- 修改已有任务前，**必须先调用 `get_task({ projectId, taskId })` 读取完整字段**，仅改动目标属性后将完整字段传给 `update_task`。
- 若写操作返回 `connection-write-unknown` 或 `connection-write-in-progress`，表示上游结果待核对，**切勿自动重发**，请先提示用户在滴答清单核对并在插件详情页解除阻断。
