import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockStartRemoteControl = vi.fn();
const mockStopRemoteControl = vi.fn();
vi.mock('./remote-control.js', () => ({
  startRemoteControl: (...args: unknown[]) => mockStartRemoteControl(...args),
  stopRemoteControl: (...args: unknown[]) => mockStopRemoteControl(...args),
}));

const mockLoadSenderAllowlist = vi.fn();
const mockIsSenderAllowed = vi.fn();
vi.mock('./sender-allowlist.js', () => ({
  loadSenderAllowlist: (...args: unknown[]) => mockLoadSenderAllowlist(...args),
  isSenderAllowed: (...args: unknown[]) => mockIsSenderAllowed(...args),
}));

import { handleRemoteControl } from './remote-control-handler.js';
import { logger } from './logger.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'main@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: '/remote-control',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeChannel(jidPrefix = ''): Channel {
  return {
    name: 'test',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi
      .fn()
      .mockImplementation((jid: string) =>
        jidPrefix ? jid.startsWith(jidPrefix) : true,
      ),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const allowAllCfg = {
  default: { allow: '*' as const, mode: 'trigger' as const },
  chats: {},
  logDenied: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadSenderAllowlist.mockReturnValue(allowAllCfg);
  mockIsSenderAllowed.mockReturnValue(true);
});

describe('handleRemoteControl', () => {
  it('rejects non-main group', async () => {
    const channel = makeChannel();
    const groups: Record<string, RegisteredGroup> = {
      'other@g.us': { ...mainGroup, isMain: undefined },
    };

    await handleRemoteControl(
      '/remote-control',
      'other@g.us',
      makeMsg({ chat_jid: 'other@g.us' }),
      [channel],
      groups,
      '/tmp',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'other@g.us' }),
      'Remote control rejected: not main group',
    );
    expect(mockStartRemoteControl).not.toHaveBeenCalled();
  });

  it('rejects sender not in allowlist when not is_from_me', async () => {
    const channel = makeChannel();
    mockIsSenderAllowed.mockReturnValue(false);

    await handleRemoteControl(
      '/remote-control',
      'main@g.us',
      makeMsg({ is_from_me: false }),
      [channel],
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'main@g.us' }),
      'Remote control rejected: sender not in allowlist',
    );
    expect(mockStartRemoteControl).not.toHaveBeenCalled();
  });

  it('allows is_from_me even if not in allowlist', async () => {
    const channel = makeChannel();
    mockIsSenderAllowed.mockReturnValue(false);
    mockStartRemoteControl.mockResolvedValue({
      ok: true,
      url: 'https://claude.ai/code/xxx',
    });

    await handleRemoteControl(
      '/remote-control',
      'main@g.us',
      makeMsg({ is_from_me: true }),
      [channel],
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(mockStartRemoteControl).toHaveBeenCalled();
  });

  it('allows sender in allowlist', async () => {
    const channel = makeChannel();
    mockIsSenderAllowed.mockReturnValue(true);
    mockStartRemoteControl.mockResolvedValue({
      ok: true,
      url: 'https://claude.ai/code/xxx',
    });

    await handleRemoteControl(
      '/remote-control',
      'main@g.us',
      makeMsg(),
      [channel],
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(mockStartRemoteControl).toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'https://claude.ai/code/xxx',
    );
  });

  it('sends error on /remote-control failure', async () => {
    const channel = makeChannel();
    mockStartRemoteControl.mockResolvedValue({
      ok: false,
      error: 'spawn failed',
    });

    await handleRemoteControl(
      '/remote-control',
      'main@g.us',
      makeMsg(),
      [channel],
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'Remote Control failed: spawn failed',
    );
  });

  it('handles /remote-control-end', async () => {
    const channel = makeChannel();
    mockStopRemoteControl.mockReturnValue({ ok: true });

    await handleRemoteControl(
      '/remote-control-end',
      'main@g.us',
      makeMsg({ content: '/remote-control-end' }),
      [channel],
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(mockStopRemoteControl).toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'Remote Control session ended.',
    );
  });

  it('handles /remote-control-end error', async () => {
    const channel = makeChannel();
    mockStopRemoteControl.mockReturnValue({
      ok: false,
      error: 'No active session',
    });

    await handleRemoteControl(
      '/remote-control-end',
      'main@g.us',
      makeMsg({ content: '/remote-control-end' }),
      [channel],
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'No active session',
    );
  });

  it('returns without error when no channel found', async () => {
    await handleRemoteControl(
      '/remote-control',
      'main@g.us',
      makeMsg(),
      [], // no channels
      { 'main@g.us': mainGroup },
      '/tmp',
    );

    expect(mockStartRemoteControl).not.toHaveBeenCalled();
  });
});
