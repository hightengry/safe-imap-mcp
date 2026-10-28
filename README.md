# safe-imap-mcp

**Let Claude (or any MCP-compatible AI assistant) read and send your email over IMAP/SMTP, without giving it the power to delete anything.**

[Русская версия](README.ru.md)

Most email integrations for AI assistants either cover only Gmail and Microsoft 365, or hand the model full control of the mailbox. `safe-imap-mcp` is a small local [MCP](https://modelcontextprotocol.io) server for the common case in between: business mailboxes on an ordinary hosting provider (cPanel, Plesk, your own mail server), where you want an assistant to search, read, draft and send, but where one wrong tool call must never wipe your inbox.

- Works with any IMAP/SMTP server and with several mailboxes at once.
- Runs on your own computer. Passwords never leave it.
- **No delete, move, expunge or purge operations exist in the code.** A test enforces this.
- Reading a message does not mark it as read.
- Attachments can be sent from, and saved to, an allowlist of folders only.

## What the assistant can do

| Tool | What it does | Changes anything? |
|---|---|---|
| `list_accounts` | Lists configured mailboxes | No |
| `list_folders` | Lists folders of a mailbox | No |
| `search_emails` | Searches by sender, recipient, subject, text, dates, unread | No |
| `read_email` | Reads a full message, lists its attachments | No (does not mark as read) |
| `list_attachment_folders` | Shows which local folders are allowed for attachments | No |
| `mark_as_read` | Sets or clears the read flag | Only the read flag |
| `save_attachments` | Saves a message's attachments to a local folder | Writes new files, never overwrites |
| `save_draft` | Saves a message to Drafts | Adds a draft |
| `send_email` | Sends a message, optionally as a reply in the same thread, with attachments; stores a copy in Sent | Sends mail |

There is deliberately no tool to delete, move, archive or empty anything, and no tool to create or delete mailboxes.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- An MCP client: Claude Desktop, Claude Code, or any other client that supports local (stdio) MCP servers
- IMAP and SMTP access to your mailbox with a password or an app password

## Installation

### 1. Get the code

```bash
git clone https://github.com/hightengry/safe-imap-mcp.git
cd safe-imap-mcp
npm install
```

Or download the ZIP from GitHub, unpack it, and run `npm install` inside the folder.

### 2. Configure your mailboxes

```bash
cp accounts.example.json accounts.json      # Windows: copy accounts.example.json accounts.json
```

Edit `accounts.json`:

```json
{
  "defaults": {
    "imapHost": "mail.example.com",
    "imapPort": 993,
    "smtpHost": "mail.example.com",
    "smtpPort": 465
  },
  "accounts": [
    { "email": "you@example.com", "fromName": "Your Name", "password": "your-password" },
    { "email": "info@example.com", "fromName": "Example Inc.", "passwordEnv": "MAIL_PASSWORD_INFO" }
  ]
}
```

Your hosting control panel usually shows the server names and ports under something like "Mail client setup" or "Manual configuration".

`accounts.json` is listed in `.gitignore` and will not be committed.

### 3. Test the connection

```bash
npm run check
```

It logs in to IMAP and SMTP for each mailbox and reports `ok` or the error. It sends nothing and changes nothing.

### 4. Connect it to your assistant

**Claude Desktop.** Open *Settings → Developer → Edit Config* and add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["C:\\path\\to\\safe-imap-mcp\\index.js"]
    }
  }
}
```

On macOS/Linux use a normal path, e.g. `"/Users/you/safe-imap-mcp/index.js"`. If the file already has an `mcpServers` section, add only the `"email": {...}` entry to it. Fully quit and restart Claude Desktop.

If Claude reports that `node` cannot be found, use the full path, e.g. `"C:\\Program Files\\nodejs\\node.exe"` or the output of `which node`.

**Claude Code.**

```bash
claude mcp add email -- node /path/to/safe-imap-mcp/index.js
```

**Other clients:** run `node index.js` as a stdio MCP server.

### 5. Try it

> Show me the 5 latest emails in you@example.com.

## Configuration reference

| Key | Where | Default | Meaning |
|---|---|---|---|
| `email` | account | required | Mailbox address, used to pick the account |
| `fromName` | account | none | Display name in the From header |
| `password` | account | none | Password or app password |
| `passwordEnv` | account | none | Name of an environment variable holding the password (used instead of `password`) |
| `username` | account / defaults | `email` | Login, if different from the address |
| `imapHost`, `smtpHost` | account / defaults | required | Server names |
| `imapPort` | account / defaults | `993` | IMAP port |
| `smtpPort` | account / defaults | `465` | SMTP port (`587` uses STARTTLS) |
| `imapSecure`, `smtpSecure` | account / defaults | from port | Force TLS on/off |
| `attachmentFolders` | top level | Desktop, Documents, Downloads (incl. OneDrive variants) | Folders from which files may be attached and into which attachments are saved |
| `limits.maxRecipients` | top level | `20` | Max recipients (to + cc + bcc) per message |
| `limits.maxAttachments` | top level | `10` | Max attachments per message |
| `limits.maxAttachmentMB` | top level | `20` | Max total attachment size per message |

The config file is re-read on every call, so you can change passwords or limits without restarting. To keep the config elsewhere, set `MAIL_ACCOUNTS_FILE=/path/to/accounts.json` in the server's environment (in Claude Desktop, via an `"env"` block next to `"args"`).

## Safety model

The aim is that a confused, mistaken or manipulated assistant can at worst send an email you approved, never destroy data.

1. **No destructive operations.** The code has no calls that delete, move, copy, expunge or rename messages or mailboxes, and never sets the IMAP `\Deleted` flag. `npm test` fails if any appear. All tools are annotated `destructiveHint: false`.
2. **Read without side effects.** Mailboxes are opened read-only for searching and reading.
3. **Human approval for sending.** The `send_email` description instructs the assistant to show you sender, recipients, subject, full text and attachment paths and wait for your explicit approval. In Claude Desktop, also answer the tool permission prompt for `send_email` with **Allow once** rather than "Always allow", so every send needs a click.
4. **Prompt-injection hygiene.** Incoming mail is untrusted. Tool descriptions tell the assistant to treat message content as data and never to attach files or add recipients because an email asked for it.
5. **Attachment sandbox.** Files can be attached only from `attachmentFolders`. Symlinks are resolved first, `..` tricks are rejected, the program folder, the config file and the send log are always blocked, and files named like `accounts*.json` are refused. Saved attachments get sanitised names, never overwrite existing files, and are never opened.
6. **Limits.** Recipient count, attachment count and total size are capped, so the tool cannot be used for bulk mail.
7. **Audit log.** Every sent message is appended to `sent-log.txt` next to the config file: time, sender, recipients, subject, attachments.

### What it does not protect against

- **Passwords on disk.** `accounts.json` stores passwords in plain text unless you use `passwordEnv`. Anyone with access to your user account can read it. Prefer app passwords where your provider offers them, and keep the file private.
- **Approving a bad email.** If you approve a message, it is sent. Read what you approve.
- **Your mail provider's own features.** Server-side filters, forwarding rules and webmail are outside this tool.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Compatibility notes

- **Hosting mailboxes (Plesk, cPanel, DirectAdmin, Dovecot/Postfix):** the main target, works with password login.
- **Gmail / Google Workspace:** works with `imap.gmail.com` / `smtp.gmail.com` and an app password, if your account or admin still allows app passwords. Gmail stores sent mail by itself, so you may see two copies in Sent.
- **Microsoft 365 / Outlook.com:** these require OAuth for IMAP/SMTP, which this tool does not support. Use the official Microsoft 365 connector of your assistant instead.
- Bodies are sent as plain text. HTML composition is not supported.

## Development

```bash
npm test        # offline safety tests, no mail server needed
npm run check   # live connection check with your accounts.json
```

Contributions are welcome. A pull request that adds any destructive capability will not be accepted: that restriction is the point of the project.

## License

[MIT](LICENSE) © 2026 HighTengry LLP

## About

Built and maintained by [HighTengry](https://hightengry.kz), Astana, Kazakhstan. We use this tool in our own work and help companies put AI assistants to work with their existing systems safely.
