// Shared helpers: configuration, IMAP/SMTP connections, message building, file safety.
//
// SAFETY CONTRACT: this file must never contain code that deletes, moves, copies, expunges or
// renames messages or mailboxes, or that sets the IMAP Deleted flag. The test suite checks for it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import addressparser from "nodemailer/lib/addressparser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = __dirname;
export const PLACEHOLDER = "PUT_PASSWORD_HERE";

const DEFAULT_LIMITS = { maxRecipients: 20, maxAttachments: 10, maxAttachmentMB: 20, maxSendsPerHour: 20 };
const IS_WIN = process.platform === "win32";
const CASE_INSENSITIVE = IS_WIN || process.platform === "darwin";

// ---------- Configuration ----------

// Default location for a global (npm) install: a folder in the user's home.
export function homeConfigPath() {
  return path.join(os.homedir(), ".safe-imap-mcp", "accounts.json");
}

// Where the config is read from, in order:
// 1. MAIL_ACCOUNTS_FILE, 2. accounts.json next to the program (cloned installs), 3. ~/.safe-imap-mcp/accounts.json
export function configSource() {
  if (process.env.MAIL_ACCOUNTS_FILE) return { path: path.resolve(process.env.MAIL_ACCOUNTS_FILE), from: "MAIL_ACCOUNTS_FILE" };
  const local = path.join(APP_DIR, "accounts.json");
  if (fs.existsSync(local)) return { path: local, from: "program folder" };
  return { path: homeConfigPath(), from: "home folder" };
}

export function configPath() {
  return configSource().path;
}

// Re-read on every call so edits to the config take effect without a restart.
export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Config file not found: ${file}. Run "safe-imap-mcp init" (or "npm run init") to create it.`);
  }
  let raw = fs.readFileSync(file, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // Windows Notepad may add a BOM
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config file ${file} is not valid JSON: ${e.message}`);
  }
}

export function limits() {
  const l = loadConfig().limits || {};
  return {
    maxRecipients: Number(l.maxRecipients) || DEFAULT_LIMITS.maxRecipients,
    maxAttachments: Number(l.maxAttachments) || DEFAULT_LIMITS.maxAttachments,
    maxAttachmentBytes: (Number(l.maxAttachmentMB) || DEFAULT_LIMITS.maxAttachmentMB) * 1024 * 1024,
    maxSendsPerHour: Number(l.maxSendsPerHour) || DEFAULT_LIMITS.maxSendsPerHour,
  };
}

export function sendLogPath() {
  return path.join(path.dirname(configPath()), "sent-log.txt");
}

function resolvePassword(a) {
  if (a.passwordEnv) return process.env[a.passwordEnv] || "";
  return a.password || "";
}

export function loadAccounts() {
  const cfg = loadConfig();
  const d = cfg.defaults || {};
  const list = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  return list.map((a) => {
    const password = resolvePassword(a);
    const imapPort = Number(a.imapPort || d.imapPort || 993);
    const smtpPort = Number(a.smtpPort || d.smtpPort || 465);
    const imapHost = a.imapHost || d.imapHost || "";
    const smtpHost = a.smtpHost || d.smtpHost || "";
    return {
      email: String(a.email || "").trim().toLowerCase(),
      username: a.username || d.username || String(a.email || "").trim(),
      fromName: a.fromName || "",
      password,
      imapHost,
      imapPort,
      imapSecure: a.imapSecure ?? d.imapSecure ?? imapPort === 993,
      smtpHost,
      smtpPort,
      smtpSecure: a.smtpSecure ?? d.smtpSecure ?? smtpPort === 465,
      ready: Boolean(password) && password !== PLACEHOLDER && Boolean(imapHost) && Boolean(smtpHost),
    };
  });
}

export function getAccount(email) {
  const want = String(email || "").trim().toLowerCase();
  const all = loadAccounts();
  const acc = all.find((a) => a.email === want);
  if (!acc) throw new Error(`Account ${email} is not configured. Configured accounts: ${all.map((a) => a.email).join(", ")}`);
  if (!acc.password || acc.password === PLACEHOLDER) throw new Error(`No password set for ${acc.email}.`);
  if (!acc.imapHost || !acc.smtpHost) throw new Error(`imapHost/smtpHost not set for ${acc.email}.`);
  return acc;
}

// ---------- Connections (encryption is mandatory) ----------

export function imapOptions(acc) {
  return {
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    // Without implicit TLS, STARTTLS is required: the password is never sent unencrypted.
    ...(acc.imapSecure ? {} : { doSTARTTLS: true }),
    auth: { user: acc.username, pass: acc.password },
    logger: false,
    socketTimeout: 60000,
  };
}

export async function withImap(acc, fn) {
  const client = new ImapFlow(imapOptions(acc));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* already closed */
    }
  }
}

