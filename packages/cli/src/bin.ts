#!/usr/bin/env node
import { runCli } from "./cli.js";

const writeStdout = process.stdout.write.bind(process.stdout);
let stdout = "";
process.stdout.write = (() => true) as typeof process.stdout.write;
const code = await runCli(process.argv.slice(2), {
  stdout: (text) => {
    stdout += text;
  },
  stderr: (text) => process.stderr.write(text),
});
process.stdout.write = writeStdout;
if (stdout.length > 0) writeStdout(stdout);
process.exit(code);
