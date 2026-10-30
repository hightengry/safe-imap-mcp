// Command-line helpers: init (wizard), check, install-claude, help.
// None of these touch mail. install-claude changes only the Claude Desktop config, after a backup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { APP_DIR, configSource, homeConfigPath } from "./lib.js";
import { runCheck } from "./doctor.js";

const VERSION = createRequire(import.meta.url)("./package.json").version;
const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;
const SERVER_ENTRY = path.join(APP_DIR, "index.js");

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    switch (cmd) {
      case "init":
        return await init();
      case "check":
      case "doctor":
        return await runCheck({ offline: flags.has("--offline") });
      case "install-claude":
        return await installClaude({ yes: flags.has("--yes"), force: flags.has("--force"), name: opt("--name") || "email", configFile: opt("--config") });
      case "--version":
      case "-v":
      case "version":
        console.log(VERSION);
        return 0;
      case "help":
      case "--help":
      case "-h":
        help();
        return 0;
      default:
        console.log(`Unknown command: ${cmd}\n`);
        help();
        return 1;
    }
  } catch (e) {
    console.error(`\nError: ${e.message}`);
    return 1;
  }
}

function help() {
  console.log(`safe-imap-mcp ${VERSION}

Commands:
  safe-imap-mcp init               Create the mailbox config step by step
  safe-imap-mcp check [--offline]  Check the config, folders and mail server connections
  safe-imap-mcp install-claude     Add this server to Claude Desktop (makes a backup first)
      --name <name>                Server name in Claude (default: email)
      --config <file>              Path to claude_desktop_config.json, if not found automatically
      --yes                        Do not ask for confirmation
  safe-imap-mcp                    (no command) Run the MCP server; Claude starts it this way

Config file: ${configSource().path}

Claude Code users:
  claude mcp add email -- "${process.execPath}" "${SERVER_ENTRY}"
`);
}

// ---------- prompts ----------

function makePrompter() {
  const tty = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  let muted = false;
  rl._writeToOutput = (s) => {
    if (!muted) rl.output.write(s);
    else if (s.includes("\n") || s.includes("\r")) rl.output.write("\n");
    else rl.output.write("*");
  };
  // In non-interactive use (tests, pipes) answers arrive faster than questions; queue them.
  const lines = [];
  const waiters = [];
  rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  rl.on("close", () => waiters.splice(0).forEach((w) => w(null)));
  const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));

  async function ask(q, def = "") {
    rl.output.write(def ? `${q} [${def}]: ` : `${q}: `);
    const a = await nextLine();
    if (a === null) throw new Error("Input ended before the wizard finished.");
    return a.trim() || def;
  }
  async function askHidden(q) {
    rl.output.write(`${q}: `);
    muted = tty;
    const a = await nextLine();
    muted = false;
    if (!tty) rl.output.write("\n");
    if (a === null) throw new Error("Input ended before the wizard finished.");
    return a;
  }
  async function yes(q, def = true) {
    const a = (await ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
    return a ? a.startsWith("y") || a.startsWith("д") : def;
  }
  return { ask, askHidden, yes, close: () => rl.close() };
}

// ---------- init ----------

async function init() {
  const target = configSource().path;
  if (fs.existsSync(target)) {
    console.log(`A config already exists: ${target}\nEdit it in a text editor, or check it with: safe-imap-mcp check`);
    return 1;
  }
  const p = makePrompter();
  try {
    console.log(`safe-imap-mcp setup\n\nThe config will be saved to:\n  ${target}\nPasswords stay on this computer and are sent only to your mail server, encrypted.\n`);
    const accounts = [];
    let defHost = "";
    let defImapPort = "993";
    let defSmtpPort = "465";
    do {
      console.log(`\nMailbox ${accounts.length + 1}`);
      let email;
      for (;;) {
        email = (await p.ask("  Email address")).toLowerCase();
        if (EMAIL_RE.test(email)) break;
        console.log("  That does not look like an email address, try again.");
      }
      const domain = email.split("@")[1];
      const fromName = await p.ask("  Name shown to recipients (optional)");
      console.log("  Server settings are usually in your hosting panel under 'Mail client setup'.");
      const imapHost = await p.ask("  Incoming (IMAP) server", defHost || `mail.${domain}`);
      const imapPort = await p.ask("  IMAP port", defImapPort);
      const smtpHost = await p.ask("  Outgoing (SMTP) server", imapHost);
      const smtpPort = await p.ask("  SMTP port", defSmtpPort);
      defHost = imapHost;
      defImapPort = imapPort;
      defSmtpPort = smtpPort;

      console.log("  Where should the password be kept?\n    1) in the config file (simplest)\n    2) in an environment variable (safer)");
      const where = await p.ask("  Choose 1 or 2", "1");
      const acc = { email, ...(fromName ? { fromName } : {}), imapHost, imapPort: Number(imapPort), smtpHost, smtpPort: Number(smtpPort) };
      if (where === "2") {
        const envName = await p.ask("  Variable name", `MAIL_PASSWORD_${email.split("@")[0].replace(/[^a-z0-9]/gi, "_").toUpperCase()}`);
        acc.passwordEnv = envName;
        const hint =
          process.platform === "win32"
            ? `setx ${envName} "your-password"   (then open a new window and restart Claude)`
            : `add to your shell profile: export ${envName}="your-password"   (then restart Claude)`;
        console.log(`  Set it yourself, so the password never appears here:\n    ${hint}`);
      } else {
        for (;;) {
          const pw = await p.askHidden("  Password (hidden while typing)");
          if (pw) {
            acc.password = pw;
            break;
          }
          console.log("  Empty password, try again.");
        }
      }
      accounts.push(acc);
    } while (await p.yes("\nAdd another mailbox?", false));

    const cfg = { accounts };
    console.log("\nAttachments");
    console.log("  By default files can be attached from Desktop, Documents and Downloads.");
    if (!(await p.yes("  Keep this?", true))) {
      const list = await p.ask("  Folders to allow, separated by ; (empty = none)");
      cfg.attachmentFolders = list ? list.split(";").map((s) => s.trim()).filter(Boolean) : [];
    }
    const guarded = await p.ask("  Folders whose files need a Yes/No confirmation on this computer, separated by ; (Enter to skip)");
    if (guarded) cfg.approvalFolders = guarded.split(";").map((s) => s.trim()).filter(Boolean);

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`\nSaved: ${target}`);

    if (await p.yes("\nTest the connection now?", true)) {
      p.close();
      console.log("");
      const code = await runCheck();
      if (code === 0) console.log(`\nNext step: safe-imap-mcp install-claude`);
      return code;
    }
    console.log(`\nNext steps:\n  safe-imap-mcp check\n  safe-imap-mcp install-claude`);
    return 0;
  } finally {
    p.close();
  }
}

