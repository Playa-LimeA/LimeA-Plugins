---
name: todoist
description: 使用 Todoist 连接器查询、筛选和管理待办任务、项目、分区、标签与评论时的参数约定、过滤语法和优先级映射指南。调用 connectors.todoist 工具前阅读。
---

# Todoist 任务管理指南

## 1. 优先级映射（重要）

Todoist API v1 的 `priority` 整数与客户端界面上的 `P1`–`P4` 顺序相反：

| 用户表述 / 界面显示 | API `priority` 数值 |
| --- | --- |
| `P1`（最高 / 紧急） | `4` |
| `P2`（高） | `3` |
| `P3`（中） | `2` |
| `P4`（普通 / 默认） | `1` |

返回结果中同时提供 `priority`（API 数值 `1..4`）和 `priorityLabel`（`P1..P4`），创建或更新任务时请按上表传入 `1..4`。

## 2. 查询与过滤语法（`list_tasks`）

- 查看今天或已逾期任务：`list_tasks({ filter: "today | overdue" })`
- 查看未来 7 天：`list_tasks({ filter: "7 days" })`
- 查看无截止日期任务：`list_tasks({ filter: "no date" })`
- 按优先级与标签组合：`list_tasks({ filter: "p1 & @work" })`
- 按项目或分区精确列举：优先先调用 `list_projects` 获取 `project_id` / `section_id`，再传给 `list_tasks({ project_id, section_id })`。
- 结果包含 `nextCursor` 时，使用原条件加 `cursor: nextCursor` 翻页；若遇到 `connection-result-too-large`，减小 `limit` 重试。

## 3. 创建与修改写入原则

- 自然语言日期使用 `due_string`（例如 `"tomorrow at 18:00"`、`"every friday"`、`"明天下午3点"`）；固定日期使用 `due_date`（`YYYY-MM-DD`）。
- 完成周期性任务请使用 `complete_task`（自动推进到下一周期），不要使用 `delete_task`。
- 若写操作返回 `connection-write-unknown` 或 `connection-write-in-progress`，表示上游执行结果待核对，**切勿自动重试提交相同写入**，应提示用户先在 Todoist 核对并在插件详情页确认解除。
