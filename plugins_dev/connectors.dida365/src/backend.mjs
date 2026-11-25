const baseUrl = 'https://api.dida365.com/open/v1/';
const operations = [
  'list_projects',
  'get_project_tasks',
  'get_task',
  'create_task',
  'update_task',
  'complete_task',
  'delete_task',
  'create_project',
  'update_project',
  'delete_project',
];

const priorityLabels = { 0: '无', 1: '低', 3: '中', 5: '高' };

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortedJson(child)]),
    );
  }
  return value;
}

function truncateText(text, max = 2000) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

export function projectTask(raw) {
  const priority = typeof raw.priority === 'number' ? raw.priority : 0;
  const content = truncateText(raw.content ?? '', 2000);
  return {
    id: String(raw.id),
    projectId: raw.projectId ? String(raw.projectId) : 'inbox',
    title: String(raw.title ?? ''),
    content: content.text,
    ...(content.truncated ? { contentTruncated: true } : {}),
    desc: truncateText(raw.desc ?? '', 500).text,
    priority,
    priorityLabel: priorityLabels[priority] ?? '无',
    isAllDay: Boolean(raw.isAllDay),
    startDate: raw.startDate ?? null,
    dueDate: raw.dueDate ?? null,
    timeZone: raw.timeZone ?? null,
    repeatFlag: raw.repeatFlag ?? null,
    status: raw.status ?? 0,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    items: Array.isArray(raw.items)
      ? raw.items.slice(0, 50).map((item) => ({
          id: item.id ? String(item.id) : null,
          title: String(item.title ?? ''),
          status: item.status ?? 0,
        }))
      : [],
  };
}

export function projectList(raw) {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    color: raw.color ?? null,
    viewMode: raw.viewMode ?? 'list',
    kind: raw.kind ?? 'TASK',
    closed: Boolean(raw.closed),
  };
}

export function apply(ctx) {
  for (const name of operations) {
    ctx.tools.register(name, async (input = {}, run) => {
      if (!run.connections) throw new Error('connection-access-denied');

      async function request(path, method = 'GET', body = undefined) {
        run.signal.throwIfAborted();
        const response = await run.connections.request({
          provider: 'dida365',
          url: baseUrl + path,
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sortedJson(body)),
              }),
        });
        if (response.status === 204 || !response.body.trim()) return null;
        return JSON.parse(response.body);
      }

      let result;
      if (name === 'list_projects') {
        const list = await request('project');
        result = {
          projects: (Array.isArray(list) ? list : []).map(projectList),
          inboxHint: 'Use projectId="inbox" in get_project_tasks to inspect Inbox tasks.',
        };
      } else if (name === 'get_project_tasks') {
        const projectId = input.projectId || 'inbox';
        const data = await request('project/' + encodeURIComponent(projectId) + '/data');
        let tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        if (input.query) {
          const needle = String(input.query).trim().toLowerCase();
          tasks = tasks.filter(
            (item) =>
              String(item.title ?? '')
                .toLowerCase()
                .includes(needle) ||
              String(item.content ?? '')
                .toLowerCase()
                .includes(needle),
          );
        }
        if (input.priority !== undefined)
          tasks = tasks.filter((item) => (item.priority ?? 0) === input.priority);
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 20;
        const page = tasks.slice(offset, offset + limit).map(projectTask);
        result = {
          project: data?.project ? projectList(data.project) : { id: projectId, name: projectId },
          columns: Array.isArray(data?.columns)
            ? data.columns.map((col) => ({ id: String(col.id), name: String(col.name ?? '') }))
            : [],
          total: tasks.length,
          tasks: page,
          nextOffset: offset + page.length < tasks.length ? offset + page.length : null,
        };
      } else if (name === 'get_task') {
        result = projectTask(
          await request(
            'project/' +
              encodeURIComponent(input.projectId) +
              '/task/' +
              encodeURIComponent(input.taskId),
          ),
        );
      } else if (name === 'create_task') {
        result = projectTask(await request('task', 'POST', input));
      } else if (name === 'update_task') {
        const { taskId, ...rest } = input;
        result = projectTask(
          await request('task/' + encodeURIComponent(taskId), 'POST', { id: taskId, ...rest }),
        );
      } else if (name === 'complete_task') {
        await request(
          'project/' +
            encodeURIComponent(input.projectId) +
            '/task/' +
            encodeURIComponent(input.taskId) +
            '/complete',
          'POST',
        );
        result = { ok: true, id: input.taskId, projectId: input.projectId, status: 'completed' };
      } else if (name === 'delete_task') {
        await request(
          'project/' +
            encodeURIComponent(input.projectId) +
            '/task/' +
            encodeURIComponent(input.taskId),
          'DELETE',
        );
        result = { ok: true, id: input.taskId, projectId: input.projectId, status: 'deleted' };
      } else if (name === 'create_project') {
        result = projectList(await request('project', 'POST', input));
      } else if (name === 'update_project') {
        const { projectId, ...rest } = input;
        result = projectList(
          await request('project/' + encodeURIComponent(projectId), 'POST', rest),
        );
      } else if (name === 'delete_project') {
        await request('project/' + encodeURIComponent(input.projectId), 'DELETE');
        result = { ok: true, id: input.projectId, status: 'deleted' };
      }

      if (Buffer.byteLength(JSON.stringify(result)) > 24000)
        throw new Error('connection-result-too-large');
      return result;
    });
  }
}
