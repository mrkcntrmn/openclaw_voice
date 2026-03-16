const fs = require('fs');

let content = fs.readFileSync('src/voice/runtime.ts', 'utf8');

// Fix 1: Stop appending history text to instructions for OpenAI Realtime
const regex1 = /const instructions = buildVoiceInstructions\(\{\r?\n\s*history,\r?\n\s*instructions: params\.instructions\?\.trim\(\) \|\| DEFAULT_GATEWAY_VOICE_INSTRUCTIONS,\r?\n\s*\}\);/;

const replacement1 = `const baseInstructions = params.instructions?.trim() || DEFAULT_GATEWAY_VOICE_INSTRUCTIONS;
  const isOpenAI = resolved.providerId === "openai-realtime" || resolved.providerId.includes("openai");
  const instructions = isOpenAI
    ? baseInstructions
    : buildVoiceInstructions({
        history,
        instructions: baseInstructions,
      });`;

content = content.replace(regex1, replacement1);

// Fix 2: Inject conversation history correctly using conversation.item.create for OpenAI Realtime
const regex2 = /const transportReady = this\.waitForTransportReady\(\);\r?\n\s*this\.sendJson\(sessionUpdate\);\r?\n\s*await transportReady;/;

const replacement2 = `const transportReady = this.waitForTransportReady();
    this.sendJson(sessionUpdate);
    await transportReady;

    for (const turn of options.history) {
      if (!turn.text.trim()) continue;
      this.sendJson({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: turn.role,
          content: [
            {
              type: turn.role === "user" ? "input_text" : "text",
              text: turn.text,
            },
          ],
        },
      });
    }`;

content = content.replace(regex2, replacement2);

fs.writeFileSync('src/voice/runtime.ts', content);
console.log('runtime.ts patched successfully');
