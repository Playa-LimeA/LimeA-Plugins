const API_ORIGIN = 'https://pan.baidu.com';

const CATEGORY_LABELS = {
  1: '视频',
  2: '音频',
  3: '图片',
  4: '文档',
  5: '应用',
  6: '其他',
  7: '种子',
};

function requireConnections(context) {
  context?.signal?.throwIfAborted?.();
  if (!context?.connections) throw new Error('connection-access-denied');
  return context.connections;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 100 || idx === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[idx]}`;
}

function projectFile(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const isDir = entry.isdir === 1;
  return {
    fsId: entry.fs_id !== undefined ? String(entry.fs_id) : undefined,
    path: entry.path,
    name: entry.server_filename ?? entry.filename,
    isDir,
    size: typeof entry.size === 'number' ? entry.size : undefined,
    sizeLabel: isDir ? '文件夹' : formatBytes(entry.size),
    category: isDir ? '文件夹' : (CATEGORY_LABELS[entry.category] ?? '其他'),
    mtime:
      typeof entry.server_mtime === 'number'
        ? new Date(entry.server_mtime * 1000).toISOString()
        : undefined,
    ctime:
      typeof entry.server_ctime === 'number'
        ? new Date(entry.server_ctime * 1000).toISOString()
        : undefined,
    md5: typeof entry.md5 === 'string' && entry.md5 ? entry.md5 : undefined,
  };
}

export function normalizeFsidsParam(fsids) {
  if (!Array.isArray(fsids) || fsids.length < 1 || fsids.length > 50)
    throw new Error('invalid-fsids');
  const serialized = fsids.map((item) => {
    const raw = typeof item === 'number' ? String(Math.trunc(item)) : String(item ?? '').trim();
    if (!/^[1-9]\d{0,18}$/.test(raw)) throw new Error('invalid-fsid');
    return raw;
  });
  return `[${serialized.join(',')}]`;
}

async function baiduGet(context, path, query = {}) {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  const response = await requireConnections(context).request({
    provider: 'baidu-netdisk',
    method: 'GET',
    url: url.href,
  });
  return response.body ? JSON.parse(response.body) : {};
}

async function baiduWrite(context, path, body) {
  const response = await requireConnections(context).request({
    provider: 'baidu-netdisk',
    method: 'POST',
    url: `${API_ORIGIN}${path}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.body ? JSON.parse(response.body) : {};
}

export function createHandlers() {
  return {
    async get_quota(input = {}, context) {
      const data = await baiduGet(context, '/api/quota', {
        checkfree: input.checkfree === false ? '0' : '1',
        checkexpire: input.checkexpire === false ? '0' : '1',
      });
      const total = typeof data.total === 'number' ? data.total : 0;
      const used = typeof data.used === 'number' ? data.used : 0;
      const free = Math.max(0, total - used);
      return {
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        totalLabel: formatBytes(total),
        usedLabel: formatBytes(used),
        freeLabel: formatBytes(free),
        expire: Boolean(data.expire),
      };
    },

    async list_files(input = {}, context) {
      const data = await baiduGet(context, '/rest/2.0/xpan/file', {
        method: 'list',
        dir: input.dir ?? '/',
        order: input.order,
        desc: input.desc === undefined ? undefined : input.desc ? '1' : '0',
        start: input.start,
        limit: input.limit ?? 50,
        folder: input.folderOnly ? '1' : undefined,
      });
      const list = Array.isArray(data.list) ? data.list.map(projectFile).filter(Boolean) : [];
      return {
        dir: input.dir ?? '/',
        count: list.length,
        files: list,
      };
    },

    async search_files(input, context) {
      const data = await baiduGet(context, '/rest/2.0/xpan/file', {
        method: 'search',
        key: input.key,
        dir: input.dir,
        page: input.page ?? 1,
        num: input.num ?? 50,
        recursion: input.recursion === false ? '0' : '1',
      });
      const list = Array.isArray(data.list) ? data.list.map(projectFile).filter(Boolean) : [];
      return {
        key: input.key,
        dir: input.dir ?? '/',
        hasMore: Boolean(data.has_more),
        count: list.length,
        files: list,
      };
    },

    async get_file_metas(input, context) {
      const fsids = normalizeFsidsParam(input.fsids);
      const data = await baiduGet(context, '/rest/2.0/xpan/multimedia', {
        method: 'filemetas',
        fsids,
        thumb: input.thumb ? '1' : undefined,
        extra: input.extra ? '1' : undefined,
      });
      const list = Array.isArray(data.list) ? data.list.map(projectFile).filter(Boolean) : [];
      return {
        count: list.length,
        files: list,
      };
    },

    async create_folder(input, context) {
      const body = {
        path: input.path,
        ...(input.rtype !== undefined ? { rtype: input.rtype } : {}),
      };
      const data = await baiduWrite(context, '/rest/2.0/xpan/file/create_dir', body);
      return {
        created: true,
        path: data.path ?? input.path,
        fsId: data.fs_id !== undefined ? String(data.fs_id) : undefined,
      };
    },

    async rename_file(input, context) {
      const data = await baiduWrite(context, '/rest/2.0/xpan/file/rename', {
        items: input.items,
      });
      return {
        renamed: true,
        count: input.items.length,
        info: Array.isArray(data.info) ? data.info : [],
      };
    },

    async move_files(input, context) {
      const body = {
        items: input.items,
        ...(input.ondup ? { ondup: input.ondup } : {}),
      };
      const data = await baiduWrite(context, '/rest/2.0/xpan/file/move', body);
      return {
        moved: true,
        count: input.items.length,
        info: Array.isArray(data.info) ? data.info : [],
      };
    },

    async copy_files(input, context) {
      const body = {
        items: input.items,
        ...(input.ondup ? { ondup: input.ondup } : {}),
      };
      const data = await baiduWrite(context, '/rest/2.0/xpan/file/copy', body);
      return {
        copied: true,
        count: input.items.length,
        info: Array.isArray(data.info) ? data.info : [],
      };
    },

    async delete_files(input, context) {
      const data = await baiduWrite(context, '/rest/2.0/xpan/file/delete', {
        paths: input.paths,
      });
      return {
        deleted: true,
        count: input.paths.length,
        info: Array.isArray(data.info) ? data.info : [],
      };
    },
  };
}

export function apply(ctx) {
  const handlers = createHandlers();
  for (const [id, handler] of Object.entries(handlers)) {
    ctx.tools.register(id, async (input = {}, run) => {
      const result = await handler(input, run);
      if (Buffer.byteLength(JSON.stringify(result)) > 24000)
        throw new Error('connection-result-too-large');
      return result;
    });
  }
}
