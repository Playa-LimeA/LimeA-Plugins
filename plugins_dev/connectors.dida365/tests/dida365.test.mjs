import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, projectTask } from '../src/backend.mjs';

function createHarness(responder) {
  const tools = new Map();
  apply({
    tools: {
      register(name, handler) {
        tools.set(name, handler);
      },
    },
  });
  const calls = [];
  const run = {
    signal: new AbortController().signal,
    connections: {
      async request(req) {
        calls.push(req);
        return responder(req);
      },
    },
  };
  return { tools, calls, run };
}

test('filters Inbox tasks and maps Dida365 priority labels accurately', async () => {
  assert.equal(projectTask({ id: 't1', title: 'Urgent', priority: 5 }).priorityLabel, '高');
  assert.equal(projectTask({ id: 't2', title: 'Normal', priority: 0 }).priorityLabel, '无');

  const { tools, calls, run } = createHarness(async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: { id: 'inbox', name: '收集箱' },
      tasks: [
        { id: '1', projectId: 'inbox', title: '买牛奶', priority: 1 },
        { id: '2', projectId: 'inbox', title: '写设计文档', priority: 5 },
      ],
      columns: [],
    }),
  }));

  const res = await tools.get('get_project_tasks')({ priority: 5, query: '设计' }, run);
  assert.equal(calls[0].url, 'https://api.dida365.com/open/v1/project/inbox/data');
  assert.equal(res.total, 1);
  assert.equal(res.tasks[0].id, '2');
  assert.equal(res.tasks[0].priorityLabel, '高');
});

test('handles 200 empty body completion and deletion safely without JSON parse failure', async () => {
  const { tools, calls, run } = createHarness(async () => ({
    status: 200,
    headers: {},
    body: '',
  }));

  const completed = await tools.get('complete_task')({ projectId: 'inbox', taskId: 'task_1' }, run);
  assert.deepEqual(completed, { ok: true, id: 'task_1', projectId: 'inbox', status: 'completed' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, undefined);

  const deleted = await tools.get('delete_task')({ projectId: 'inbox', taskId: 'task_1' }, run);
  assert.deepEqual(deleted, { ok: true, id: 'task_1', projectId: 'inbox', status: 'deleted' });
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].body, undefined);
});

test('injects taskId into update_task body with deterministic key ordering', async () => {
  const { tools, calls, run } = createHarness(async (req) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: req.body,
  }));

  await tools.get('update_task')(
    { taskId: 'task_9', projectId: 'proj_1', title: '更新标题', priority: 3 },
    run,
  );
  assert.equal(calls[0].url, 'https://api.dida365.com/open/v1/task/task_9');
  assert.equal(
    calls[0].body,
    '{"id":"task_9","priority":3,"projectId":"proj_1","title":"更新标题"}',
  );
});
