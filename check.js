#!/usr/bin/env node
// Connection check: logs in to IMAP and SMTP for every configured mailbox.
// Sends nothing and changes nothing. Run: npm run check

import { loadAccounts, withImap, smtpTransport, configPath } from "./lib.js";

console.log(`Config: ${configPath()}\n`);
let accounts;
try {
  accounts = loadAccounts();
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  process.exit(1);
}

let problems = 0;
for (const acc of accounts) {
  if (!acc.ready) {
    console.log(`--  ${acc.email}: password or host not set, skipped`);
    continue;
  }
  let read, send;
  try {
    const st = await withImap(acc, (c) => c.status("INBOX", { messages: true, unseen: true }));
    read = `ok (${st.messages} messages, ${st.unseen} unread)`;
  } catch (e) {
    read = `ERROR: ${e.responseText || e.message}`;
    problems++;
  }
  try {
    await smtpTransport(acc).verify();
    send = "ok";
  } catch (e) {
    send = `ERROR: ${e.message}`;
    problems++;
  }
  console.log(`${acc.email}\n    IMAP (read): ${read}\n    SMTP (send): ${send}`);
}

if (!accounts.some((a) => a.ready)) {
  console.log("\nNo mailbox is ready. Fill in hosts and passwords in the config file.");
  process.exit(1);
}
console.log(problems ? `\n${problems} problem(s). Check passwords and server settings.` : "\nAll good.");
process.exit(problems ? 1 : 0);
