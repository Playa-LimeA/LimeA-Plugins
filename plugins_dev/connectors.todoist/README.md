# Todoist 插件

在 LimeA 中连接 Todoist（待办与项目管理平台）账号，按项目、分区、标签或过滤语法读取任务，并在当前会话权限控制下创建、修改、完成、重开或删除任务及新建项目与评论。需要支持 `todoist-read-write` 连接权限的新版本 LimeA。

## 使用

1. 在插件市场安装并启用「Todoist」，或在开发时导入本目录的 `dist`。
2. 在「设置 → 插件」打开 Todoist 独立页面，点击「连接 Todoist」，在系统浏览器登录并同意授权。
3. 回到 LimeA，在宿主「数据访问权限」区域点击「允许插件使用」。从下一次发送消息开始，模型可调用 Todoist 工具；请求审批档位逐次确认写操作，自动审批和完全访问在已授权范围内执行。

## 能力与范围

| 工具 | 访问级别 | 说明 |
| --- | --- | --- |
| `list_tasks` | `read` | 按项目、分区、父任务、标签或 Todoist `filter` 过滤表达式分页读取活跃任务 |
| `get_task` | `read` | 读取单个任务的完整详情 |
| `list_projects` | `read` | 列出项目，或读取指定项目及其分区（Section） |
| `list_labels` | `read` | 列出个人标签 |
| `list_comments` | `read` | 分页读取指定任务或项目下的评论 |
| `create_task` | `write` | 创建新任务（支持自然语言截止日期 `due_string`、优先级、标签、项目与分区） |
| `update_task` | `write` | 修改已有任务的标题、说明、截止时间、优先级或标签 |
| `complete_task` | `write` | 完成指定任务（周期任务按 Todoist 规则自动推进到下一周期） |
| `reopen_task` | `write` | 重新打开已完成任务 |
| `delete_task` | `write` | 删除指定任务 |
| `create_project` | `write` | 创建新项目 |
| `create_comment` | `write` | 在任务或项目下发表评论 |

注意 Todoist API v1 的优先级数值与界面显示相反：`priority: 4` 对应界面最高优先级 `P1`，`priority: 1` 对应普通优先级 `P4`。插件随包携带 `skills/todoist/SKILL.md` 说明筛选表达式与字段规则。

所有请求经宿主受限代理转发至 `https://api.todoist.com/api/v1/`，插件无法读取访问令牌或刷新令牌。单次投影结果上限为 24,000 字节；写入异常中断或结果不明时先在 Todoist 核对实际结果，不自动重放。

## 开发

```sh
npm --prefix plugins_dev/connectors.todoist install
npm --prefix plugins_dev/connectors.todoist test
npm --prefix plugins_dev/connectors.todoist run build
npm run pack:plugin -- plugins_dev/connectors.todoist/dist entries/connectors.todoist.json
npm test
npm run check
```

## 授权

代码采用 [MIT 许可证](LICENSE)。Todoist 名称归 Doist Inc. 所有，本插件由 Playa 独立开发。