export function smtpTransport(acc) {
  return nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    requireTLS: !acc.smtpSecure, // STARTTLS is required when the port has no implicit TLS
    auth: { user: acc.username, pass: acc.password },
  });
}

// Finds Sent/Drafts by the server's special-use flag, falling back to common names.
export async function findSpecialFolder(client, specialUse, names) {
  const folders = await client.list();
  const bySpecial = folders.find((f) => f.specialUse === specialUse);
  if (bySpecial) return bySpecial.path;
  const lower = names.map((n) => n.toLowerCase());
  const byName = folders.find((f) => lower.includes(String(f.name).toLowerCase()) || lower.includes(String(f.path).toLowerCase()));
  return byName ? byName.path : null;
}

// ---------- Path safety ----------

const norm = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

export function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Rejects path forms that can bypass checks, before the file system is touched.
// `platform` is a parameter so the Windows rules can be tested on any system.
export function checkPathText(p, platform = process.platform) {
  const s = String(p);
  if (/[\u0000-\u001f]/.test(s)) throw new Error(`Path contains control characters: ${JSON.stringify(s)}`);
  if (/^(\\\\|\/\/)/.test(s)) throw new Error(`Network and device paths (\\\\server\\share, \\\\?\\) are not allowed: ${s}`);
  if (platform === "win32") {
    const parts = s.split(/[\\/]+/).filter(Boolean);
    parts.forEach((seg, i) => {
      if (i === 0 && /^[A-Za-z]:$/.test(seg)) return; // drive letter
      if (seg.includes(":")) throw new Error(`Alternate data streams are not allowed: ${s}`);
      if (/~\d/.test(seg)) throw new Error(`Short (8.3) file names are not allowed, use the full name: ${s}`);
      if (seg !== "." && seg !== ".." && /[. ]$/.test(seg)) throw new Error(`Names ending with a dot or space are not allowed: ${s}`);
    });
  }
}

const realpath = (p) => (fs.realpathSync.native || fs.realpathSync)(p);

