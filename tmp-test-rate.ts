import { resolveVoiceSessionConfig } from "./src/voice/runtime.js";
import { loadConfig } from "./src/config/config.js";

async function main() {
    const cfg = loadConfig();
    const resolved = await resolveVoiceSessionConfig({ cfg, providerId: "openai-realtime" });
    console.log("Resolved Browser sample rate:", resolved.browser.sampleRateHz);
}

main().catch(console.error);
