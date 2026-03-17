import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockMailboxOpen = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockOn = vi.fn();
const mockFetch = vi.fn();
const mockMessageFlagsAdd = vi.fn();

vi.mock('imapflow', () => {
  return {
    ImapFlow: class MockImapFlow {
      connect = mockConnect;
      logout = mockLogout;
      mailboxOpen = mockMailboxOpen;
      getMailboxLock = mockGetMailboxLock;
      on = mockOn;
      fetch = mockFetch;
      messageFlagsAdd = mockMessageFlagsAdd;
      constructor() {}
    },
  };
});

const mockSendMail = vi.fn();
const mockTransporterClose = vi.fn();
vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({
    sendMail: mockSendMail,
    close: mockTransporterClose,
  })),
}));

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

import { ImapChannel } from './imap.js';
import { simpleParser } from 'mailparser';
import type { ChannelOpts } from './registry.js';

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
  };
}

const defaultConfig = {
  host: 'mail.example.com',
  port: 993,
  user: 'user@example.com',
  pass: 'secret',
  tls: true,
  folder: 'INBOX',
  smtpHost: 'mail.example.com',
  smtpPort: 587,
  smtpUser: 'user@example.com',
  smtpPass: 'secret',
  from: 'user@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockLogout.mockResolvedValue(undefined);
  mockMailboxOpen.mockResolvedValue(undefined);
  mockGetMailboxLock.mockResolvedValue({ release: vi.fn() });
  mockMessageFlagsAdd.mockResolvedValue(undefined);
});

