// Safety tests. They run fully offline: no mail server is contacted.
// Run: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tmp, cfgDir, allowed, outside, lib;

function writeConfig(extra = {}) {
  const cfg = {
    defaults: { imapHost: "mail.example.com", smtpHost: "mail.example.com" },
    attachmentFolders: [allowed],
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
  outside = path.join(tmp, "outside");
  for (const d of [cfgDir, allowed, outside]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(allowed, "report.pdf"), "report");
  fs.writeFileSync(path.join(allowed, "accounts.backup.json"), "{}");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  process.env.MAIL_ACCOUNTS_FILE = path.join(cfgDir, "accounts.json");
  writeConfig();
  lib = await import(path.join(ROOT, "lib.js"));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const acc = () => lib.getAccount("you@example.com");
const base = { to: ["a@example.org"], subject: "Hello", body: "Text" };

test("source code contains no delete/move/expunge operations", () => {
  // Calls that delete or move mail or files, plus the IMAP \Deleted flag (setting it marks mail for deletion).
  const forbidden = [
    /\.(messageDelete|messageMove|messageCopy|mailboxDelete|mailboxRename|expunge|delete)\s*\(/i,
    /\b(unlink|unlinkSync|rmSync|rmdir|rmdirSync|rm)\s*\(/,
    /\\\\Deleted/i,
  ];
  for (const f of ["index.js", "lib.js", "check.js"]) {
    const code = fs
      .readFileSync(path.join(ROOT, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""); // comments may mention these words
    for (const re of forbidden) assert.ok(!re.test(code), `${f} matches forbidden pattern ${re}`);
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
});

test("passwords: plain, from environment variable, placeholder rejected", () => {
  assert.equal(acc().password, "secret");
  process.env.SAFE_IMAP_TEST_PASSWORD = "from-env";
  assert.equal(lib.getAccount("env@example.com").password, "from-env");
  assert.throws(() => lib.getAccount("empty@example.com"), /No password/);
  assert.throws(() => lib.getAccount("nobody@example.com"), /not configured/);
});

test("attaches a file from an allowed folder", async () => {
  const m = await lib.buildMessage(acc(), { ...base, attachments: [path.join(allowed, "report.pdf")] });
  assert.match(m.raw.toString(), /filename=report\.pdf/);
  assert.equal(m.attached.length, 1);
});

test("rejects attachments outside allowed folders, via '..', or in the config folder", async () => {
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(outside, "secret.txt")] }), /outside the allowed/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(allowed, "..", "outside", "secret.txt")] }), /outside the allowed/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "accounts.json")] }), /outside the allowed|config file/);
});

test("rejects the config file and send log even inside an allowed folder, but not their neighbours", async () => {
  writeConfig({ attachmentFolders: [tmp] });
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "accounts.json")] }), /config file/);
  fs.writeFileSync(path.join(cfgDir, "sent-log.txt"), "log");
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "sent-log.txt")] }), /config file or send log/);
  fs.writeFileSync(path.join(cfgDir, "notes.txt"), "ok");
  const m = await lib.buildMessage(acc(), { ...base, attachments: [path.join(cfgDir, "notes.txt")] });
  assert.equal(m.attached.length, 1);
  writeConfig();
});

test("rejects files from the program folder even if it is inside an allowed folder", async () => {
  writeConfig({ attachmentFolders: [path.dirname(ROOT)] });
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(ROOT, "package.json")] }), /program folder/);
  writeConfig();
});

test("rejects files named like a config file", async () => {
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [path.join(allowed, "accounts.backup.json")] }), /config file/);
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

test("enforces attachment count and size limits", async () => {
  writeConfig({ limits: { maxAttachments: 1, maxAttachmentMB: 1 } });
  const f = path.join(allowed, "report.pdf");
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [f, f] }), /Too many attachments/);
  const big = path.join(allowed, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(lib.buildMessage(acc(), { ...base, attachments: [big] }), /exceed/);
  writeConfig();
});

test("validates recipients, subject and body", async () => {
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: [] }), /No recipient/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: ["not-an-address"] }), /Invalid email/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: ["a@example.org\r\nBcc: evil@example.org"] }), /Invalid email/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, subject: " " }), /Subject/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, body: "" }), /Body/);
  await assert.rejects(lib.buildMessage(acc(), { ...base, to: Array(21).fill("a@example.org") }), /Too many recipients/);
});

test("Bcc recipients are delivered but not written into headers", async () => {
  const m = await lib.buildMessage(acc(), { ...base, bcc: ["hidden@example.org"] });
  assert.ok(m.envelope.to.includes("hidden@example.org"));
  assert.ok(!/^bcc:/im.test(m.raw.toString()));
});

test("attachment file names are sanitised", () => {
  assert.equal(lib.safeFileName("../../evil.exe", "x"), "evil.exe");
  assert.equal(lib.safeFileName("..\\..\\evil.exe", "x"), "evil.exe");
  assert.equal(lib.safeFileName("con.txt", "x"), "_con.txt");
  assert.equal(lib.safeFileName('a:b?"c.pdf', "x"), "a_b__c.pdf");
  assert.equal(lib.safeFileName("...", "fallback"), "fallback");
});

test("saving never overwrites and never leaves allowed folders", () => {
  const dir = lib.prepareSaveDir(path.join(allowed, "saved", "deep"));
  const a = lib.writeUnique(dir, "f.pdf", "1");
  const b = lib.writeUnique(dir, "f.pdf", "2");
  assert.notEqual(a, b);
  assert.equal(fs.readFileSync(a, "utf8"), "1");
  assert.throws(() => lib.prepareSaveDir(path.join(outside, "x")), /outside the allowed/);
  assert.throws(() => lib.prepareSaveDir(path.join(allowed, "..", "outside")), /outside the allowed/);
});
