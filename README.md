# safe-imap-mcp

**Let Claude (or any MCP-compatible AI assistant) read and send your email over IMAP/SMTP, without giving it the power to delete anything.**

[Русская версия](README.ru.md)

Most email integrations for AI assistants either cover only Gmail and Microsoft 365, or hand the model full control of the mailbox. `safe-imap-mcp` is a small local [MCP](https://modelcontextprotocol.io) server for the common case in between: business mailboxes on an ordinary hosting provider (cPanel, Plesk, your own mail server), where you want an assistant to search, read, draft and send, but where one wrong tool call must never wipe your inbox.

- Works with any IMAP/SMTP server and with several mailboxes at once.
- Runs on your own computer. Passwords stay there and are sent only to your own mail server, always encrypted.
- **There is no tool to delete, move, expunge or purge mail.** A test checks the code for such calls.
- Reading a message does not mark it as read.
- Files can be attached only from folders you allow; files with keys or passwords are always refused.
- Optional "approval folders": attaching from them requires a Yes/No dialog on your computer, which the assistant cannot answer.

## What the assistant can do

| Tool | What it does | Changes anything? |
|---|---|---|
| `list_accounts` | Lists configured mailboxes | No |
| `list_folders` | Lists folders of a mailbox | No |
| `search_emails` | Searches by sender, recipient, subject, text, dates, unread | No |
| `read_email` | Reads a full message, lists its attachments | No (does not mark as read) |
| `list_attachment_folders` | Shows which local folders are allowed for attachments and where attachments are saved | No |
| `mark_as_read` | Sets or clears the read flag | Only the read flag |
| `save_attachments` | Saves a message's attachments into `Downloads/mail-attachments` | Writes new files there, never overwrites |
| `save_draft` | Saves a message to Drafts | Adds a draft |
| `send_email` | Sends a message, optionally as a reply in the same thread, with attachments; stores a copy in Sent | Sends mail |

There is deliberately no tool to delete, move, archive or empty anything, and no tool to create or delete mailboxes.

## Quick start (about 3 minutes)

You need [Node.js](https://nodejs.org) 20 or newer, Claude Desktop, and your mailbox's server name and password (your hosting panel shows them under something like "Mail client setup").

```bash
npm install -g safe-imap-mcp
safe-imap-mcp init
safe-imap-mcp install-claude
```

1. `init` asks for your mailbox address, server, port and password (hidden while you type), then tests the connection. It sends nothing.
2. `install-claude` adds the server to Claude Desktop. It shows the change, asks for confirmation and saves a backup of Claude's config first.
3. Fully quit Claude Desktop (right-click its icon near the clock or in the menu bar, then **Quit**) and open it again.

Then ask Claude: *"Show my 5 latest emails."*

Check the setup at any time with `safe-imap-mcp check`. It validates the config and folders and tests the connection, and tells you exactly what to fix.

## Secure setup (about 15 minutes)

The defaults are already strict: no deleting, encrypted connections, files with keys and passwords are never attached. These steps close the remaining gaps.

1. **Keep passwords out of the config file.** In `init`, choose "environment variable", or edit the config: replace `"password": "..."` with `"passwordEnv": "MAIL_PASSWORD_YOU"` and set that variable (Windows: `setx MAIL_PASSWORD_YOU "your-password"`, then open a new window and restart Claude). Use an app password if your provider offers one.
2. **Narrow the attachment folders.** By default files may be attached from Desktop, Documents and Downloads. Allow only what you need, and put sensitive folders under `approvalFolders` so that every attachment from them needs your **Yes** in a dialog on your computer:

   ```json
   {
     "attachmentFolders": ["C:\\Users\\you\\Documents\\Outgoing"],
     "approvalFolders": ["D:\\Work"],
     "accounts": [ "..." ]
   }
   ```
3. **Approve each send.** When Claude Desktop first asks permission for `send_email` (and for `save_draft` with attachments), choose **Allow once**, never "Always allow".
4. **Look at the activity log now and then.** `sent-log.txt` next to the config records sent mail, drafts with attachments, saved attachments and every Yes/No decision.
5. Run `safe-imap-mcp check` again. Warnings tell you what is still open.

### Configuration reference

The config is at `~/.safe-imap-mcp/accounts.json` (Windows: `C:\Users\<you>\.safe-imap-mcp\accounts.json`). `safe-imap-mcp help` prints the exact path. It is re-read on every call, so changes need no restart.

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
| `attachmentFolders` | top level | Desktop, Documents, Downloads (incl. OneDrive variants) | Folders from which files may be attached freely. Set `[]` to allow none |
| `approvalFolders` | top level | none | Folders from which files may be attached only after you click **Yes** in a dialog on your computer (Windows, macOS; Linux needs `zenity`) |
| `saveFolder` | top level | `Downloads/mail-attachments` | The only folder where received attachments are saved |
| `limits.maxRecipients` | top level | `20` | Max recipients (to + cc + bcc) per message |
| `limits.maxAttachments` | top level | `10` | Max attachments per message |
| `limits.maxAttachmentMB` | top level | `20` | Max total attachment size per message |
| `limits.maxSendsPerHour` | top level | `20` | Max messages sent per hour (counted while the server runs) |


## Advanced setup

### Install from source

```bash
git clone https://github.com/hightengry/safe-imap-mcp.git
cd safe-imap-mcp
npm ci
node index.js init
node index.js install-claude
```

`npm ci` installs exactly the dependency versions in `package-lock.json`. With a source install, an `accounts.json` placed next to `index.js` is used if present.

### Configure Claude Desktop by hand

Open *Settings → Developer → Edit Config* and add, inside `"mcpServers"`:

```json
"email": {
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\path\\to\\safe-imap-mcp\\index.js"]
}
```

`safe-imap-mcp help` prints both paths for your computer. Use full paths: Claude Desktop does not always find `node` on its own.

### Claude Code and other clients

```bash
claude mcp add email -- node /path/to/safe-imap-mcp/index.js
```

Any other MCP client: run `node index.js` (no arguments) as a stdio server.

### Where the config is read from

1. the file in the `MAIL_ACCOUNTS_FILE` environment variable, if set (in Claude Desktop, add `"env": { "MAIL_ACCOUNTS_FILE": "..." }` next to `"args"`);
2. `accounts.json` next to `index.js` (source installs);
3. `~/.safe-imap-mcp/accounts.json`.

### Troubleshooting

- **"running scripts is disabled on this system" in PowerShell:** run `safe-imap-mcp.cmd init` instead, or use Command Prompt.
- **The server does not appear in Claude:** fully quit and reopen Claude Desktop; check *Settings → Developer* for an error; run `safe-imap-mcp check`.
- **Login fails:** the check prints the server's answer. Wrong password and wrong port are the usual causes.

## Safety model

The design goal is that a confused, mistaken or manipulated assistant cannot destroy mail and cannot send anything without your approval. Here is how, and where the limits are.

1. **No destructive operations.** There are no tools and no code paths that delete, move, copy, expunge or rename messages or mailboxes, and the IMAP `\Deleted` flag is never set. `npm test` scans the source for such calls; this catches mistakes, it is not a formal proof. All tools are annotated `destructiveHint: false`.
2. **Read without side effects.** Mailboxes are opened read-only for searching and reading.
3. **Human approval for sending.** The `send_email` description instructs the assistant to show you sender, recipients, subject, full text and attachment paths and wait for your explicit approval. In Claude Desktop, also answer the tool permission prompt for `send_email` with **Allow once** rather than "Always allow", so every send needs a click.
4. **Prompt-injection hygiene.** Incoming mail is untrusted. Tool descriptions tell the assistant to treat message content as data and never to attach files, add recipients, mark mail as read or save attachments because an email asked for it. This relies on the assistant following instructions, which is why points 3, 5 and 6 do not.
5. **Attachment sandbox.** Files can be attached only from `attachmentFolders` and `approvalFolders`. Paths are resolved to the real file first (links, Windows short names), network paths (`\\server\share`), alternate data streams and names ending in a dot or space are rejected before the disk is touched. The program folder, the config file and the send log are refused by file identity, so renamed paths and hard links do not get around it. Files that usually hold secrets are always refused: dot files and hidden folders (`.env`, `.ssh`, `.git`, ...), SSH keys, `.pem/.key/.pfx/.p12`, password databases (`.kdbx`), mail archives (`.pst`), `.rdp/.ovpn`, `accounts*.json`, `credentials.*`, `secrets.*`.
6. **Confirmation on the computer.** Files from `approvalFolders` are attached only after you click **Yes** in a native dialog. The assistant cannot answer it, no answer within 45 seconds means No, and the dialog always appears on top of other windows.
7. **Safe saving.** Received attachments are saved only under `saveFolder`, with sanitised names (no path tricks, no reserved Windows names, no right-to-left filename spoofing), never overwriting anything. On Windows they are marked as downloaded from the internet, so SmartScreen and Office Protected View still warn you. They are never opened.
8. **Encryption.** On ports without implicit TLS, STARTTLS is required, so a password is never sent in clear text.
9. **Recipients you can see.** Each recipient entry must be exactly one address, so what the header shows is what is delivered. Bcc is never sent to recipients but is kept in your own Sent/Drafts copy.
10. **Limits.** Recipients and attachments per message and messages per hour are capped.
11. **Activity log.** `sent-log.txt` next to the config file records sent mail, drafts with attachments, saved attachments and every Yes/No decision in the approval dialog.

### What it does not protect against

- **Passwords on disk.** `accounts.json` stores passwords in plain text unless you use `passwordEnv`. Anyone with access to your user account can read it. Prefer app passwords where your provider offers them, and keep the file private.
- **Approving a bad email.** If you approve a message, it is sent. Read what you approve.
- **Your mail provider's own features.** Server-side filters, forwarding rules and webmail are outside this tool.
- **Misleading message content.** An email can show different text in its HTML view than in its plain-text part, or hide text with styling. The assistant reads the plain text when there is one. Do not trust a summary of a suspicious email more than the email itself.
- **Sensitive files with ordinary names.** A bank statement or an ID scan in an allowed folder can still be attached if you approve the email. Keep `attachmentFolders` narrow.
- **The hourly limit resets when the server restarts.**

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Compatibility notes

- **Hosting mailboxes (Plesk, cPanel, DirectAdmin, Dovecot/Postfix):** the main target, works with password login.
- **Thunderbird, Outlook and other mail programs:** not needed and not touched. The connector logs in to the same mailbox on the mail server directly, so you can keep using your mail program as before, no plugin required. Mail kept only in a program's local folders (not on the server) is not visible to it.
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
