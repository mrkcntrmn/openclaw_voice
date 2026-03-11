# Specification: Browser Real-time Voice Chat

## Goal
Implement a real-time voice chat feature in the OpenClaw dashboard (browser) that allows users to communicate with the assistant using their microphone and receive audio responses.

## Key Technologies
- **Frontend:** Lit, Web Audio API (for capture/playback).
- **Backend:** Node.js, WebSocket (`ws`) for real-time streaming.
- **AI Integration:** OpenAI Realtime API or similar for low-latency voice-to-voice interaction.

## Functional Requirements
- **Audio Capture:** Capability to capture audio from the user's microphone in the browser.
- **Streaming:** Real-time streaming of captured audio to the OpenClaw Gateway.
- **Playback:** Receive and play back real-time audio responses from the assistant.
- **UI Controls:** Start/Stop voice chat buttons and visual indicators (e.g., waveform) in the dashboard chat.
- **Status Indicators:** Show connection status and voice activity in the UI.

## Technical Details
- Use the existing Gateway WebSocket protocol for voice streaming.
- Implement a dedicated plugin or extension for handling browser-based voice sessions if needed.
- Ensure low-latency processing to maintain a natural conversation flow.

## Acceptance Criteria
- User can start a voice chat session from the dashboard.
- Assistant responds in real-time with voice.
- Audio quality is clear and stable.
- Visual indicators correctly reflect voice activity.
