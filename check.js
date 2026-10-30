#!/usr/bin/env node
// Same as "safe-imap-mcp check". Run: npm run check   (add -- --offline to skip connection tests)
import { runCheck } from "./doctor.js";

process.exitCode = await runCheck({ offline: process.argv.includes("--offline") });
