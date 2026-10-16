import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const toml = require(path.join(root, "node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml"));
const Ajv = require(path.join(root, "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js")).default;
const schemaFile = path.join(root, ".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/config-diagnosis/railway.schema.json");
const configFile = path.join(root, "railway.production.toml");
const schemaBytes = fs.readFileSync(schemaFile);
const schema = JSON.parse(schemaBytes);
const configBytes = fs.readFileSync(configFile);
const config = toml.parse(configBytes.toString("utf8"));
const validator = new Ajv({ strict: false, allErrors: true }).compile(schema);
assert.equal(validator(config), true, JSON.stringify(validator.errors));
const fields = [];
for (const [section, values] of Object.entries(config)) {
  assert.ok(Object.hasOwn(schema.properties, section), "Unknown section: " + section);
  for (const [key, value] of Object.entries(values)) {
    assert.ok(Object.hasOwn(schema.properties[section].properties, key), "Undocumented key: " + section + "." + key);
    fields.push({ path: section + "." + key, type: typeof value, value, schema: schema.properties[section].properties[key] });
  }
}
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const receipt = {
  task: "E12-T10", proof: "Config-only parser and current official schema validation",
  parent: "6d3c801dd29dbcf9fc3dc9094a5fb63a94d06555",
  schema: { url: "https://railway.com/railway.schema.json", sha256: digest(schemaBytes), bytes: schemaBytes.length },
  sources: [
    "https://docs.railway.com/config-as-code#using-a-custom-config-as-code-file",
    "https://docs.railway.com/config-as-code/reference",
    "https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code"
  ],
  config: { path: "railway.production.toml", sha256: digest(configBytes), bytes: configBytes.length },
  tomlParser: "smol-toml@1.8.0", schemaValidator: "ajv@8.20.0",
  valid: true, presentFieldsAllDeclaredBySchema: true, fields,
  boundary: "Read-only TOML/schema self-check; no deployment, source tests, auth emulation, or claim of live config selection."
};
fs.writeFileSync(path.join(root, ".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/config-diagnosis/schema-validation.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify({ valid: true, fields: fields.length, configSha256: receipt.config.sha256, schemaSha256: receipt.schema.sha256 }) + "\n");
