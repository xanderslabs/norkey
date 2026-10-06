#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
