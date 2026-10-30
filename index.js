#!/usr/bin/env node
// safe-imap-mcp entry point.
//   no arguments          -> run the MCP server (this is what Claude Desktop starts)
//   init                  -> create the config with a step-by-step wizard
//   check [--offline]     -> check the config, folders and mail server connections
//   install-claude        -> add this server to Claude Desktop (with a backup)
//   help                  -> show commands

const cmd = process.argv[2];

if (!cmd) {
  await import("./server.js");
} else {
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(process.argv.slice(2));
}
