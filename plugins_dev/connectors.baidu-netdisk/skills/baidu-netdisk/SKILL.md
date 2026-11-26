---
name: baidu-netdisk
description: 使用百度网盘连接器插件浏览、搜索和整理授权目录（默认 /apps/<应用名>/）中的文件与文件夹。当用户提到百度网盘、网盘目录、云盘文件整理或容量查询时使用。
---

# 百度网盘连接器使用指引

## 权限与路径规则

1. **沙箱目录边界**：百度网盘个人应用默认只拥有专属应用目录 `/apps/<应用名>/`（如 `/apps/LimeA/`）的访问权限。如果用户未指定完整路径，请先调用 `list_files` 查看 `/apps` 或已知的应用根目录，确认实际目录名后再操作。
2. **路径格式**：
   - 所有路径必须以 `/` 开头，不得包含 `..`、`.` 路径段、反斜杠 `\` 或连续双斜杠 `//`。
   - 写操作路径不得以 `/` 结尾，禁止操作 `/` 与 `/apps`，且禁止删除、重命名或移动 `/apps/<应用名>` 顶层目录本身。
3. **不支持直链下载**：`get_file_metas` 仅返回文件名、大小、修改时间、分类等元数据，不返回 `dlink` 下载直链，也不支持下载或读取二进制文件内容。

## 常用工作流

1. **查看空间与目录**：
   - 查询配额：调用 `get_quota`。
   - 浏览文件：调用 `list_files({ dir: '/apps/LimeA', order: 'time', desc: true, limit: 50 })`。
   - 搜索文件：调用 `search_files({ key: '关键词', dir: '/apps/LimeA', recursion: true })`。
2. **文件整理（均需审批）**：
   - 新建目录：`create_folder({ path: '/apps/LimeA/项目资料' })`。
   - 重命名：`rename_file({ items: [{ path: '/apps/LimeA/旧名.txt', newname: '新名.txt' }] })`（`newname` 仅填新文件名，不能带 `/`）。
   - 移动/复制：`move_files` / `copy_files` 传入 `items: [{ path, dest, newname? }]`，可选 `ondup`（`fail` / `newcopy` / `overwrite` / `skip`，默认 `fail`）。
   - 删除：`delete_files({ paths: ['/apps/LimeA/待删文件.txt'] })`。删除操作不可逆（或进入网盘回收站），执行前先向用户明确列出将要删除的完整路径。
3. **错误处理**：
   - 遇到 `connection-reauthorization-required` 时，提示用户到插件详情页点击「刷新连接」或重新授权百度网盘账号。
   - 遇到 `connection-write-unknown`（如批量部分失败 `errno=12` 或网络中断）时，严禁自动重试；提示用户先到百度网盘核对实际结果并在插件详情页解除待核对阻断。
