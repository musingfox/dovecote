#!/usr/bin/env bun
import { runMain } from "./main.ts";
import { ExitCode } from "./exit-codes.ts";

runMain({ argv: process.argv.slice(2) }).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`Fatal: ${err?.message ?? err}\n`);
    process.exit(ExitCode.GENERIC);
  }
);
