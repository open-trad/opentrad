import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  HERMES_GATEWAY_MAX_FRAME_BYTES,
  HermesGatewayNdjsonCodec,
} from "../src/main/services/hermes/gateway-codec";

describe("HermesGatewayNdjsonCodec bounded accumulation", () => {
  it("keeps one-byte trickle metadata O(1) and copying O(n)", () => {
    const codec = new HermesGatewayNdjsonCodec();
    const concat = vi.spyOn(Buffer, "concat");
    const prefixBytes = 1024 * 1024;

    for (let index = 0; index < prefixBytes; index += 1) {
      codec.push(Buffer.from(" "), () => true);
    }

    expect(codec.bufferedBytes).toBe(prefixBytes);
    expect(codec.retainedSegmentCount).toBeLessThanOrEqual(1);
    expect(codec.retainedCapacity).toBeLessThanOrEqual(HERMES_GATEWAY_MAX_FRAME_BYTES);
    expect(concat.mock.calls.length).toBeLessThanOrEqual(1);

    const messages: unknown[] = [];
    codec.push(
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { type: "gateway.ready", payload: { skin: "hermes" } },
        })}\n`,
      ),
      (message) => {
        messages.push(message);
        return true;
      },
    );
    expect(messages).toHaveLength(1);
  });
});
