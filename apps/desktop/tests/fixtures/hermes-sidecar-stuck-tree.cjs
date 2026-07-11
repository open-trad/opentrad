"use strict";

const { spawn } = require("node:child_process");

process.on("SIGTERM", () => {});
process.stdin.resume();

const descendant = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { stdio: "ignore" },
);
descendant.once("error", () => {
  process.exitCode = 1;
});
process.stdout.write(`${descendant.pid ?? 0}\n`);
setInterval(() => {}, 1_000);
