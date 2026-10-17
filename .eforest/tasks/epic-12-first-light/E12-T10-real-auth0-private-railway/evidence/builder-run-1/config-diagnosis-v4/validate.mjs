import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const root=process.cwd();
const require=createRequire(path.join(root,"package.json"));
const toml=require(path.join(root,"node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml"));
const Ajv=require(path.join(root,"node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js")).default;
const parent="b19e7bce1cdcb06b2d11ba21d16de299402675f6";
assert.equal(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),parent);
const prior=execFileSync("git",["show",parent+":railway.toml"]);
const examplePath="docs/examples/railway-preview-config.toml";
const example=fs.readFileSync(examplePath);
assert.deepEqual(example,prior);
for (const file of ["railway.toml","railway.json","railway.production.toml"]) assert.equal(fs.existsSync(file),false,file);
const schemaBytes=fs.readFileSync(".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/config-diagnosis/railway.schema.json");
const schema=JSON.parse(schemaBytes);
const config=toml.parse(example.toString("utf8"));
const validator=new Ajv({strict:false,allErrors:true}).compile(schema);
assert.equal(validator(config),true,JSON.stringify(validator.errors));
const changed=execFileSync("git",["diff","--no-renames","--name-only",parent],{encoding:"utf8"}).trim().split("\n").sort();
assert.deepEqual(changed,["docs/guides/railway-hosting.md","railway.production.toml","railway.toml"]);
const previous=JSON.parse(fs.readFileSync(".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/builder-freeze-v3.json"));
const protectedPaths=previous.cumulativeImplementationFiles.map(f=>f.path).filter(p=>!["docs/guides/railway-hosting.md","railway.production.toml"].includes(p));
protectedPaths.push("Dockerfile");
const hash=data=>crypto.createHash("sha256").update(data).digest("hex");
const sourceFiles=protectedPaths.sort().map(p=>{
  const committed=execFileSync("git",["show",parent+":"+p]);
  const actual=fs.readFileSync(p);
  assert.deepEqual(actual,committed,p);
  return {path:p,sha256:hash(actual),bytes:actual.length};
});
const receipt={
 task:"E12-T10",parent,
 proof:"Config relocation and absence of automatic root discovery; immutable runtime/app source bytes",
 relocatedExample:{path:examplePath,sha256:hash(example),bytes:example.length,equalsParentRootConfig:true,tomlParses:true,officialSchemaValid:true},
 absentRootConfigs:["railway.toml","railway.json","railway.production.toml"],
 schema:{url:"https://railway.com/railway.schema.json",sha256:hash(schemaBytes)},
 preservedSourceFiles:sourceFiles,
 validationBoundary:"No live Railway mutation or configuration selection assertion; parent owns external service settings and deployment.",
 source:"https://docs.railway.com/builds/dockerfiles#custom-dockerfile-path"
};
fs.mkdirSync(".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/config-diagnosis-v4",{recursive:true});
fs.writeFileSync(".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/config-diagnosis-v4/validation.json",JSON.stringify(receipt,null,2)+"\n");
process.stdout.write(JSON.stringify({exampleByteIdentical:true,rootConfigsAbsent:true,tomlSchemaValid:true,preservedSourceFiles:sourceFiles.length})+"\n");

