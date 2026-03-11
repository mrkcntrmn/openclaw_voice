import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import {
  VOICE_CALL_PLUGIN_CONFIG_DEPRECATED_MESSAGE,
  buildVoiceConfigResponseFromConfig,
  normalizeVoiceConfig,
} from "./voice.js";

describe("normalizeVoiceConfig", () => {
  it("keeps talk compatibility as the canonical voice source", () => {
    const normalized = normalizeVoiceConfig({
      talk: {
        provider: "openai-realtime",
        providers: {
          "openai-realtime": {
            modelId: "gpt-4o-realtime-preview",
            apiKey: "sk-talk",
          },
        },
        interruptOnSpeech: false,
        silenceTimeoutMs: 1500,
      },
    } as OpenClawConfig);

    expect(normalized.voice?.provider).toBe("openai-realtime");
    expect(normalized.voice?.providers?.["openai-realtime"]?.modelId).toBe("gpt-4o-realtime-preview");
    expect(normalized.voice?.session?.interruptOnSpeech).toBe(false);
    expect(normalized.voice?.session?.silenceTimeoutMs).toBe(1500);
  });

  it("ignores deprecated voice-call plugin config when normalizing browser voice", () => {
    const normalized = normalizeVoiceConfig({
      talk: {
        provider: "openai-realtime",
        providers: {
          "openai-realtime": {
            modelId: "gpt-4o-realtime-preview",
            apiKey: "sk-talk",
          },
        },
      },
      plugins: {
        entries: {
          "voice-call": {
            config: {
              streaming: {
                sttProvider: "openai-realtime",
                openaiApiKey: "sk-voice-call",
                sttModel: "gpt-4o-mini-transcribe",
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(normalized.voice?.providers?.["openai-realtime"]?.apiKey).toBe("sk-talk");
    expect(normalized.voice?.providers?.["openai-realtime"]?.transcriptionModelId).toBeUndefined();
  });
});

describe("buildVoiceConfigResponseFromConfig", () => {
  it("returns deprecations when only the deprecated voice-call plugin config is present", () => {
    expect(
      buildVoiceConfigResponseFromConfig({
        plugins: {
          entries: {
            "voice-call": {
              config: {
                enabled: true,
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      deprecations: [VOICE_CALL_PLUGIN_CONFIG_DEPRECATED_MESSAGE],
    });
  });
});
