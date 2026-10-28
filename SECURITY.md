# Security policy

## Scope

`safe-imap-mcp` promises one thing above all: an assistant using it cannot delete, move or expunge email, and cannot attach files from outside the configured folders. A way around either of these is a security issue. So is anything that leaks the passwords in `accounts.json`.

## Reporting

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

Include what you did, what happened, and the version (`package.json`). You will get a reply as soon as possible.

## Hardening tips for users

- Use app passwords or `passwordEnv` instead of your main password in `accounts.json`.
- Keep `attachmentFolders` as narrow as you can.
- In Claude Desktop, approve `send_email` with **Allow once**, never "Always allow".
- Review `sent-log.txt` from time to time.
- Keep dependencies current: `npm audit` and `npm update`.
