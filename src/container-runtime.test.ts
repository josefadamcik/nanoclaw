import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- detectProxyBindHost (module-level constant — requires resetModules) ---
// These tests use vi.mock for os and fs so that reimported modules see the mocks.

const mockPlatform = vi.fn();
const mockNetworkInterfaces = vi.fn();
const mockExistsSync = vi.fn();

describe('detectProxyBindHost', () => {
  const originalEnv = process.env.CREDENTIAL_PROXY_HOST;

  beforeEach(() => {
    // Reset mocks for each test — vi.mock hoists apply globally
    vi.doMock('os', () => ({
      default: {
        platform: mockPlatform,
        networkInterfaces: mockNetworkInterfaces,
      },
      platform: mockPlatform,
      networkInterfaces: mockNetworkInterfaces,
    }));
    vi.doMock('fs', () => ({
      default: { existsSync: mockExistsSync },
      existsSync: mockExistsSync,
    }));
    mockPlatform.mockReset();
    mockNetworkInterfaces.mockReset();
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CREDENTIAL_PROXY_HOST;
    } else {
      process.env.CREDENTIAL_PROXY_HOST = originalEnv;
    }
    vi.doUnmock('os');
    vi.doUnmock('fs');
  });

  async function reimport() {
    vi.resetModules();
    return import('./container-runtime.js');
  }

  it('returns env var when CREDENTIAL_PROXY_HOST is set', async () => {
    process.env.CREDENTIAL_PROXY_HOST = '10.0.0.5';
    const mod = await reimport();
    expect(mod.PROXY_BIND_HOST).toBe('10.0.0.5');
  });

  it('returns 127.0.0.1 on macOS', async () => {
    delete process.env.CREDENTIAL_PROXY_HOST;
    mockPlatform.mockReturnValue('darwin');
    const mod = await reimport();
    expect(mod.PROXY_BIND_HOST).toBe('127.0.0.1');
  });

  it('returns 127.0.0.1 on WSL', async () => {
    delete process.env.CREDENTIAL_PROXY_HOST;
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockImplementation(
      (p: string) => p === '/proc/sys/fs/binfmt_misc/WSLInterop',
    );
    const mod = await reimport();
    expect(mod.PROXY_BIND_HOST).toBe('127.0.0.1');
  });

  it('returns docker0 bridge IP on Linux with docker0', async () => {
    delete process.env.CREDENTIAL_PROXY_HOST;
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockReturnValue(false);
    mockNetworkInterfaces.mockReturnValue({
      docker0: [
        {
          address: '172.17.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '172.17.0.1/16',
        },
      ],
    });
    const mod = await reimport();
    expect(mod.PROXY_BIND_HOST).toBe('172.17.0.1');
  });

  it('throws on Linux without docker0 and no env override', async () => {
    delete process.env.CREDENTIAL_PROXY_HOST;
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockReturnValue(false);
    mockNetworkInterfaces.mockReturnValue({});
    await expect(reimport()).rejects.toThrow('No container bridge IP detected');
  });
});
