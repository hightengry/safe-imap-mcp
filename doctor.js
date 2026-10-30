// "check": validates the config, folders and (unless --offline) the mail server connections.
// Sends nothing and changes nothing. Returns 0 if ready, 1 if something must be fixed.

import fs from "node:fs";
import path from "node:path";
import {
  APP_DIR,
  PLACEHOLDER,
  configSource,
  loadAccounts,
  allowedFolders,
  approvalFolders,
  saveRoot,
  withImap,
  smtpTransport,
  isInside,
} from "./lib.js";

const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

export async function runCheck({ offline = false, out = console.log } = {}) {
  let errors = 0;
  let warnings = 0;
  const ok = (m) => out(`  ok    ${m}`);
  const warn = (m) => {
    warnings++;
    out(`  WARN  ${m}`);
  };
  const err = (m) => {
    errors++;
    out(`  ERROR ${m}`);
  };

  out("safe-imap-mcp check\n");

  // 1. Node.js
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`);
  else err(`Node.js ${process.versions.node} is too old. Install version 20 or newer from nodejs.org.`);

  // 2. Config file
  const src = configSource();
  if (!fs.existsSync(src.path)) {
    err(`Config file not found: ${src.path}. Run "safe-imap-mcp init" to create it.`);
    return finish();
  }
  ok(`Config: ${src.path} (from ${src.from})`);

  let raw = fs.readFileSync(src.path, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    err(`Config is not valid JSON: ${e.message}. A missing comma or quote is the usual cause.`);
    return finish();
  }

  if (process.platform !== "win32") {
    const mode = fs.statSync(src.path).mode & 0o777;
    if (mode & 0o077) warn(`Config can be read by other users on this computer. Fix with: chmod 600 "${src.path}"`);
  }

  // 3. Accounts
  const list = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  if (list.length === 0) err(`No mailboxes in "accounts".`);
  const seen = new Set();
  for (const a of list) {
    const email = String(a.email || "").trim().toLowerCase();
    const d = cfg.defaults || {};
    const label = email || "(account without email)";
    if (!EMAIL_RE.test(email)) err(`${label}: "email" is missing or invalid.`);
    if (seen.has(email)) warn(`${label}: listed more than once.`);
    seen.add(email);
    for (const k of ["imapHost", "smtpHost"]) if (!(a[k] || d[k])) err(`${label}: "${k}" is not set (in the account or in "defaults").`);
    for (const k of ["imapPort", "smtpPort"]) {
      const v = a[k] ?? d[k];
      if (v !== undefined && !(Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536)) err(`${label}: "${k}" must be a port number.`);
    }
    if (a.passwordEnv) {
      if (process.env[a.passwordEnv]) ok(`${label}: password from environment variable ${a.passwordEnv}`);
      else
        err(
          `${label}: environment variable ${a.passwordEnv} is not set in this window. Set it, then open a new terminal and restart Claude so they see it.`
        );
    } else if (!a.password || a.password === PLACEHOLDER) {
      err(`${label}: no password. Set "password" or "passwordEnv".`);
    } else {
      warn(`${label}: password is stored as plain text in the config. Safer: use "passwordEnv" or an app password.`);
    }
  }

  // 4. Folders
  const free = allowedFolders();
  const configuredFree = Array.isArray(cfg.attachmentFolders);
  out("");
  ok(`Attach freely from: ${free.length ? free.join("; ") : "(nowhere)"}${configuredFree ? "" : " (default)"}`);
  if (configuredFree) {
    for (const f of cfg.attachmentFolders) if (!free.some((x) => path.resolve(x).toLowerCase() === path.resolve(String(f)).toLowerCase())) warn(`attachmentFolders: "${f}" does not exist or is not allowed.`);
  }
  const guarded = approvalFolders();
  if (Array.isArray(cfg.approvalFolders) && cfg.approvalFolders.length) {
    ok(`Attach only after Yes/No dialog: ${guarded.join("; ") || "(none found)"}`);
    if (guarded.length < cfg.approvalFolders.length) warn(`approvalFolders: some folders do not exist.`);
  }
  try {
    ok(`Received attachments are saved to: ${saveRoot()}`);
  } catch (e) {
    err(`saveFolder: ${e.message}`);
  }
  if ([...free, ...guarded].some((f) => isInside(APP_DIR, f))) {
    out(`  note  The program folder lies inside an allowed folder. Its files are refused anyway; moving it out is tidier.`);
  }

  // 5. Connections
  if (offline) {
    out("\n  (connection test skipped: --offline)");
    return finish();
  }
  out("");
  let accounts = [];
  try {
    accounts = loadAccounts();
  } catch (e) {
    err(e.message);
  }
  for (const acc of accounts) {
    if (!acc.ready) continue;
    try {
      const st = await withImap(acc, (c) => c.status("INBOX", { messages: true, unseen: true }));
      ok(`${acc.email}: IMAP (read) works, ${st.messages} messages, ${st.unseen} unread`);
    } catch (e) {
      err(`${acc.email}: IMAP (read) failed: ${e.responseText || e.message}`);
    }
    try {
      await smtpTransport(acc).verify();
      ok(`${acc.email}: SMTP (send) works`);
    } catch (e) {
      err(`${acc.email}: SMTP (send) failed: ${e.message}`);
    }
  }

  return finish();

  function finish() {
    out(
      errors
        ? `\n${errors} error(s), ${warnings} warning(s). Fix the errors above, then run the check again.`
        : `\nReady. ${warnings ? `${warnings} warning(s) above are worth a look.` : "No warnings."}`
    );
    return errors ? 1 : 0;
  }
}
