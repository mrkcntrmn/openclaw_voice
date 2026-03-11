# OpenClaw Technology Stack

## Languages
- **TypeScript (Primary):** Main language for the Gateway and core logic.
- **Swift (macOS/iOS):** Native language for the macOS and iOS companion apps.
- **Kotlin (Android):** Native language for the Android node.

## Runtime
- **Node.js (>=22):** Primary runtime for the Gateway.

## Backend Frameworks
- **Express / Hono:** Web frameworks for the Gateway and API.
- **WebSocket (ws):** Communication protocol for the Gateway network.
- **Web Audio API / AudioWorklet:** Real-time audio capture and processing in the browser.

## Database
- **SQLite (via sqlite-vec):** Local database with vector search capabilities.

## Dev Tools
- **pnpm:** Package manager for the monorepo.
- **vitest:** Testing framework for all TypeScript code.
- **oxlint / oxfmt:** High-performance linting and formatting.

## AI Integration
- **OpenAI / Anthropic / AWS Bedrock:** Integrated AI models and providers.

## Messaging Integrations
- **WhatsApp (Baileys):** Baileys-based WhatsApp integration.
- **Telegram (grammY):** grammY-based Telegram integration.
- **Slack (Bolt):** Bolt-based Slack integration.
- **Discord (discord.js):** discord.js-based Discord integration.
- **Signal (signal-cli):** signal-cli-based Signal integration.
- **BlueBubbles (iMessage):** BlueBubbles-based iMessage integration.
- **Other Platforms:** Support for numerous other messaging platforms.
