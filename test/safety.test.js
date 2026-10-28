// Safety tests. They run fully offline: no mail server is contacted, no dialog is shown.
// Run: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { simpleParser } from "mailparser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tmp, cfgDir, allowed, guarded, outside, saveDir, lib;
let dialogCalls = [];
let dialogAnswer = false;

function writeConfig(extra = {}) {
  const cfg = {
    defaults: { imapHost: "mail.example.com", smtpHost: "mail.example.com" },
    attachmentFolders: [allowed],
    approvalFolders: [guarded],
    saveFolder: saveDir,
    accounts: [
      { email: "you@example.com", fromName: "You", password: "secret" },
      { email: "env@example.com", passwordEnv: "SAFE_IMAP_TEST_PASSWORD" },
      { email: "empty@example.com", password: "PUT_PASSWORD_HERE" },
    ],
    ...extra,
  };
  fs.writeFileSync(path.join(cfgDir, "accounts.json"), JSON.stringify(cfg));
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-imap-mcp-")));
  cfgDir = path.join(tmp, "config");
  allowed = path.join(tmp, "allowed");
  guarded = path.join(tmp, "projects");
  outside = path.join(tmp, "outside");
  saveDir = path.join(tmp, "saved");
  for (const d of [cfgDir, allowed, guarded, outside, path.join(allowed, ".ssh")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(allowed, "report.pdf"), "report");
  fs.writeFileSync(path.join(guarded, "plan.pdf"), "plan");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  for (const f of [".env", "prod.env", "id_rsa", "vault.kdbx", "server.pem", "accounts.backup.json", "credentials.json"]) {
    fs.writeFileSync(path.join(allowed, f), "x");
  }
  fs.writeFileSync(path.join(allowed, ".ssh", "config"), "x");
  process.env.MAIL_ACCOUNTS_FILE = path.join(cfgDir, "accounts.json");
  writeConfig();
  lib = await import(path.join(ROOT, "lib.js"));
  lib._setApproverForTests(async (msg) => {
    dialogCalls.push(msg);
    return dialogAnswer;
  });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const acc = () => lib.getAccount("you@example.com");
const base = { to: ["a@example.org"], subject: "Hello", body: "Text" };

test("source code contains no delete/move/copy/expunge/rename operations", () => {
  const forbidden = /messageDelete|messageMove|messageCopy|mailboxDelete|mailboxCreate|mailboxRename|expunge|\\Deleted|\.exec\s*\(|unlink|rmSync|rmdir/i;
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"));
  assert.ok(files.includes("index.js") && files.includes("lib.js"));
  for (const f of files) {
    const code = fs
      .readFileSync(path.join(ROOT, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const m = code.match(forbidden);
    assert.equal(m, null, `${f} contains forbidden operation: ${m && m[0]}`);
  }
});

test("server exposes exactly the expected tools, none destructive", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "index.js")], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const deadline = Date.now() + 10000;
  while (!out.includes('"id":2') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const msg = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert.ok(msg, "no tools/list response");
  const tools = msg.result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "list_accounts",
    "list_attachment_folders",
    "list_folders",
    "mark_as_read",
    "read_email",
    "save_attachments",
    "save_draft",
    "search_emails",
    "send_email",
  ]);
  for (const t of tools) {
    assert.ok(!/delete|remove|move|trash|expunge|purge/i.test(t.name), `suspicious tool ${t.name}`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} must be non-destructive`);
  }
  const save = tools.find((t) => t.name === "save_attachments");
  assert.ok(!("save_to" in save.inputSchema.properties), "save_attachments must not accept arbitrary target paths");
});

test("passwords: plain, from environment variable, placeholder rejected", () => {
  assert.equal(acc().password, "secret");
  process.env.SAFE_IMAP_TEST_PASSWORD = "from-env";
  assert.equal(lib.getAccount("env@example.com").password, "from-env");
  assert.throws(() => lib.getAccount("empty@example.com"), /No password/);
  assert.throws(() => lib.getAccount("nobody@example.com"), /not configured/);
});

test("encryption is mandatory on STARTTLS ports", () => {
  const a = { ...acc(), imapPort: 143, imapSecure: false, smtpPort: 587, smtpSecure: false };
  assert.equal(lib.imapOptions(a).doSTARTTLS, true);
  assert.equal(lib.smtpTransport(a).options.requireTLS, true);
  const b = acc(); // 993 / 465 implicit TLS
  assert.equal(lib.imapOptions(b).secure, true);
  assert.equal(lib.smtpTransport(b).options.secure, true);
});

test("attaches a file from an allowed folder without a dialog", async () => {
  dialogCalls = [];
  const m = await lib.buildMessage(acc(), { ...base, attachments: [path.join(allowed, "report.pdf")] });
  assert.match(m.raw.toString(), /filename=report\.pdf/);
  assert.equal(dialogCalls.length, 0);
});

test("approval folder: attaches only after Yes in the dialog on the computer", async () => {
  dialogCalls = [];
  dialogAnswer = false;
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(guarded, "plan.pdf")] }), /Not approved/);
  assert.equal(dialogCalls.length, 1);
  assert.match(dialogCalls[0], /plan\.pdf/);
  assert.match(dialogCalls[0], /a@example\.org/);
  dialogAnswer = true;
  const m = await lib.buildMessage(acc(), { ...base, attachments: [path.join(guarded, "plan.pdf")] });
  assert.equal(m.attached.length, 1);
  dialogAnswer = false;
});

test("refuses files with keys or passwords even inside allowed folders", async () => {
  for (const f of [".env", "prod.env", "id_rsa", "vault.kdbx", "server.pem", "accounts.backup.json", "credentials.json", path.join(".ssh", "config")]) {
    await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(allowed, f)] }), /Refusing to attach/, f);
  }
});

test("rejects attachments outside allowed folders or via '..'", async () => {
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(outside, "secret.txt")] }), /outside the allowed/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(allowed, "..", "outside", "secret.txt")] }), /outside the allowed/);
});

test("config file and send log are refused by identity, including hard links", async () => {
  writeConfig({ attachmentFolders: [tmp] });
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "accounts.json")] }), /config file|Refusing/);
  fs.writeFileSync(path.join(cfgDir, "sent-log.txt"), "log");
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "sent-log.txt")] }), /config file or send log/);
  const hard = path.join(tmp, "allowed", "innocent.txt");
  try {
    fs.linkSync(path.join(cfgDir, "sent-log.txt"), hard);
    await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [hard] }), /config file or send log/);
  } finally {
    fs.rmSync(hard, { force: true });
  }
  fs.writeFileSync(path.join(cfgDir, "notes.txt"), "ok");
  const m = await lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "notes.txt")] });
  assert.equal(m.attached.length, 1);
  writeConfig();
});

test("files from the program folder are refused even if it is inside an allowed folder", async () => {
  writeConfig({ attachmentFolders: [path.dirname(ROOT)] });
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(ROOT, "README.md")] }), /program folder/);
  writeConfig();
});

test("rejects symlinks that point outside allowed folders", async (t) => {
  const link = path.join(allowed, "link.txt");
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), link);
  } catch {
    t.skip("symlinks not permitted on this system");
    return;
  }
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [link] }), /outside the allowed/);
});

test("dangerous path forms are rejected before touching the file system", () => {
  assert.throws(() => lib.checkPathText("\\\\attacker\\share\\x.pdf", "win32"), /Network/);
  assert.throws(() => lib.checkPathText("//attacker/share/x.pdf", "linux"), /Network/);
  assert.throws(() => lib.checkPathText("\\\\?\\C:\\x.pdf", "win32"), /Network/);
  assert.throws(() => lib.checkPathText("C:\\Users\\me\\Downloads\\SAFE-I~1\\ACCOUN~1.JSO", "win32"), /Short/);
  assert.throws(() => lib.checkPathText("C:\\Users\\me\\Downloads\\app.\\accounts.json", "win32"), /dot or space/);
  assert.throws(() => lib.checkPathText("C:\\Users\\me\\Downloads\\accounts.json::$DATA", "win32"), /data streams/);
  assert.throws(() => lib.checkPathText("C:\\Users\\me\\a.txt:hidden", "win32"), /data streams/);
  assert.doesNotThrow(() => lib.checkPathText("C:\\Users\\me\\Documents\\report v2.pdf", "win32"));
});

test("recipients: each entry is exactly one address; header matches delivery", async () => {
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: [] }), /No recipient/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: ["not-an-address"] }), /exactly one valid address/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: ["a@example.org\r\nBcc: evil@example.org"] }), /Invalid email/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: ["Boss <a@example.org>, ceo@victim.example"] }), /exactly one/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: ["a@example.org, <b@evil.example>"] }), /exactly one/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: Array(21).fill("a@example.org") }), /Too many recipients/);
  const m = await lib.buildMessage(acc(), { ...base, to: ["Иван <ivan@example.org>"] });
  assert.deepEqual(m.envelope.to, ["ivan@example.org"]);
  const p = await simpleParser(m.raw);
  assert.equal(p.to.value[0].address, "ivan@example.org");
});

test("subject and body are required; CRLF in subject cannot inject headers", async () => {
  await assert.rejects(lib.buildMessage(acc(), { ...base, subject: " " }), /Subject/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, body: "" }), /Body/);
  const m = await lib.buildMessage(acc(), { ...base, subject: "Hi\r\nBcc: evil@example.org" });
  assert.ok(!/^bcc:/im.test(m.raw.toString()));
});

test("Bcc is delivered, hidden from recipients, but kept in the sender's own copy", async () => {
  const m = await lib.buildMessage(acc(), { ...base, bcc: ["hidden@example.org"] });
  assert.ok(m.envelope.to.includes("hidden@example.org"));
  assert.ok(!/^bcc:/im.test(m.raw.toString()));
  assert.match(m.rawStored.toString(), /^bcc:.*hidden@example\.org/im);
});

test("send rate limit", () => {
  writeConfig({ limits: { maxSendsPerHour: 2 } });
  lib.checkSendRate();
  lib.recordSend();
  lib.checkSendRate();
  lib.recordSend();
  assert.throws(() => lib.checkSendRate(), /Send limit/);
  writeConfig();
});

test("attachment file names are sanitised", () => {
  assert.equal(lib.safeFileName("../../evil.exe", "x"), "evil.exe");
  assert.equal(lib.safeFileName("..\\..\\evil.exe", "x"), "evil.exe");
  assert.equal(lib.safeFileName("con.txt", "x"), "_con.txt");
  assert.equal(lib.safeFileName("CONIN$", "x"), "_CONIN$");
  assert.equal(lib.safeFileName("COM¹.txt", "x"), "_COM¹.txt");
  assert.equal(lib.safeFileName("invoice\u202efdp.exe", "x"), "invoicefdp.exe");
  assert.equal(lib.safeFileName('a:b?"c.pdf', "x"), "a_b__c.pdf");
  assert.equal(lib.safeFileName("...", "fallback"), "fallback");
});

test("saving only inside the attachments folder, never overwrites", () => {
  const dir = lib.prepareSaveDir("you@example.com/42");
  assert.ok(dir.startsWith(saveDir));
  const a = lib.writeUnique(dir, "f.pdf", "1");
  const b = lib.writeUnique(dir, "f.pdf", "2");
  assert.notEqual(a, b);
  assert.equal(fs.readFileSync(a, "utf8"), "1");
  assert.throws(() => lib.prepareSaveDir("../outside"), /Invalid subfolder/);
  assert.throws(() => lib.prepareSaveDir(".git/hooks"), /Invalid subfolder/);
  assert.throws(() => lib.prepareSaveDir("x/../../outside"), /Invalid subfolder/);
});
