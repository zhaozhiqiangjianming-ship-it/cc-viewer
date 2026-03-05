import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 创建临时目录模拟 LOG_DIR
const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-server-test-'));
const fakeLogDir = join(tmpDir, 'logs');
const fakeProjectDir = join(fakeLogDir, 'test-project');
mkdirSync(fakeProjectDir, { recursive: true });

// 写一个假的日志文件
const fakeLogFile = join(fakeProjectDir, 'test.jsonl');
writeFileSync(fakeLogFile, JSON.stringify({
  timestamp: '2025-01-01T00:00:00.000Z',
  url: 'https://api.anthropic.com/v1/messages',
  method: 'POST',
  status: 200,
}) + '\n---\n');

// 设置环境变量，阻止自动启动和副作用
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

/** 用 node:http 发请求（避免被 interceptor patch 的 fetch 干扰） */
function httpRequest(port, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json() { return JSON.parse(data); },
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('server API endpoints', () => {
  let startViewer, stopViewer, getPort;
  let port;

  before(async () => {
    const mod = await import('../server.js');
    startViewer = mod.startViewer;
    stopViewer = mod.stopViewer;
    getPort = mod.getPort;

    const srv = await startViewer();
    assert.ok(srv, 'server should start');
    port = getPort();
    assert.ok(port > 0, 'port should be assigned');
  });

  after(() => {
    stopViewer();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- CORS ---
  it('OPTIONS returns 200 with CORS headers', async () => {
    const res = await httpRequest(port, '/api/preferences', { method: 'OPTIONS' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.headers['access-control-allow-methods'].includes('GET'));
  });

  // --- GET /api/preferences ---
  it('GET /api/preferences returns JSON object', async () => {
    const res = await httpRequest(port, '/api/preferences');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    const data = res.json();
    assert.equal(typeof data, 'object');
  });

  // --- POST /api/preferences ---
  it('POST /api/preferences with invalid JSON returns 400', async () => {
    const res = await httpRequest(port, '/api/preferences', {
      method: 'POST',
      body: '{bad json',
    });
    assert.equal(res.status, 400);
    assert.ok(res.json().error);
  });

  // --- GET /api/cli-mode ---
  it('GET /api/cli-mode returns mode flags', async () => {
    const res = await httpRequest(port, '/api/cli-mode');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.cliMode, false);
    // workspaceMode: isWorkspaceMode && !_workspaceLaunched → true && !false = true
    assert.equal(data.workspaceMode, true);
  });

  // --- GET /api/user-profile ---
  it('GET /api/user-profile returns name', async () => {
    const res = await httpRequest(port, '/api/user-profile');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.name, 'should have a name');
  });

  // --- GET /api/concept with invalid params ---
  it('GET /api/concept rejects invalid doc param', async () => {
    const res = await httpRequest(port, '/api/concept?lang=zh&doc=../../etc/passwd');
    assert.equal(res.status, 400);
  });

  it('GET /api/concept rejects invalid lang param', async () => {
    const res = await httpRequest(port, '/api/concept?lang=../xx&doc=Tool-Bash');
    assert.equal(res.status, 400);
  });

  // --- GET /api/files path traversal ---
  it('GET /api/files rejects path traversal', async () => {
    const res = await httpRequest(port, '/api/files?path=../../etc');
    assert.equal(res.status, 400);
    assert.ok(res.json().error.includes('Invalid path'));
  });

  it('GET /api/files rejects absolute path', async () => {
    const res = await httpRequest(port, '/api/files?path=/etc');
    assert.equal(res.status, 400);
  });

  // --- GET /api/file-content path traversal ---
  it('GET /api/file-content rejects path traversal', async () => {
    const res = await httpRequest(port, '/api/file-content?path=../../etc/passwd');
    assert.equal(res.status, 400);
    assert.ok(res.json().error.includes('Invalid path'));
  });

  it('GET /api/file-content rejects missing path', async () => {
    const res = await httpRequest(port, '/api/file-content');
    assert.equal(res.status, 400);
  });

  // --- POST /api/resume-choice with invalid choice ---
  it('POST /api/resume-choice rejects invalid choice', async () => {
    const res = await httpRequest(port, '/api/resume-choice', {
      method: 'POST',
      body: { choice: 'invalid' },
    });
    assert.equal(res.status, 400);
  });

  // --- POST /api/merge-logs validation ---
  it('POST /api/merge-logs rejects less than 2 files', async () => {
    const res = await httpRequest(port, '/api/merge-logs', {
      method: 'POST',
      body: { files: ['one.jsonl'] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.json().error.includes('2 files'));
  });

  it('POST /api/merge-logs rejects files from different projects', async () => {
    const res = await httpRequest(port, '/api/merge-logs', {
      method: 'POST',
      body: { files: ['projA/a.jsonl', 'projB/b.jsonl'] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.json().error.includes('same project'));
  });

  // --- Static file / SPA fallback ---
  it('GET / returns HTML (SPA fallback)', async () => {
    const res = await httpRequest(port, '/');
    // 如果 dist/index.html 存在则 200，否则 404
    assert.ok([200, 404].includes(res.status));
    if (res.status === 200) {
      assert.ok(res.headers['content-type'].includes('text/html'));
    }
  });

  // --- SSE endpoint ---
  it('GET /api/events returns event-stream', async () => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/events',
        method: 'GET',
      }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('text/event-stream'));
        // 收到 header 即可，立即关闭
        settled = true;
        res.destroy();
        resolve();
      });
      req.on('error', (err) => {
        if (settled || err.code === 'ECONNRESET') return;
        reject(err);
      });
      req.end();
    });
  });

  // --- Unknown route falls through to SPA fallback ---
  it('GET /api/nonexistent falls through to SPA fallback (200)', async () => {
    const res = await httpRequest(port, '/api/nonexistent');
    // SPA fallback serves index.html for unmatched routes
    assert.equal(res.status, 200);
  });

  // --- IGNORED_PATTERNS in /api/files ---
  it('GET /api/files filters out ignored directories', async () => {
    // Create a temp workspace with ignored dirs
    const workspace = mkdtempSync(join(tmpdir(), 'ccv-workspace-'));
    mkdirSync(join(workspace, 'node_modules'), { recursive: true });
    mkdirSync(join(workspace, '.git'), { recursive: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'index.js'), 'console.log("test");');

    // Mock CCV_PROJECT_DIR to point to our workspace
    const origCwd = process.env.CCV_PROJECT_DIR;
    process.env.CCV_PROJECT_DIR = workspace;

    try {
      const res = await httpRequest(port, '/api/files?path=.');
      assert.equal(res.status, 200);
      const data = res.json();

      // Should include 'src' but not 'node_modules' or '.git'
      const names = data.map(item => item.name);
      assert.ok(names.includes('src'), 'should include src');
      assert.ok(!names.includes('node_modules'), 'should filter out node_modules');
      assert.ok(!names.includes('.git'), 'should filter out .git');
    } finally {
      process.env.CCV_PROJECT_DIR = origCwd;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('GET /api/files filters out .DS_Store and __pycache__', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ccv-workspace-'));
    mkdirSync(join(workspace, '__pycache__'), { recursive: true });
    writeFileSync(join(workspace, '.DS_Store'), '');
    writeFileSync(join(workspace, 'main.py'), 'print("hello")');

    const origCwd = process.env.CCV_PROJECT_DIR;
    process.env.CCV_PROJECT_DIR = workspace;

    try {
      const res = await httpRequest(port, '/api/files?path=.');
      assert.equal(res.status, 200);
      const data = res.json();

      const names = data.map(item => item.name);
      assert.ok(names.includes('main.py'), 'should include main.py');
      assert.ok(!names.includes('__pycache__'), 'should filter out __pycache__');
      assert.ok(!names.includes('.DS_Store'), 'should filter out .DS_Store');
    } finally {
      process.env.CCV_PROJECT_DIR = origCwd;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('GET /api/files filters out build artifacts (.next, dist, .cache)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ccv-workspace-'));
    mkdirSync(join(workspace, '.next'), { recursive: true });
    mkdirSync(join(workspace, 'dist'), { recursive: true });
    mkdirSync(join(workspace, '.cache'), { recursive: true });
    mkdirSync(join(workspace, 'public'), { recursive: true });

    const origCwd = process.env.CCV_PROJECT_DIR;
    process.env.CCV_PROJECT_DIR = workspace;

    try {
      const res = await httpRequest(port, '/api/files?path=.');
      assert.equal(res.status, 200);
      const data = res.json();

      const names = data.map(item => item.name);
      assert.ok(names.includes('public'), 'should include public');
      assert.ok(!names.includes('.next'), 'should filter out .next');
      assert.ok(!names.includes('dist'), 'should filter out dist');
      assert.ok(!names.includes('.cache'), 'should filter out .cache');
    } finally {
      process.env.CCV_PROJECT_DIR = origCwd;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