// ---------- install-claude ----------

export function claudeConfigCandidates() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const list = [];
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    list.push(path.join(appdata, "Claude", "claude_desktop_config.json"));
    // Microsoft Store (MSIX) installs keep the config inside the package folder.
    const pk = path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Packages");
    try {
      for (const d of fs.readdirSync(pk)) {
        if (/^Claude_/i.test(d)) list.push(path.join(pk, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      }
    } catch {
      /* no Packages folder */
    }
    return list;
  }
  if (process.platform === "darwin") return [path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json")];
}

function findClaudeConfig() {
  const c = claudeConfigCandidates();
  return c.find((f) => fs.existsSync(f)) || c.find((f) => fs.existsSync(path.dirname(f))) || null;
}

// Pure function: returns the new config text, or throws. Exported for tests.
export function mergeClaudeConfig(text, name, entry, { force = false } = {}) {
  let cfg = {};
  if (text && text.trim()) {
    const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    try {
      cfg = JSON.parse(t);
    } catch (e) {
      throw new Error(`The Claude config is not valid JSON (${e.message}). Nothing was changed. Fix it or restore a backup first.`);
    }
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new Error("The Claude config has an unexpected format. Nothing was changed.");
  }
  const servers = cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
  const existing = servers[name];
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return { text: null, status: "already-installed" };
  if (existing && !force) {
    throw new Error(`Claude already has a server named "${name}":\n${JSON.stringify(existing, null, 2)}\nUse --name <other> or --force to replace it.`);
  }
  const next = { ...cfg, mcpServers: { ...servers, [name]: entry } };
  return { text: JSON.stringify(next, null, 2) + "\n", status: existing ? "replaced" : "added" };
}

async function installClaude({ yes, force, name, configFile }) {
  if (APP_DIR.split(/[\\/]/).includes("_npx")) {
    console.log(
      `It looks like this runs through "npx" from a temporary folder, which can disappear.\nInstall it first:  npm install -g safe-imap-mcp   then run:  safe-imap-mcp install-claude`
    );
    if (!force) return 1;
  }
  const file = configFile ? path.resolve(configFile) : findClaudeConfig();
  if (!file) {
    console.log(`Claude Desktop config not found. Is Claude Desktop installed? Looked in:\n  ${claudeConfigCandidates().join("\n  ")}\nUse --config <path> to point to it.`);
    return 1;
  }
  const entry = { command: process.execPath, args: [SERVER_ENTRY] };
  if (process.env.MAIL_ACCOUNTS_FILE) entry.env = { MAIL_ACCOUNTS_FILE: path.resolve(process.env.MAIL_ACCOUNTS_FILE) };

  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { text, status } = mergeClaudeConfig(current, name, entry, { force });
  if (status === "already-installed") {
    console.log(`Already installed in Claude Desktop as "${name}". Nothing to do.`);
    return 0;
  }

  console.log(`Claude Desktop config: ${file}\nThis will ${status === "replaced" ? "REPLACE" : "add"} the server "${name}":\n${JSON.stringify(entry, null, 2)}\n`);
  if (!yes) {
    const p = makePrompter();
    const go = await p.yes("Continue?", false);
    p.close();
    if (!go) {
      console.log("Cancelled. Nothing was changed.");
      return 1;
    }
  }
  if (current) {
    const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    console.log(`Backup saved: ${backup}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, text, "utf8");
  console.log(
    `Done. Now fully quit Claude Desktop (right-click its icon near the clock or in the menu bar, then Quit) and open it again.\nThen ask Claude: "show my mailboxes".`
  );
  return 0;
}
