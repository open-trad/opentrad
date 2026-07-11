import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

export const HERMES_GATEWAY_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const HERMES_GATEWAY_INITIAL_FRAME_CAPACITY = 1024;

export class HermesGatewayCodecError extends Error {
  constructor() {
    super("Hermes gateway codec failure");
    this.name = "HermesGatewayCodecError";
  }
}

export class HermesGatewayNdjsonCodec {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private accumulator = Buffer.alloc(0);
  private bufferedFrameBytes = 0;

  get bufferedBytes(): number {
    return this.bufferedFrameBytes;
  }

  get retainedCapacity(): number {
    return this.accumulator.length;
  }

  get retainedSegmentCount(): number {
    return this.bufferedFrameBytes === 0 ? 0 : 1;
  }

  push(bytes: Buffer, onMessage: (message: Record<string, unknown>) => boolean): void {
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendPartialFrame(bytes.subarray(offset));
        return;
      }

      const tail = bytes.subarray(offset, newline);
      const frame = this.finishFrame(tail);
      if (!onMessage(this.decodeFrame(frame))) return;
      offset = newline + 1;
    }
  }

  reset(): void {
    this.accumulator = Buffer.alloc(0);
    this.bufferedFrameBytes = 0;
  }

  private appendPartialFrame(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.appendBytes(bytes);
  }

  private finishFrame(tail: Buffer): Buffer {
    if (this.bufferedFrameBytes === 0) {
      if (tail.length > HERMES_GATEWAY_MAX_FRAME_BYTES) throw new HermesGatewayCodecError();
      return tail;
    }
    this.appendBytes(tail);
    const frame = this.accumulator.subarray(0, this.bufferedFrameBytes);
    this.bufferedFrameBytes = 0;
    return frame;
  }

  private appendBytes(bytes: Buffer): void {
    const required = this.bufferedFrameBytes + bytes.length;
    if (required > HERMES_GATEWAY_MAX_FRAME_BYTES) throw new HermesGatewayCodecError();
    this.ensureCapacity(required);
    bytes.copy(this.accumulator, this.bufferedFrameBytes);
    this.bufferedFrameBytes = required;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.accumulator.length) return;
    let capacity = Math.max(this.accumulator.length, HERMES_GATEWAY_INITIAL_FRAME_CAPACITY);
    while (capacity < required) {
      capacity = Math.min(capacity * 2, HERMES_GATEWAY_MAX_FRAME_BYTES);
    }
    const grown = Buffer.allocUnsafe(capacity);
    if (this.bufferedFrameBytes > 0) {
      this.accumulator.copy(grown, 0, 0, this.bufferedFrameBytes);
    }
    this.accumulator = grown;
  }

  private decodeFrame(frame: Buffer): Record<string, unknown> {
    let line: string;
    try {
      line = this.decoder.decode(frame);
    } catch {
      throw new HermesGatewayCodecError();
    }
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) throw new HermesGatewayCodecError();

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new HermesGatewayCodecError();
    }
    if (!isGatewayRecord(value) || value.jsonrpc !== "2.0") {
      throw new HermesGatewayCodecError();
    }
    return value;
  }
}

export function isGatewayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
