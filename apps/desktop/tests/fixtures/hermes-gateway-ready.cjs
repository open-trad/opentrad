#!/usr/bin/env node
"use strict";

process.stdout.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { skin: "node-fixture" } },
  })}\n`,
);
process.stdin.resume();
process.stdin.once("end", () => {
  process.exitCode = 0;
});
