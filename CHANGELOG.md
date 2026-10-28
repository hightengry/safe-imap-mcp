# Changelog

## 1.0.0

First public release.

- Read-only tools: `list_accounts`, `list_folders`, `search_emails`, `read_email`, `list_attachment_folders`.
- Write tools without destructive operations: `mark_as_read`, `save_attachments`, `save_draft`, `send_email` (with replies in thread and attachments).
- Multiple mailboxes on any IMAP/SMTP server; passwords from the config file or environment variables.
- Attachment folder allowlist, recipient and attachment limits, send log.
- Offline safety test suite (`npm test`).
