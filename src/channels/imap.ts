import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Attachment, Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
  folder: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  from: string;
}

function loadConfig(): ImapConfig | null {
  const env = readEnvFile([
    'IMAP_HOST',
    'IMAP_USER',
    'IMAP_PASS',
    'IMAP_PORT',
    'IMAP_TLS',
    'IMAP_FOLDER',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'IMAP_FROM',
  ]);
  const host = process.env.IMAP_HOST || env.IMAP_HOST;
  const user = process.env.IMAP_USER || env.IMAP_USER;
  const pass = process.env.IMAP_PASS || env.IMAP_PASS;
  if (!host || !user || !pass) return null;

  return {
    host,
    port: parseInt(process.env.IMAP_PORT || env.IMAP_PORT || '993', 10),
    user,
    pass,
    tls: (process.env.IMAP_TLS || env.IMAP_TLS) !== 'false',
    folder: process.env.IMAP_FOLDER || env.IMAP_FOLDER || 'INBOX',
    smtpHost: process.env.SMTP_HOST || env.SMTP_HOST || host,
    smtpPort: parseInt(process.env.SMTP_PORT || env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER || env.SMTP_USER || user,
    smtpPass: process.env.SMTP_PASS || env.SMTP_PASS || pass,
    from: process.env.IMAP_FROM || env.IMAP_FROM || user,
  };
}

export class ImapChannel implements Channel {
  name = 'imap';
  private client: ImapFlow | null = null;
  private transporter: Transporter | null = null;
  private connected = false;
  private config: ImapConfig;
  private opts: ChannelOpts;
  /** Tracks the last Message-ID per JID for threading replies. */
  private lastMessageIdByJid = new Map<string, string>();

  constructor(opts: ChannelOpts, config: ImapConfig) {
    this.opts = opts;
    this.config = config;
  }

  async connect(): Promise<void> {
    const { config } = this;

    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: { user: config.user, pass: config.pass },
      logger: false,
    });

    await this.client.connect();
    this.connected = true;

    this.transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });

    logger.info(
      { host: config.host, folder: config.folder },
      'IMAP channel connected',
    );

    // Open folder and start listening
    await this.client.mailboxOpen(config.folder);
    this.startIdleListener();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.client) {
      await this.client.logout();
      this.client = null;
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imap:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.transporter) throw new Error('SMTP not connected');

    const email = jid.replace(/^imap:/, '');
    const lastMsgId = this.lastMessageIdByJid.get(jid);
    const headers: Record<string, string> = {};
    if (lastMsgId) {
      headers['In-Reply-To'] = lastMsgId;
      headers['References'] = lastMsgId;
    }
    await this.transporter.sendMail({
      from: this.config.from,
      to: email,
      subject: 'Re: NanoClaw',
      text,
      headers,
    });
  }

  private startIdleListener(): void {
    if (!this.client) return;

    this.client.on('exists', async () => {
      if (!this.client || !this.connected) return;
      try {
        await this.fetchNewMessages();
      } catch (err) {
        logger.error({ err }, 'IMAP: error fetching new messages');
      }
    });
  }

  /** @internal — exported for testing via the class */
  async fetchNewMessages(): Promise<void> {
    if (!this.client) return;

    const lock = await this.client.getMailboxLock(this.config.folder);
    try {
      const messages: FetchMessageObject[] = [];
      for await (const msg of this.client.fetch(
        { seen: false },
        {
          source: true,
          envelope: true,
          uid: true,
        },
      )) {
        messages.push(msg);
      }

      for (const msg of messages) {
        await this.processMessage(msg);
        // Mark as seen so we don't re-process on the next fetch
        if (msg.uid) {
          await this.client!.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], {
            uid: true,
          });
        }
      }
    } finally {
      lock.release();
    }
  }

  private async processMessage(msg: FetchMessageObject): Promise<void> {
    const parsed = (await simpleParser(msg.source!)) as ParsedMail;
    const fromAddr = parsed.from?.value?.[0]?.address || 'unknown@unknown';
    const fromName = parsed.from?.value?.[0]?.name || fromAddr;
    const jid = `imap:${fromAddr}`;
    const messageId =
      msg.uid?.toString() || parsed.messageId || Date.now().toString();

    const attachments: Attachment[] = (parsed.attachments || []).map(
      (att, i) => ({
        id: att.contentId || `att-${i}`,
        filename: att.filename || `attachment-${i}`,
        mimeType: att.contentType || 'application/octet-stream',
        size: att.size || 0,
      }),
    );

    const newMsg: NewMessage = {
      id: messageId,
      chat_jid: jid,
      sender: fromAddr,
      sender_name: fromName,
      content: parsed.text || parsed.subject || '',
      timestamp: (parsed.date || new Date()).toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Store Message-ID for threading replies
    if (parsed.messageId) {
      this.lastMessageIdByJid.set(jid, parsed.messageId);
    }

    this.opts.onMessage(jid, newMsg);
    this.opts.onChatMetadata(jid, newMsg.timestamp, fromName, 'imap', false);
  }
}

function imapFactory(opts: ChannelOpts): Channel | null {
  const config = loadConfig();
  if (!config) return null;
  return new ImapChannel(opts, config);
}

registerChannel('imap', imapFactory);
