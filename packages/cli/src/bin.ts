#!/usr/bin/env node
import { runCli } from "./cli.js";

const args = process.argv.slice(2);
const writeStdout = process.stdout.write.bind(process.stdout);
const interactive = args[0] === "login";
let stdout = "";
if (!interactive) process.stdout.write = (() => true) as typeof process.stdout.write;
const code = await runCli(args, {
  stdout: (text) => (interactive ? void writeStdout(text) : void (stdout += text)),
  stderr: (text) => process.stderr.write(text),
});
if (!interactive) {
  process.stdout.write = writeStdout;
  if (stdout.length > 0) writeStdout(stdout);
}
process.exit(code);
