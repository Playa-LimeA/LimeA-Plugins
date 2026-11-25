const baseUrl = 'https://api.todoist.com/api/v1/';
const operations = [
  'list_tasks',
  'get_task',
  'list_projects',
  'list_labels',
  'list_comments',
  'create_task',
  'update_task',
  'complete_task',
  'reopen_task',
  'delete_task',
  'create_project',
  'create_comment',
];

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
  if (typeof text !== 'string') return '';
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

export function projectTask(raw) {
  const priority = typeof raw.priority === 'number' ? raw.priority : 1;
  const desc = truncateText(raw.description ?? '', 2000);
  return {
    id: String(raw.id),
    content: String(raw.content ?? ''),
    description: desc.text,
    ...(desc.truncated ? { descriptionTruncated: true } : {}),
    projectId: raw.project_id ? String(raw.project_id) : null,
    sectionId: raw.section_id ? String(raw.section_id) : null,
    parentId: raw.parent_id ? String(raw.parent_id) : null,
    priority,
    priorityLabel: priority >= 1 && priority <= 4 ? `P${5 - priority}` : 'P4',
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    due: raw.due
      ? {
          date: raw.due.date ?? null,
          datetime: raw.due.datetime ?? null,
          string: raw.due.string ?? null,
          isRecurring: Boolean(raw.due.is_recurring),
        }
      : null,
    deadline: raw.deadline?.date ?? null,
    isCompleted: Boolean(raw.checked ?? raw.is_completed),
    url: raw.url ?? null,
  };
}

export function projectProject(raw) {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    description: truncateText(raw.description ?? '', 500).text,
    parentId: raw.parent_id ? String(raw.parent_id) : null,
    color: raw.color ?? null,
    isFavorite: Boolean(raw.is_favorite),
    isInboxProject: Boolean(raw.inbox_project ?? raw.is_inbox_project),
    viewStyle: raw.view_style ?? 'list',
  };
}

function unpackPage(payload) {
  if (Array.isArray(payload)) return { items: payload, nextCursor: null };
  return {
    items: Array.isArray(payload?.results) ? payload.results : [],
    nextCursor: payload?.next_cursor ?? null,
  };
}

export function apply(ctx) {
  for (const name of operations) {
    ctx.tools.register(name, async (input = {}, run) => {
      if (!run.connections) throw new Error('connection-access-denied');

      async function request(path, method = 'GET', body = undefined) {
        run.signal.throwIfAborted();
        const response = await run.connections.request({
          provider: 'todoist',
          url: baseUrl + path,
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sortedJson(body)),
              }),
        });
        if (response.status === 204 || response.body === '') return null;
        return JSON.parse(response.body);
      }

      let result;
      if (name === 'list_tasks') {
        const params = new URLSearchParams();
        params.set('limit', String(input.limit ?? 20));
        if (input.cursor) params.set('cursor', input.cursor);
        if (input.filter) {
          params.set('query', input.filter.trim());
          if (input.lang) params.set('lang', input.lang.trim());
          const page = unpackPage(await request('tasks/filter?' + params.toString()));
          result = { tasks: page.items.map(projectTask), nextCursor: page.nextCursor };
        } else {
          for (const key of ['project_id', 'section_id', 'parent_id', 'label', 'ids']) {
            if (input[key]) params.set(key, String(input[key]).trim());
          }
          const page = unpackPage(await request('tasks?' + params.toString()));
          result = { tasks: page.items.map(projectTask), nextCursor: page.nextCursor };
        }
      } else if (name === 'get_task') {
        result = projectTask(await request('tasks/' + encodeURIComponent(input.taskId)));
      } else if (name === 'list_projects') {
        if (input.projectId) {
          const project = projectProject(
            await request('projects/' + encodeURIComponent(input.projectId)),
          );
          const sectionParams = new URLSearchParams({
            project_id: input.projectId,
            limit: String(input.limit ?? 50),
          });
          if (input.cursor) sectionParams.set('cursor', input.cursor);
          const sectionsPage = unpackPage(await request('sections?' + sectionParams.toString()));
          result = {
            project,
            sections: sectionsPage.items.map((item) => ({
              id: String(item.id),
              name: String(item.name ?? ''),
              order: item.section_order ?? item.order ?? 0,
            })),
            nextCursor: sectionsPage.nextCursor,
          };
        } else {
          const params = new URLSearchParams({ limit: String(input.limit ?? 30) });
          if (input.cursor) params.set('cursor', input.cursor);
          const page = unpackPage(await request('projects?' + params.toString()));
          result = { projects: page.items.map(projectProject), nextCursor: page.nextCursor };
        }
      } else if (name === 'list_labels') {
        const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
        if (input.cursor) params.set('cursor', input.cursor);
        const page = unpackPage(await request('labels?' + params.toString()));
        result = {
          labels: page.items.map((item) => ({
            id: String(item.id),
            name: String(item.name ?? ''),
            color: item.color ?? null,
            isFavorite: Boolean(item.is_favorite),
          })),
          nextCursor: page.nextCursor,
        };
      } else if (name === 'list_comments') {
        if (Boolean(input.task_id) === Boolean(input.project_id))
          throw new Error('connection-invalid-read');
        const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
        if (input.task_id) params.set('task_id', input.task_id);
        if (input.project_id) params.set('project_id', input.project_id);
        if (input.cursor) params.set('cursor', input.cursor);
        const page = unpackPage(await request('comments?' + params.toString()));
        result = {
          comments: page.items.map((item) => {
            const content = truncateText(item.content ?? '', 2000);
            return {
              id: String(item.id),
              content: content.text,
              ...(content.truncated ? { contentTruncated: true } : {}),
              postedAt: item.posted_at ?? null,
            };
          }),
          nextCursor: page.nextCursor,
        };
      } else if (name === 'create_task') {
        result = projectTask(await request('tasks', 'POST', input));
      } else if (name === 'update_task') {
        const { taskId, ...fields } = input;
        result = projectTask(
          await request('tasks/' + encodeURIComponent(taskId), 'POST', fields),
        );
      } else if (name === 'complete_task') {
        await request('tasks/' + encodeURIComponent(input.taskId) + '/close', 'POST');
        result = { ok: true, id: input.taskId, status: 'completed' };
      } else if (name === 'reopen_task') {
        await request('tasks/' + encodeURIComponent(input.taskId) + '/reopen', 'POST');
        result = { ok: true, id: input.taskId, status: 'reopened' };
      } else if (name === 'delete_task') {
        await request('tasks/' + encodeURIComponent(input.taskId), 'DELETE');
        result = { ok: true, id: input.taskId, status: 'deleted' };
      } else if (name === 'create_project') {
        result = projectProject(await request('projects', 'POST', input));
      } else if (name === 'create_comment') {
        const created = await request('comments', 'POST', input);
        result = {
          id: String(created.id),
          content: truncateText(created.content ?? '', 2000).text,
          postedAt: created.posted_at ?? null,
        };
      }

      if (Buffer.byteLength(JSON.stringify(result)) > 24000)
        throw new Error('connection-result-too-large');
      return result;
    });
  }
}
