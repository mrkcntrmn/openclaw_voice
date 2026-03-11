const VOICE_CALL_SESSION_KEY_PREFIX = "voice";

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVoiceCallParticipant(value: string | null | undefined): string | undefined {
  const trimmed = normalizeNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length > 0) {
    return digits;
  }
  const fallback = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return fallback.length > 0 ? fallback : undefined;
}

export function buildVoiceCallSessionKey(phone: string | null | undefined): string | undefined {
  const participant = normalizeVoiceCallParticipant(phone);
  return participant ? `${VOICE_CALL_SESSION_KEY_PREFIX}:${participant}` : undefined;
}

export function resolveVoiceCallSessionKey(params: {
  sessionKey?: string | null;
  direction: "inbound" | "outbound";
  from?: string | null;
  to?: string | null;
}): string | undefined {
  const explicit = normalizeNonEmptyString(params.sessionKey);
  if (explicit) {
    return explicit;
  }
  const participant = params.direction === "outbound" ? params.to : params.from;
  return buildVoiceCallSessionKey(participant);
}