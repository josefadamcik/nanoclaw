# NanoClaw Improvements

## Security Hardening (VPS Deployment)

### ~~Credential proxy binds to `0.0.0.0` on bare-metal Linux~~ (Fixed)

**Status:** Fixed in `src/container-runtime.ts`.

`detectProxyBindHost()` now throws a descriptive error instead of falling back to `0.0.0.0` when the `docker0` interface is not found on bare-metal Linux. The `CREDENTIAL_PROXY_HOST` env var override still works as before and short-circuits detection entirely.

### ~~`/remote-control` command bypasses sender allowlist~~ (Fixed)

**Status:** Fixed. Handler extracted to `src/remote-control-handler.ts`.

The `/remote-control` command now checks the sender allowlist before granting access. `is_from_me` messages bypass the check (owner is always allowed). The handler was extracted from the `main()` closure in `src/index.ts` into a standalone testable module with 8 unit tests.

---

## Email Improvements

### Current State

#### Gmail-Only via Google API

Email support is implemented exclusively through the Gmail API using the `@gongrzhe/server-gmail-autoauth-mcp` MCP server. There are two modes:

1. **Tool-only mode** — Agents get Gmail MCP tools (`mcp__gmail__*`) to read/send email on demand, but there is no inbox monitoring.
2. **Full channel mode** — A `GmailChannel` class implements the `Channel` interface, polls for unread emails (`is:unread category:primary`), and pipes them into the agent container as `NewMessage` objects.

Credentials are stored in `~/.gmail-mcp/` (GCP OAuth keys + tokens) and mounted read-only into containers.

### ~~No IMAP/SMTP Support~~ (Implemented)

**Status:** Implemented in `src/channels/imap.ts`.

A generic IMAP/SMTP channel is now available. Configure with `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` env vars. Uses ImapFlow for IMAP IDLE-based real-time delivery and nodemailer for SMTP outbound with `In-Reply-To`/`References` threading headers. Messages are marked as `\Seen` after processing. JID format: `imap:<email-address>`.

Additional env vars with defaults: `IMAP_PORT` (993), `IMAP_TLS` (true), `IMAP_FOLDER` (INBOX), `SMTP_HOST` (IMAP_HOST), `SMTP_PORT` (587), `SMTP_USER` (IMAP_USER), `SMTP_PASS` (IMAP_PASS), `IMAP_FROM` (IMAP_USER).

### ~~No Attachment Handling~~ (Implemented)

**Status:** Implemented across `src/types.ts`, `src/db.ts`, `src/router.ts`.

The `NewMessage` interface now includes an optional `attachments` field with `Attachment` objects (`id`, `filename`, `mimeType`, `size`). An `attachments` SQLite table stores metadata with optional `local_path`. `storeMessage()` auto-stores attachments. `formatMessages()` includes `<attachments><file ... /></attachments>` XML blocks in agent context.

---

## Remaining Work

### Attachment Download and Mounting

Attachment metadata is stored and formatted, but channels do not yet download attachment content to disk. To complete the feature:

1. Download attachments to a group-local directory (e.g., `groups/{name}/attachments/{id}-{filename}`)
2. Pass `localPaths` to `storeAttachments()` to record the on-disk path
3. Include `path` attribute in the `<file>` XML element so agents can read files directly
4. The attachment directory is already within the group folder, which is mounted into containers at `/workspace/group/`

### Size and Safety Considerations

Not yet implemented:

- Per-attachment size limit (e.g., 10 MB) to avoid filling container disk
- Per-message attachment count limit (e.g., 10 files)
- Skip or warn on executable attachments (`.exe`, `.sh`, `.bat`)
- Configurable `ATTACHMENT_DIR` for storing attachments outside git-tracked `groups/` directory
