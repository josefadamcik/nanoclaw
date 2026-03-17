# NanoClaw Email Improvements

## Current State

### Gmail-Only via Google API

Email support is implemented exclusively through the Gmail API using the `@gongrzhe/server-gmail-autoauth-mcp` MCP server. There are two modes:

1. **Tool-only mode** — Agents get Gmail MCP tools (`mcp__gmail__*`) to read/send email on demand, but there is no inbox monitoring.
2. **Full channel mode** — A `GmailChannel` class implements the `Channel` interface, polls for unread emails (`is:unread category:primary`), and pipes them into the agent container as `NewMessage` objects.

Credentials are stored in `~/.gmail-mcp/` (GCP OAuth keys + tokens) and mounted read-only into containers.

### No IMAP/SMTP Support

There is no generic email protocol support. Users without a Google Workspace or Gmail account cannot use the email channel.

### No Attachment Handling

The core `NewMessage` interface (`src/types.ts`) is text-only:

```typescript
interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;        // text body only
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}
```

The `messages` database table mirrors this — no columns for attachment metadata. Email attachments are silently dropped during ingestion.

---

## Improvement: Generic IMAP/SMTP Channel

### Goal

Allow any email provider (Outlook, Fastmail, self-hosted) by adding an IMAP/SMTP channel alongside the existing Gmail channel.

### Approach

Use the existing self-registration pattern in `src/channels/registry.ts`:

```typescript
// src/channels/imap.ts
import { registerChannel } from './registry.js';

function imapFactory(opts: ChannelOpts): Channel | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) return null;
  return new ImapChannel(opts, { host, user, pass });
}

registerChannel('imap', imapFactory);
```

Then add the import to `src/channels/index.ts` so it self-registers at startup.

### Implementation Details

| Concern | Design |
|---------|--------|
| **Library** | `imapflow` for IMAP (IDLE support, modern API), `nodemailer` for SMTP |
| **Polling vs IDLE** | Use IMAP IDLE for real-time delivery; fall back to polling if IDLE is unavailable |
| **JID format** | `imap:<sender>/<message-id>` to avoid collision with Gmail JIDs |
| **Thread grouping** | Use `In-Reply-To` / `References` headers to group threads |
| **Outbound** | `sendMessage()` composes a reply via SMTP, preserving `References` header for threading |
| **Credentials** | Environment variables (`IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `SMTP_HOST`, `SMTP_PORT`) |
| **TLS** | Required by default; optional `IMAP_TLS=false` for local dev servers |
| **Folder filtering** | `IMAP_FOLDER=INBOX` (default), configurable to monitor other folders |

### Channel Class Skeleton

```typescript
class ImapChannel implements Channel {
  name = 'imap';

  async connect(): Promise<void> {
    // 1. Connect to IMAP server
    // 2. Open configured folder
    // 3. Start IDLE listener (or polling interval)
    // 4. Fetch unread messages → convert to NewMessage → call onMessage()
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // 1. Parse recipient and thread ID from JID
    // 2. Compose reply with nodemailer (set In-Reply-To, References)
    // 3. Send via SMTP
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imap:');
  }

  isConnected(): boolean { /* return IMAP connection state */ }
  async disconnect(): Promise<void> { /* close IMAP + SMTP connections */ }
}
```

---

## Improvement: Email Attachment Support

### Goal

Allow agents to receive and reference email attachments (images, PDFs, documents) instead of silently dropping them.

### Step 1: Extend the Message Interface

Add an optional `attachments` field to `NewMessage` in `src/types.ts`:

```typescript
interface Attachment {
  id: string;           // unique reference (e.g., Gmail attachment ID or content-id)
  filename: string;     // original filename
  mimeType: string;     // e.g., "application/pdf", "image/png"
  size: number;         // bytes
}

interface NewMessage {
  // ...existing fields...
  attachments?: Attachment[];
}
```

### Step 2: Store Attachment Metadata

Add an `attachments` table to the SQLite schema in `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  local_path TEXT,
  FOREIGN KEY (message_id, chat_jid) REFERENCES messages(id, chat_jid)
);
```

### Step 3: Download and Mount Attachments

When a channel receives a message with attachments:

1. Download the attachment to a group-local directory (e.g., `groups/{name}/attachments/{id}-{filename}`)
2. Record metadata in the `attachments` table
3. Include attachment references in the `NewMessage` so the agent sees them
4. The attachment directory is already within the group folder, which is mounted into the container at `/workspace/group/`

### Step 4: Update Message Formatting

Extend `formatMessages()` in `src/router.ts` to include attachment metadata in the XML sent to the agent:

```xml
<message sender="alice@example.com" time="2026-03-17T10:00:00Z">
  Please review the attached report.
  <attachments>
    <file name="report.pdf" type="application/pdf" size="245000" path="/workspace/group/attachments/abc-report.pdf"/>
  </attachments>
</message>
```

The agent can then read the file directly from its mounted filesystem.

### Size and Safety Considerations

- Set a per-attachment size limit (e.g., 10 MB) to avoid filling container disk
- Set a per-message attachment count limit (e.g., 10 files)
- Skip or warn on executable attachments (`.exe`, `.sh`, `.bat`)
- Store attachments outside the git-tracked `groups/` directory if disk is a concern, using a configurable `ATTACHMENT_DIR`
