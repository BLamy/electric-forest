#!/usr/bin/env node
import fs from "node:fs";
import vm from "node:vm";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  process.stderr.write("usage: e3_t02_playwright_expression.mjs SOURCE OUTPUT\n");
  process.exit(2);
}

const source = fs.readFileSync(sourcePath, "utf8").trim();
const expression = source.replace(/;\s*$/, "");
const walkthrough = vm.runInNewContext(`(${expression})`);
if (typeof walkthrough !== "function") {
  throw new TypeError("E3-T02 walkthrough source did not evaluate to a function");
}

fs.writeFileSync(outputPath, `${expression}\n`);
process.stdout.write(
  `E3_T02_PLAYWRIGHT_EXPRESSION_OK trailing-semicolon=${String(/;\s*$/.test(source))}\n`,
);
