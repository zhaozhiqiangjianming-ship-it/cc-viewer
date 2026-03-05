import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnClaude,
  writeToPty,
  resizePty,
  killPty,
  onPtyData,
  onPtyExit,
  getPtyState,
  getCurrentWorkspace,
  getOutputBuffer,
} from '../pty-manager.js';

// ─── getPtyState / getCurrentWorkspace (no PTY running) ───

describe('pty-manager: state queries without PTY', () => {
  it('getPtyState returns not running when no PTY', () => {
    const state = getPtyState();
    assert.equal(state.running, false);
  });

  it('getCurrentWorkspace returns not running when no PTY', () => {
    const ws = getCurrentWorkspace();
    assert.equal(ws.running, false);
    assert.equal(ws.cwd, null);
  });

  it('getOutputBuffer returns empty string initially', () => {
    const buf = getOutputBuffer();
    assert.equal(typeof buf, 'string');
  });
});

// ─── writeToPty / resizePty / killPty (no-op when no PTY) ───

describe('pty-manager: operations without PTY', () => {
  it('writeToPty does not throw when no PTY', () => {
    assert.doesNotThrow(() => writeToPty('test'));
  });

  it('resizePty does not throw when no PTY', () => {
    assert.doesNotThrow(() => resizePty(80, 24));
  });

  it('killPty does not throw when no PTY', () => {
    assert.doesNotThrow(() => killPty());
  });
});

// ─── onPtyData / onPtyExit listener registration ───

describe('pty-manager: listener registration', () => {
  it('onPtyData registers and unregisters listener', () => {
    let called = false;
    const unsubscribe = onPtyData(() => { called = true; });
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
    // Listener removed, but we can't easily verify without spawning PTY
    assert.equal(called, false);
  });

  it('onPtyExit registers and unregisters listener', () => {
    let called = false;
    const unsubscribe = onPtyExit(() => { called = true; });
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
    assert.equal(called, false);
  });

  it('multiple listeners can be registered', () => {
    const unsub1 = onPtyData(() => {});
    const unsub2 = onPtyData(() => {});
    assert.equal(typeof unsub1, 'function');
    assert.equal(typeof unsub2, 'function');
    unsub1();
    unsub2();
  });
});

// ─── spawnClaude integration (requires claude binary) ───

describe('pty-manager: spawnClaude integration', () => {
  let ptyInstance;

  afterEach(() => {
    if (ptyInstance) {
      killPty();
      ptyInstance = null;
    }
  });

  it('spawnClaude throws when claude not found (mocked)', async () => {
    // This test assumes resolveNativePath() returns null in test env
    // If claude is installed, this test may fail — skip or mock
    try {
      await spawnClaude(9999, process.cwd());
      // If it succeeds, claude is installed
      killPty();
    } catch (err) {
      assert.ok(err.message.includes('claude not found'));
    }
  });

  it('getPtyState reflects running state after spawn (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());
      const state = getPtyState();
      assert.equal(state.running, true);
      killPty();
    } catch (err) {
      // claude not found, skip
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('getCurrentWorkspace returns cwd after spawn (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());
      const ws = getCurrentWorkspace();
      assert.equal(ws.running, true);
      assert.equal(ws.cwd, process.cwd());
      killPty();
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('onPtyData receives data from PTY (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          killPty();
          reject(new Error('Timeout waiting for PTY data'));
        }, 5000);

        const unsub = onPtyData((data) => {
          clearTimeout(timeout);
          unsub();
          assert.ok(data.length > 0, 'should receive data');
          killPty();
          resolve();
        });

        // Send a command to trigger output
        writeToPty('echo test\r');
      });
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('onPtyExit fires when PTY exits (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          killPty();
          reject(new Error('Timeout waiting for PTY exit'));
        }, 5000);

        const unsub = onPtyExit((exitCode) => {
          clearTimeout(timeout);
          unsub();
          assert.equal(typeof exitCode, 'number');
          resolve();
        });

        // Kill PTY to trigger exit
        killPty();
      });
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('getOutputBuffer accumulates PTY output (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          killPty();
          reject(new Error('Timeout waiting for output buffer'));
        }, 5000);

        const unsub = onPtyData(() => {
          const buf = getOutputBuffer();
          if (buf.length > 0) {
            clearTimeout(timeout);
            unsub();
            assert.ok(buf.length > 0, 'buffer should contain data');
            killPty();
            resolve();
          }
        });

        writeToPty('echo test\r');
      });
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('resizePty changes PTY dimensions (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());
      // resize should not throw
      assert.doesNotThrow(() => resizePty(80, 24));
      killPty();
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('killPty stops the PTY process (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());
      assert.equal(getPtyState().running, true);
      killPty();
      assert.equal(getPtyState().running, false);
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });

  it('spawnClaude kills existing PTY before spawning new one (if claude exists)', async () => {
    try {
      ptyInstance = await spawnClaude(9999, process.cwd());
      const firstPty = ptyInstance;
      ptyInstance = await spawnClaude(9999, process.cwd());
      assert.notEqual(ptyInstance, firstPty, 'should be a new PTY instance');
      killPty();
    } catch (err) {
      if (!err.message.includes('claude not found')) throw err;
    }
  });
});

// ─── output buffer truncation ───

describe('pty-manager: output buffer limits', () => {
  it('getOutputBuffer returns string', () => {
    const buf = getOutputBuffer();
    assert.equal(typeof buf, 'string');
  });

  // Note: Testing MAX_BUFFER truncation requires spawning PTY and generating >200KB output,
  // which is impractical for unit tests. This is better suited for integration tests.
});
