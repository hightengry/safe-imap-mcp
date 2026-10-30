// Tests for the command-line helpers. Offline: no mail server, no Claude Desktop needed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "index.js");
let tmp;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-imap-cli-")));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args, { input = "", env = {} } = {}) {
  const r = spawnSync(process.execPath, [INDEX, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, ...env },
    timeout: 20000,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("init: wizard creates a config with the answers, hidden password, private file", () => {
  const cfg = path.join(tmp, "a", "accounts.json");
  const answers = [
    "you@example.com", // email
    "Your Name", // name
    "", // imap host -> default mail.example.com
    "", // imap port -> 993
    "", // smtp host -> same
    "587", // smtp port
    "1", // password in file
    "s3cret!", // password
    "y", // add another
    "info@example.com",
    "",
    "", // imap host -> previous
    "",
    "",
    "",
    "2", // env var
    "", // default env name
    "n", // no more
    "", // keep default folders
    "C:\\Work;D:\\Projects", // approval folders
    "n", // do not test connection
  ].join("\n");
  const r = run(["init"], { input: answers + "\n", env: { MAIL_ACCOUNTS_FILE: cfg } });
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("s3cret!"), "password must not be echoed");
  const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.equal(j.accounts.length, 2);
  assert.deepEqual(j.accounts[0], { email: "you@example.com", fromName: "Your Name", imapHost: "mail.example.com", imapPort: 993, smtpHost: "mail.example.com", smtpPort: 587, password: "s3cret!" });
  assert.equal(j.accounts[1].passwordEnv, "MAIL_PASSWORD_INFO");
  assert.equal(j.accounts[1].password, undefined);
  assert.equal(j.accounts[1].smtpPort, 587, "ports default to the previous mailbox");
  assert.deepEqual(j.approvalFolders, ["C:\\Work", "D:\\Projects"]);
  assert.equal(j.attachmentFolders, undefined);
  if (process.platform !== "win32") assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);

  const again = run(["init"], { input: "", env: { MAIL_ACCOUNTS_FILE: cfg } });
  assert.equal(again.code, 1);
  assert.match(again.out, /already exists/);
});

test("check --offline: ready config passes with a plain-text warning", () => {
  const cfg = path.join(tmp, "b", "accounts.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ defaults: { imapHost: "mail.example.com", smtpHost: "mail.example.com" }, accounts: [{ email: "you@example.com", password: "x" }] }), { mode: 0o600 });
  const r = run(["check", "--offline"], { env: { MAIL_ACCOUNTS_FILE: cfg } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /plain text/);
  assert.match(r.out, /Ready/);
});

test("check --offline: reports broken JSON, missing host, missing env password", () => {
  const cfg = path.join(tmp, "c", "accounts.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '{ "accounts": [ { "email": "a@example.com" } ');
  let r = run(["check", "--offline"], { env: { MAIL_ACCOUNTS_FILE: cfg } });
  assert.equal(r.code, 1);
  assert.match(r.out, /not valid JSON/);

  fs.writeFileSync(cfg, JSON.stringify({ accounts: [{ email: "a@example.com", passwordEnv: "SAFE_IMAP_NOT_SET_XYZ" }] }));
  r = run(["check", "--offline"], { env: { MAIL_ACCOUNTS_FILE: cfg } });
  assert.equal(r.code, 1);
  assert.match(r.out, /imapHost/);
  assert.match(r.out, /SAFE_IMAP_NOT_SET_XYZ is not set/);

  r = run(["check", "--offline"], { env: { MAIL_ACCOUNTS_FILE: path.join(tmp, "nope", "accounts.json") } });
  assert.equal(r.code, 1);
  assert.match(r.out, /safe-imap-mcp init/);
});

test("config defaults to ~/.safe-imap-mcp/accounts.json when nothing else is set", () => {
  const env = { ...process.env };
  delete env.MAIL_ACCOUNTS_FILE;
  const r = spawnSync(process.execPath, [INDEX, "help"], { encoding: "utf8", env: { ...env, HOME: tmp, USERPROFILE: tmp } });
  assert.match(r.stdout, new RegExp(`Config file: ${path.join(tmp, ".safe-imap-mcp", "accounts.json").replace(/[\\.]/g, "\\$&")}`));
});

test("mergeClaudeConfig keeps other settings and never overwrites silently", async () => {
  const { mergeClaudeConfig } = await import(path.join(ROOT, "cli.js"));
  const entry = { command: "/usr/bin/node", args: ["/x/index.js"] };

  let r = mergeClaudeConfig("", "email", entry);
  assert.equal(r.status, "added");
  assert.deepEqual(JSON.parse(r.text), { mcpServers: { email: entry } });

  const existing = JSON.stringify({ preferences: { a: 1 }, mcpServers: { other: { command: "x" } } });
  r = mergeClaudeConfig("\ufeff" + existing, "email", entry);
  const j = JSON.parse(r.text);
  assert.deepEqual(j.preferences, { a: 1 });
  assert.deepEqual(j.mcpServers.other, { command: "x" });
  assert.deepEqual(j.mcpServers.email, entry);

  assert.equal(mergeClaudeConfig(r.text, "email", entry).status, "already-installed");
  assert.throws(() => mergeClaudeConfig(r.text, "email", { command: "other" }), /already has a server/);
  assert.equal(mergeClaudeConfig(r.text, "email", { command: "other" }, { force: true }).status, "replaced");
  assert.throws(() => mergeClaudeConfig("{ broken", "email", entry), /not valid JSON/);
  assert.throws(() => mergeClaudeConfig("[1,2]", "email", entry), /unexpected format/);
});

test("install-claude: backup first, keeps existing settings, idempotent", () => {
  const file = path.join(tmp, "claude", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ coworkUserFilesPath: "x", mcpServers: { other: { command: "y" } } }, null, 2);
  fs.writeFileSync(file, original);

  let r = run(["install-claude", "--config", file, "--yes"]);
  assert.equal(r.code, 0, r.out);
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8"), original);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(j.coworkUserFilesPath, "x");
  assert.deepEqual(j.mcpServers.other, { command: "y" });
  assert.equal(j.mcpServers.email.command, process.execPath);
  assert.deepEqual(j.mcpServers.email.args, [INDEX]);

  r = run(["install-claude", "--config", file, "--yes"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Already installed/);

  r = run(["install-claude", "--config", file], { input: "n\n" });
  assert.equal(r.code, 0, "already installed needs no confirmation");
});

test("install-claude asks before changing anything and stops on No", () => {
  const file = path.join(tmp, "claude2", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}");
  const r = run(["install-claude", "--config", file], { input: "n\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /Cancelled/);
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
});
