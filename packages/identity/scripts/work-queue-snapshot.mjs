import { execFileSync } from "node:child_process";
import {
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  currentGateFromQueue,
} from "./work-queue-snapshot-lib.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const taskFlag = process.argv.indexOf("--task");
if (taskFlag !== -1 && !process.argv[taskFlag + 1]) throw new Error("--task requires an id");
const requestedTaskId = taskFlag === -1 ? undefined : process.argv[taskFlag + 1];
const sourceCommit = git("rev-parse", "HEAD").trim();
const queueText = git("show", `${sourceCommit}:.eforest/tasks/QUEUE.md`);
const projectText = git("show", `${sourceCommit}:.eforest/project.json`);
const taskId = requestedTaskId ?? currentGateFromQueue(queueText);
const taskPath = taskId ? canonicalTaskPath(queueText, taskId) : null;
const readmeText = taskPath ? git("show", `${sourceCommit}:${taskPath}`) : "";

process.stdout.write(
  `${JSON.stringify(
    buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText,
      sourceCommit,
      requestedTaskId,
    }),
  )}\n`,
);
