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

test('projects Todoist priority scale and filter queries accurately', async () => {
  assert.equal(projectTask({ id: '1', content: 'Urgent', priority: 4 }).priorityLabel, 'P1');
  assert.equal(projectTask({ id: '2', content: 'Normal', priority: 1 }).priorityLabel, 'P4');

  const { tools, calls, run } = createHarness(async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      results: [{ id: 't1', content: 'Ship plugin', priority: 4, labels: ['limea'] }],
      next_cursor: 'cur_2',
    }),
  }));

  const res = await tools.get('list_tasks')({ filter: 'today | overdue', limit: 10 }, run);
  assert.equal(
    calls[0].url,
    'https://api.todoist.com/api/v1/tasks/filter?limit=10&query=today+%7C+overdue',
  );
  assert.equal(calls[0].method, 'GET');
  assert.equal(res.nextCursor, 'cur_2');
  assert.equal(res.tasks[0].priorityLabel, 'P1');
});

test('handles 204 bodyless completion, reopen and deletion without JSON parse failures', async () => {
  const { tools, calls, run } = createHarness(async () => ({
    status: 204,
    headers: {},
    body: '',
  }));

  const closed = await tools.get('complete_task')({ taskId: 'task_88' }, run);
  assert.deepEqual(closed, { ok: true, id: 'task_88', status: 'completed' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.todoist.com/api/v1/tasks/task_88/close');
  assert.equal(calls[0].body, undefined);

  const deleted = await tools.get('delete_task')({ taskId: 'task_88' }, run);
  assert.deepEqual(deleted, { ok: true, id: 'task_88', status: 'deleted' });
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].body, undefined);
});

test('sorts keys deterministically on task creation and updates', async () => {
  const { tools, calls, run } = createHarness(async (req) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'new_1', ...JSON.parse(req.body) }),
  }));

  const created = await tools.get('create_task')(
    { priority: 3, content: 'Review PR', due_string: 'tomorrow' },
    run,
  );
  assert.equal(created.id, 'new_1');
  assert.equal(calls[0].body, '{"content":"Review PR","due_string":"tomorrow","priority":3}');
});
