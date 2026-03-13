import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|authorization|token|secret|password|cookie)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeVoiceDebugPayloadInternal(
  value: unknown,
  path: string[] = [],
  summarize = false,
): unknown {
  const key = path[path.length - 1] ?? "";
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return summarize ? { length: value.length } : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (Buffer.isBuffer(value)) {
    return { type: "buffer", byteLength: value.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "array-buffer", byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    if (summarize) {
      return {
        type: "array",
        length: value.length,
      };
    }
    return value.map((entry, index) =>
      sanitizeVoiceDebugPayloadInternal(entry, [...path, String(index)], summarize),
    );
  }
  if (isPlainObject(value)) {
    if (summarize) {
      return {
        type: "object",
        keys: Object.keys(value).sort(),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeVoiceDebugPayloadInternal(entryValue, [...path, entryKey], summarize),
      ]),
    );
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  return String(value);
}

export function sanitizeVoiceDebugPayload(value: unknown): unknown {
  return sanitizeVoiceDebugPayloadInternal(value);
}

export function summarizeVoiceDebugPayload(value: unknown): unknown {
  return sanitizeVoiceDebugPayloadInternal(value, [], true);
}

export function createVoiceDebugLogger(subsystem: string) {
  const log = createSubsystemLogger(subsystem);
  const enabled = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_VOICE);
  const payloadsEnabled =
    enabled && isTruthyEnvValue(process.env.OPENCLAW_DEBUG_VOICE_PAYLOADS);

  return {
    enabled,
    payloadsEnabled,
    debug(message: string, meta?: Record<string, unknown>) {
      if (!enabled) {
        return;
      }
      // Voice diagnostics are explicitly gated by env flags, so emit them at info
      // level to survive the default file logger threshold during incident debugging.
      log.info(message, meta);
    },
    payload(message: string, payload: unknown, meta?: Record<string, unknown>) {
      if (!payloadsEnabled) {
        return;
      }
      log.info(message, {
        ...meta,
        payload: sanitizeVoiceDebugPayload(payload),
      });
    },
  };
}

export function voiceDebugElapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