describe('ImapChannel', () => {
  it('ownsJid returns true for imap: prefix', () => {
    const ch = new ImapChannel(makeOpts(), defaultConfig);
    expect(ch.ownsJid('imap:alice@example.com')).toBe(true);
  });

  it('ownsJid returns false for other prefixes', () => {
    const ch = new ImapChannel(makeOpts(), defaultConfig);
    expect(ch.ownsJid('dc:123')).toBe(false);
    expect(ch.ownsJid('tg:456')).toBe(false);
    expect(ch.ownsJid('alice@example.com')).toBe(false);
  });

  it('connect/disconnect lifecycle', async () => {
    const ch = new ImapChannel(makeOpts(), defaultConfig);
    expect(ch.isConnected()).toBe(false);

    await ch.connect();
    expect(ch.isConnected()).toBe(true);
    expect(mockConnect).toHaveBeenCalled();
    expect(mockMailboxOpen).toHaveBeenCalledWith('INBOX');

    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
    expect(mockLogout).toHaveBeenCalled();
  });

  it('sendMessage calls nodemailer sendMail with correct params', async () => {
    const ch = new ImapChannel(makeOpts(), defaultConfig);
    await ch.connect();

    await ch.sendMessage('imap:alice@example.com', 'Hello Alice');

    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'user@example.com',
      to: 'alice@example.com',
      subject: 'Re: NanoClaw',
      text: 'Hello Alice',
      headers: {},
    });
  });

  it('inbound message parsing creates correct NewMessage', async () => {
    const opts = makeOpts();
    const ch = new ImapChannel(opts, defaultConfig);
    await ch.connect();

    const mockParsed = {
      from: { value: [{ address: 'bob@example.com', name: 'Bob' }] },
      text: 'Hello from Bob',
      subject: 'Test Subject',
      date: new Date('2024-06-01T12:00:00Z'),
      messageId: '<msg-123@example.com>',
      attachments: [],
    };
    vi.mocked(simpleParser).mockResolvedValue(mockParsed as any);

    // Simulate fetching — we need to make fetch return an async iterable
    const fakeMsg = {
      uid: 42,
      source: Buffer.from('raw email'),
      envelope: {},
    };

    mockGetMailboxLock.mockResolvedValue({ release: vi.fn() });
    mockFetch.mockReturnValue(
      (async function* () {
        yield fakeMsg;
      })(),
    );

    await ch.fetchNewMessages();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'imap:bob@example.com',
      expect.objectContaining({
        id: '42',
        chat_jid: 'imap:bob@example.com',
        sender: 'bob@example.com',
        sender_name: 'Bob',
        content: 'Hello from Bob',
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'imap:bob@example.com',
      expect.any(String),
      'Bob',
      'imap',
      false,
    );
    // Verify message was marked as seen
    expect(mockMessageFlagsAdd).toHaveBeenCalledWith({ uid: 42 }, ['\\Seen'], {
      uid: true,
    });
  });

  it('sendMessage includes threading headers from last inbound message', async () => {
    const opts = makeOpts();
    const ch = new ImapChannel(opts, defaultConfig);
    await ch.connect();

    // Simulate receiving a message first to populate threading state
    const mockParsed = {
      from: { value: [{ address: 'carol@example.com', name: 'Carol' }] },
      text: 'Original message',
      subject: 'Thread Subject',
      date: new Date('2024-06-01T12:00:00Z'),
      messageId: '<thread-abc@example.com>',
      attachments: [],
    };
    vi.mocked(simpleParser).mockResolvedValue(mockParsed as any);
    mockFetch.mockReturnValue(
      (async function* () {
        yield { uid: 50, source: Buffer.from('raw'), envelope: {} };
      })(),
    );
    await ch.fetchNewMessages();

    // Now send a reply — should include threading headers
    await ch.sendMessage('imap:carol@example.com', 'Reply text');

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'carol@example.com',
        text: 'Reply text',
        headers: {
          'In-Reply-To': '<thread-abc@example.com>',
          References: '<thread-abc@example.com>',
        },
      }),
    );
  });

  it('email with attachments creates Attachment objects', async () => {
    const opts = makeOpts();
    const ch = new ImapChannel(opts, defaultConfig);
    await ch.connect();

    const mockParsed = {
      from: { value: [{ address: 'carol@example.com', name: 'Carol' }] },
      text: 'See attached',
      subject: 'Files',
      date: new Date('2024-06-01T12:00:00Z'),
      messageId: '<msg-456@example.com>',
      attachments: [
        {
          contentId: 'cid-1',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          size: 5000,
        },
        {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
          size: 12000,
        },
      ],
    };
    vi.mocked(simpleParser).mockResolvedValue(mockParsed as any);

    const fakeMsg = {
      uid: 99,
      source: Buffer.from('raw email'),
      envelope: {},
    };
    mockFetch.mockReturnValue(
      (async function* () {
        yield fakeMsg;
      })(),
    );

    await ch.fetchNewMessages();

    const call = vi.mocked(opts.onMessage).mock.calls[0];
    const newMsg = call[1];
    expect(newMsg.attachments).toHaveLength(2);
    expect(newMsg.attachments![0]).toEqual({
      id: 'cid-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 5000,
    });
    expect(newMsg.attachments![1]).toEqual({
      id: 'att-1',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 12000,
    });
  });
});

describe('IMAP factory', () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    'IMAP_HOST',
    'IMAP_PORT',
    'IMAP_USER',
    'IMAP_PASS',
    'IMAP_TLS',
    'IMAP_FOLDER',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'IMAP_FROM',
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (envBackup[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = envBackup[k];
      }
    }
  });

  it('factory returns null without required env vars', async () => {
    vi.resetModules();
    const mod = await import('./imap.js');
    const { getChannelFactory } = await import('./registry.js');
    const factory = getChannelFactory('imap');
    expect(factory).toBeDefined();
    const result = factory!(makeOpts());
    expect(result).toBeNull();
  });

  it('factory returns ImapChannel with all env vars set', async () => {
    process.env.IMAP_HOST = 'mail.test.com';
    process.env.IMAP_USER = 'test@test.com';
    process.env.IMAP_PASS = 'pass123';
    vi.resetModules();
    const mod = await import('./imap.js');
    const { getChannelFactory } = await import('./registry.js');
    const factory = getChannelFactory('imap');
    expect(factory).toBeDefined();
    const result = factory!(makeOpts());
    expect(result).not.toBeNull();
    expect(result!.name).toBe('imap');
  });
});
