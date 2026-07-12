#!/usr/bin/env python3
"""Minimal four-pipe launcher fixture; it never interprets the capability."""

import json
import os
import sys


capability = bytearray()
while True:
    chunk = os.read(3, 4097 - len(capability))
    if chunk == b"":
        break
    capability.extend(chunk)
    if len(capability) > 4096:
        raise SystemExit(78)

if not capability:
    raise SystemExit(78)

print(
    json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "gateway.ready",
                "payload": {"skin": "python-fixture"},
            },
        },
        separators=(",", ":"),
    ),
    flush=True,
)
sys.stdin.buffer.read()
