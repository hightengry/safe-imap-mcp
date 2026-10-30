# Changelog

## 1.1.0

Easier, safer setup. No change to what the assistant can do with mail.

- `safe-imap-mcp init`: step-by-step setup wizard; passwords are hidden while typing, or kept in an environment variable.
- `safe-imap-mcp check`: validates Node.js, the config, every mailbox and the folders, then tests IMAP and SMTP, with a clear message for each problem (`--offline` skips the connection test).
- `safe-imap-mcp install-claude`: adds the server to Claude Desktop with a backup, a confirmation and full paths to Node.js and the server; never replaces an existing entry without `--force`.
- Installable from npm: `npm install -g safe-imap-mcp`. For global installs the config lives in `~/.safe-imap-mcp/accounts.json`; source installs keep using `accounts.json` next to the program.
- The activity log now also records drafts with attachments, saved attachments and every Yes/No decision in the approval dialog.
- README restructured into Quick start, Secure setup and Advanced setup.

## 1.0.0

First public release.

- Read-only tools: `list_accounts`, `list_folders`, `search_emails`, `read_email`, `list_attachment_folders`.
- Write tools without destructive operations: `mark_as_read`, `save_attachments`, `save_draft`, `send_email` (replies in thread, attachments).
- Multiple mailboxes on any IMAP/SMTP server; passwords from the config file or environment variables.
- Mandatory encryption: STARTTLS is required on ports without implicit TLS.
- Attachment sandbox: folder allowlist, file-identity checks for the config file and send log, rejection of network paths, Windows short names and alternate data streams, and a fixed blocklist of files that usually hold secrets.
- Optional approval folders: attaching from them requires a Yes/No dialog on the user's computer.
- Received attachments are saved only into one folder, with sanitised names, never overwriting, marked as downloaded from the internet on Windows.
- Recipient parsing that keeps the visible header and the actual delivery identical; Bcc kept in the sender's own copy.
- Limits per message and per hour; send log.
- Offline safety test suite (`npm test`), reviewed by an independent audit before release.
