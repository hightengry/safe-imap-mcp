// Shared helpers: configuration, IMAP/SMTP connections, message building, attachment safety.
//
// SAFETY CONTRACT: this file must never contain code that deletes, moves, expunges or
// purges messages or mailboxes. The test suite checks for it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = __dirname;
export const PLACEHOLDER = "PUT_PASSWORD_HERE";

const DEFAULT_LIMITS = { maxRecipients: 20, maxAttachments: 10, maxAttachmentMB: 20 };

export function configPath() {
  return process.env.MAIL_ACCOUNTS_FILE ? path.resolve(process.env.MAIL_ACCOUNTS_FILE) : path.join(APP_DIR, "accounts.json");
}

// Re-read on every call so edits to the config take effect without a restart.
export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Config file not found: ${file}. Copy accounts.example.json to accounts.json and fill it in.`);
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

// Opens an IMAP connection, runs fn, always logs out.
export async function withImap(acc, fn) {
  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: { user: acc.username, pass: acc.password },
    logger: false,
    socketTimeout: 60000,
  });
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

// Finds Sent/Drafts by the server's special-use flag, falling back to common names.
export async function findSpecialFolder(client, specialUse, names) {
  const folders = await client.list();
  const bySpecial = folders.find((f) => f.specialUse === specialUse);
  if (bySpecial) return bySpecial.path;
  const lower = names.map((n) => n.toLowerCase());
  const byName = folders.find((f) => lower.includes(String(f.name).toLowerCase()) || lower.includes(String(f.path).toLowerCase()));
  return byName ? byName.path : null;
}

export function toList(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

export function extractAddress(s) {
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

// ---------- Attachment folder allowlist ----------

export function allowedFolders() {
  const cfg = loadConfig();
  let list = Array.isArray(cfg.attachmentFolders) && cfg.attachmentFolders.length ? cfg.attachmentFolders : null;
  if (!list) {
    const home = os.homedir();
    list = ["Desktop", "Documents", "Downloads", path.join("OneDrive", "Desktop"), path.join("OneDrive", "Documents")].map((p) =>
      path.join(home, p)
    );
  }
  return list
    .map((p) => {
      try {
        return fs.realpathSync(path.resolve(String(p)));
      } catch {
        return null; // folder does not exist on this machine
      }
    })
    .filter(Boolean);
}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
export function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Path must be inside an allowed folder, never inside the program folder,
// and never the config file (passwords) or the send log itself.
function checkPlace(p, what) {
  const folders = allowedFolders();
  if (!folders.some((f) => isInside(p, f))) {
    throw new Error(`${what} ${p} is outside the allowed folders. Allowed: ${folders.join("; ") || "(none found)"}`);
  }
  if (isInside(p, real(APP_DIR))) {
    throw new Error(`Files in the program folder (where the config with passwords may live) cannot be used.`);
  }
  if ([configPath(), sendLogPath()].some((f) => norm(real(f)) === norm(p))) {
    throw new Error(`Refusing to use the config file or send log: ${p}`);
  }
}

export function prepareAttachments(paths) {
  const list = (paths || []).map((s) => String(s).trim()).filter(Boolean);
  if (list.length === 0) return [];
  const lim = limits();
  if (list.length > lim.maxAttachments) throw new Error(`Too many attachments (${list.length}). Limit: ${lim.maxAttachments}.`);
  let total = 0;
  return list.map((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    const real = fs.realpathSync(abs); // resolves symlinks, so links pointing outside are caught
    checkPlace(real, "File");
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`Not a file: ${real}`);
    if (/^accounts.*\.json$/i.test(path.basename(real))) throw new Error(`Refusing to attach a config file: ${real}`);
    total += st.size;
    if (total > lim.maxAttachmentBytes) throw new Error(`Attachments exceed ${lim.maxAttachmentBytes / 1024 / 1024} MB.`);
    return { filename: path.basename(real), content: fs.readFileSync(real), size: st.size, path: real };
  });
}

export function safeFileName(name, fallback) {
  let n = path
    .basename(String(name || "").replace(/\\/g, "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = "_" + n;
  return n.slice(0, 180) || fallback;
}

export function prepareSaveDir(dir) {
  const abs = path.resolve(dir);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  checkPlace(path.join(fs.realpathSync(probe), path.relative(probe, abs)), "Folder");
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

// Never overwrites: "file.pdf", "file (1).pdf", ...
export function writeUnique(dir, name, data) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  fs.writeFileSync(target, data, { flag: "wx" });
  return target;
}

// ---------- Message building and sending ----------

export async function buildMessage(acc, { to, cc, bcc, subject, body, inReplyTo, references, attachments }) {
  const toL = toList(to);
  const ccL = toList(cc);
  const bccL = toList(bcc);
  const all = [...toL, ...ccL, ...bccL];
  const lim = limits();
  if (toL.length === 0) throw new Error("No recipient (to).");
  if (all.length > lim.maxRecipients) {
    throw new Error(`Too many recipients (${all.length}). Limit: ${lim.maxRecipients}. This tool is not for bulk mail.`);
  }
  for (const a of all) {
    if (/[\r\n]/.test(a) || !EMAIL_RE.test(extractAddress(a))) throw new Error(`Invalid email address: ${a}`);
  }
  if (!subject || !String(subject).trim()) throw new Error("Subject is empty.");
  if (!body || !String(body).trim()) throw new Error("Body is empty.");

  const from = acc.fromName ? { name: acc.fromName, address: acc.email } : acc.email;
  const domain = acc.email.split("@")[1] || "localhost";
  const mail = {
    from,
    to: toL,
    cc: ccL.length ? ccL : undefined,
    bcc: bccL.length ? bccL : undefined,
    subject: String(subject),
    text: String(body),
    date: new Date(),
    messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  };
  const files = prepareAttachments(attachments);
  if (files.length) mail.attachments = files.map((f) => ({ filename: f.filename, content: f.content }));
  const raw = await new MailComposer(mail).compile().build();
  return {
    raw,
    envelope: { from: acc.email, to: all.map(extractAddress) },
    recipients: all,
    attached: files.map((f) => `${f.filename} (${Math.ceil(f.size / 1024)} KB)`),
  };
}

export function smtpTransport(acc) {
  return nodemailer.createTransport({
    host: acc.smtpHost,
    port: acc.smtpPort,
    secure: acc.smtpSecure,
    auth: { user: acc.username, pass: acc.password },
  });
}

export function logSend(line) {
  try {
    fs.appendFileSync(sendLogPath(), `${new Date().toISOString()}  ${line}\n`, "utf8");
  } catch {
    /* logging is best-effort */
  }
}
