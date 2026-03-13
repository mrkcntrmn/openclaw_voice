const VOICE_DEBUG_STORAGE_KEY = "openclaw.debug.voice";
const VOICE_DEBUG_PAYLOADS_STORAGE_KEY = "openclaw.debug.voice.payloads";
const SENSITIVE_KEY_PATTERN = /(api[-_]?key|authorization|token|secret|password|cookie)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeVoiceDebugPayloadInternal(
  value: unknown,
  path: string[] = [],
): unknown {
  const key = path[path.length - 1] ?? "";
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (value instanceof ArrayBuffer) {
    return { type: "array-buffer", byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeVoiceDebugPayloadInternal(entry, [...path, String(index)]),
    );
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeVoiceDebugPayloadInternal(entryValue, [...path, entryKey]),
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

function resolveLocalStorageFlag(key: string): boolean {
  try {
    return window.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function shouldDebugVoice(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const hostname = window.location?.hostname ?? "";
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    return false;
  }
  return resolveLocalStorageFlag(VOICE_DEBUG_STORAGE_KEY);
}

export function shouldDebugVoicePayloads(): boolean {
  return shouldDebugVoice() && resolveLocalStorageFlag(VOICE_DEBUG_PAYLOADS_STORAGE_KEY);
}

export function debugVoice(message: string, meta?: Record<string, unknown>): void {
  if (!shouldDebugVoice()) {
    return;
  }
  if (meta && Object.keys(meta).length > 0) {
    console.debug(`[voice] ${message}`, meta);
    return;
  }
  console.debug(`[voice] ${message}`);
}

export function debugVoicePayload(
  message: string,
  payload: unknown,
  meta?: Record<string, unknown>,
): void {
  if (!shouldDebugVoicePayloads()) {
    return;
  }
  console.debug(`[voice] ${message}`, {
    ...meta,
    payload: sanitizeVoiceDebugPayloadInternal(payload),
  });
}

export function voiceDebugElapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
