const fs = require('fs');
let code = fs.readFileSync('src/voice/runtime.ts', 'utf8');

const regex = /const inputFormat = \{[\s\S]*?input\.transcription = \{ model: transcriptionModelId \};\r?\n\s*\}/;

const replacement = `const inputFormat = inputAudioFormatType === "audio/pcm" || !inputAudioFormatType ? "pcm16" : inputAudioFormatType;
    const outputFormat = outputAudioFormatType === "audio/pcm" || !outputAudioFormatType ? "pcm16" : outputAudioFormatType;

    const sessionUpdate: Record<string, unknown> = {
      type: "session.update",
      session: {
        instructions: options.instructions,
        modalities: ["text", "audio"],
        input_audio_format: inputFormat,
        output_audio_format: outputFormat,
        turn_detection: {
          type: "server_vad",
        },
        tools: toOpenAIRealtimeTools(options.tools),
        tool_choice: "auto",
      },
    };

    const transcriptionModelId =
      normalizeNonEmptyString(options.provider.transcriptionModelId) ??
      defaultTranscriptionModelIdForProvider(options.providerId);

    if (transcriptionModelId) {
      const session = sessionUpdate.session as Record<string, unknown>;
      session.input_audio_transcription = { model: transcriptionModelId };
    }`;

if (regex.test(code)) {
    code = code.replace(regex, replacement);
    fs.writeFileSync('src/voice/runtime.ts', code);
    console.log("Replaced successfully!");
} else {
    console.log("Could not find target block to replace.");
}