function fileId(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

// True if `p` is `dir` or lies under it, judged by real file identity (immune to case, short names, links).
function underByIdentity(p, dir) {
  const target = fileId(dir);
  if (!target) return false;
  let cur = p;
  for (;;) {
    if (fileId(cur) === target) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// Files that commonly hold passwords or keys. They can never be attached.
const SENSITIVE_EXT = /\.(pem|key|p12|pfx|jks|keystore|kdbx|kdb|ppk|ovpn|rdp|pst|ost|gpg|asc|sqlite|db)$/i;
const SENSITIVE_NAME = [
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^accounts.*\.json$/i,
  /^(credentials|secrets?)(\.[a-z0-9]+)?$/i,
  /\.env(\.[a-z0-9_-]+)?$/i,
  /^env\.(local|production|development|prod|dev)$/i,
  /^wp-config\.php$/i,
  /^(known_hosts|authorized_keys)$/i,
];

export function sensitiveReason(p) {
  const parts = path.resolve(p).split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] || "";
  if (base.startsWith(".")) return "hidden/dot files (.env, .npmrc, ...) may contain secrets";
  if (parts.slice(0, -1).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..")) return "files inside hidden folders (.ssh, .git, .aws, ...) may contain secrets";
  if (SENSITIVE_EXT.test(base)) return "keys, password databases, mail archives and remote-access files may contain secrets";
  if (SENSITIVE_NAME.some((re) => re.test(base))) return "this file name is typical for passwords or keys";
  return null;
}

function readFolderList(list) {
  return (list || [])
    .map((p) => {
      try {
        checkPathText(p);
        return realpath(path.resolve(String(p)));
      } catch {
        return null; // folder does not exist or is not allowed
      }
    })
    .filter(Boolean);
}

// Folders whose files may be attached freely.
export function allowedFolders() {
  const cfg = loadConfig();
  if (Array.isArray(cfg.attachmentFolders)) return readFolderList(cfg.attachmentFolders);
  const home = os.homedir();
  return readFolderList(["Desktop", "Documents", "Downloads", path.join("OneDrive", "Desktop"), path.join("OneDrive", "Documents")].map((p) => path.join(home, p)));
}

// Folders whose files may be attached only after a confirmation dialog on this computer.
export function approvalFolders() {
  return readFolderList(loadConfig().approvalFolders);
}

// The one folder where received attachments are saved.
export function saveRoot() {
  const cfg = loadConfig();
  const dir = cfg.saveFolder ? path.resolve(String(cfg.saveFolder)) : path.join(os.homedir(), "Downloads", "mail-attachments");
  checkPathText(dir);
  return dir;
}

function assertNotProtected(p) {
  if (underByIdentity(p, APP_DIR) || isInside(p, APP_DIR)) {
    throw new Error(`Files in the program folder (where the config with passwords may live) cannot be used.`);
  }
  const pid = fileId(p);
  for (const f of [configPath(), sendLogPath()]) {
    if (pid && pid === fileId(f)) throw new Error(`Refusing to use the config file or send log: ${p}`);
  }
}

// Validates attachment paths. Returns files plus the subset that needs approval.
export function checkAttachmentPaths(paths) {
  const list = (paths || []).map((s) => String(s).trim()).filter(Boolean);
  const lim = limits();
  if (list.length > lim.maxAttachments) throw new Error(`Too many attachments (${list.length}). Limit: ${lim.maxAttachments}.`);
  const free = allowedFolders();
  const guarded = approvalFolders();
  let total = 0;
  const files = list.map((p) => {
    checkPathText(p);
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    const real = realpath(abs); // resolves links and short names
    checkPathText(real);
    const inFree = free.some((f) => isInside(real, f));
    const inGuarded = guarded.some((f) => isInside(real, f));
    if (!inFree && !inGuarded) {
      throw new Error(`File ${real} is outside the allowed folders. Allowed: ${[...free, ...guarded].join("; ") || "(none found)"}`);
    }
    assertNotProtected(real);
    const why = sensitiveReason(real);
    if (why) throw new Error(`Refusing to attach ${real}: ${why}.`);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`Not a file: ${real}`);
    total += st.size;
    if (total > lim.maxAttachmentBytes) throw new Error(`Attachments exceed ${lim.maxAttachmentBytes / 1024 / 1024} MB.`);
    return { path: real, filename: path.basename(real), size: st.size, needsApproval: inGuarded && !inFree };
  });
  return files;
}

// ---------- Confirmation dialog on the computer ----------

// Seconds the dialog waits for an answer; no answer means No. Kept short so the tool call returns
// before MCP clients give up waiting.
export const DIALOG_SECONDS = 45;

function nativeDialog(message) {
  return new Promise((resolve) => {
    const env = { ...process.env, SAFE_IMAP_MSG: message };
    const hardStop = (DIALOG_SECONDS + 10) * 1000;
    if (IS_WIN) {
      // System-modal popup: always on top of other windows, "No" is the default button,
      // closes itself after DIALOG_SECONDS. Returns 6 = Yes, 7 = No, -1 = timed out.
      // Flags: 4 YesNo + 48 warning icon + 256 second button default + 4096 system modal + 65536 foreground.
      const ps = `$r = (New-Object -ComObject WScript.Shell).Popup($env:SAFE_IMAP_MSG, ${DIALOG_SECONDS}, 'safe-imap-mcp: approve attachment', 69940); Write-Output $r`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { env, timeout: hardStop, windowsHide: true }, (err, out) =>
        resolve(!err && String(out).trim() === "6")
      );
    } else if (process.platform === "darwin") {
      const script = `display dialog (system attribute "SAFE_IMAP_MSG") with title "safe-imap-mcp" buttons {"Deny", "Allow"} default button "Deny" with icon caution giving up after ${DIALOG_SECONDS}`;
      execFile("osascript", ["-e", script], { env, timeout: hardStop }, (err, out) => resolve(!err && /button returned:Allow/.test(String(out)) && !/gave up:true/.test(String(out))));
    } else {
      execFile(
        "zenity",
        ["--question", "--title=safe-imap-mcp", "--text", message, "--ok-label=Allow", "--cancel-label=Deny", `--timeout=${DIALOG_SECONDS}`],
        { env, timeout: hardStop },
        (err) => resolve(!err)
      );
    }
  });
}

let approver = nativeDialog;
// For tests only: replaces the dialog. Not reachable from any tool.
export function _setApproverForTests(fn) {
  approver = fn;
}

async function requireApproval(files, ctx) {
  const lines = files.map((f) => `  ${f.path} (${Math.ceil(f.size / 1024)} KB)`).join("\n");
  const msg =
    `The AI assistant wants to ${ctx.action} with files from a protected folder:\n\n${lines}\n\n` +
    `From: ${ctx.from}\nTo: ${ctx.to.join(", ")}\nSubject: ${String(ctx.subject).slice(0, 150)}\n\nAllow this?`;
  const ok = await approver(msg.slice(0, 3000));
  logSend(
    `${ok ? "APPROVED" : "DENIED"}  ${ctx.action} with protected files  from: ${ctx.from}  to: ${ctx.to.join(", ")}  files: ${files.map((f) => f.path).join(", ")}`
  );
  if (!ok) throw new Error("Not approved on the computer: the attachment from a protected folder was refused or the dialog timed out.");
}

// ---------- Recipients ----------

const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

// Each entry must be exactly one address, so what the header shows is what is delivered.
export function parseRecipient(s) {
  const raw = String(s);
  if (/[\r\n]/.test(raw)) throw new Error(`Invalid email address: ${JSON.stringify(raw)}`);
  const parsed = addressparser(raw);
  if (parsed.length !== 1 || parsed[0].group || !parsed[0].address || !EMAIL_RE.test(parsed[0].address)) {
    throw new Error(`Each recipient entry must contain exactly one valid address: ${raw}`);
  }
  return { name: parsed[0].name || "", address: parsed[0].address };
}

// ---------- Message building ----------

export async function buildMessage(acc, { to, cc, bcc, subject, body, inReplyTo, references, attachments }, action = "send an email") {
  const toL = (to || []).map(parseRecipient);
  const ccL = (cc || []).map(parseRecipient);
  const bccL = (bcc || []).map(parseRecipient);
  const all = [...toL, ...ccL, ...bccL];
  const lim = limits();
  if (toL.length === 0) throw new Error("No recipient (to).");
  if (all.length > lim.maxRecipients) {
    throw new Error(`Too many recipients (${all.length}). Limit: ${lim.maxRecipients}. This tool is not for bulk mail.`);
  }
  if (!subject || !String(subject).trim()) throw new Error("Subject is empty.");
  if (!body || !String(body).trim()) throw new Error("Body is empty.");

  const files = checkAttachmentPaths(attachments);
  const guarded = files.filter((f) => f.needsApproval);
  if (guarded.length) await requireApproval(guarded, { action, from: acc.email, to: all.map((a) => a.address), subject });

  const fmt = (a) => (a.name ? { name: a.name, address: a.address } : a.address);
  const domain = acc.email.split("@")[1] || "localhost";
  const mail = {
    from: acc.fromName ? { name: acc.fromName, address: acc.email } : acc.email,
    to: toL.map(fmt),
    cc: ccL.length ? ccL.map(fmt) : undefined,
    bcc: bccL.length ? bccL.map(fmt) : undefined,
    subject: String(subject),
    text: String(body),
    date: new Date(),
    messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  };
  if (files.length) mail.attachments = files.map((f) => ({ filename: f.filename, content: fs.readFileSync(f.path) }));

  // What goes over SMTP never contains Bcc. The copy kept in the sender's own Sent/Drafts does.
  const raw = await new MailComposer(mail).compile().build();
  const storedNode = new MailComposer(mail).compile();
  storedNode.keepBcc = true;
  const rawStored = await storedNode.build();

  return {
    raw,
    rawStored,
    envelope: { from: acc.email, to: all.map((a) => a.address) },
    recipients: all.map((a) => a.address),
    attached: files.map((f) => `${f.filename} (${Math.ceil(f.size / 1024)} KB)`),
  };
}

// ---------- Send rate limit and log ----------

const sendTimes = [];
export function checkSendRate() {
  const now = Date.now();
  while (sendTimes.length && now - sendTimes[0] > 3600_000) sendTimes.shift();
  const max = limits().maxSendsPerHour;
  if (sendTimes.length >= max) throw new Error(`Send limit reached: ${max} messages per hour. Try again later or raise limits.maxSendsPerHour.`);
}
export function recordSend() {
  sendTimes.push(Date.now());
}

export function logSend(line) {
  try {
    fs.appendFileSync(sendLogPath(), `${new Date().toISOString()}  ${line}\n`, "utf8");
  } catch {
    /* logging is best-effort */
  }
}

// ---------- Saving received attachments ----------

export function safeFileName(name, fallback) {
  let n = path
    .basename(String(name || "").replace(/\\/g, "/"))
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "") // invisible and right-to-left tricks
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(n)) n = "_" + n;
  return n.slice(0, 180) || fallback;
}

// Resolves a subfolder (e.g. "mailbox/123") inside the save root. No hidden folders, no escaping.
export function prepareSaveDir(subfolder) {
  const root = saveRoot();
  const segs = String(subfolder || "")
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const s of segs) {
    if (s === "." || s === ".." || s.startsWith(".")) throw new Error(`Invalid subfolder name: ${s}`);
  }
  const dir = path.join(root, ...segs.map((s) => safeFileName(s, "_")));
  if (!isInside(dir, root)) throw new Error("Attachments can only be saved inside the attachments folder.");
  fs.mkdirSync(dir, { recursive: true });
  if (!underByIdentity(realpath(dir), realpath(root))) throw new Error("Attachments can only be saved inside the attachments folder.");
  assertNotProtected(realpath(dir));
  return dir;
}

// Never overwrites: "file.pdf", "file (1).pdf", ... On Windows, marks the file as downloaded
// from the internet so SmartScreen and Office Protected View still apply.
export function writeUnique(dir, name, data) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  fs.writeFileSync(target, data, { flag: "wx" });
  if (IS_WIN) {
    try {
      fs.writeFileSync(`${target}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
    } catch {
      /* not NTFS */
    }
  }
  return target;
}
