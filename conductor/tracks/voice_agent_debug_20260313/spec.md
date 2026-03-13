# Specification: Debug & Improve Voice Agent Workflow

## Overview
This track addresses end-to-end issues with the real-time voice agent workflow. The primary objective is to debug and restore functionality where the user's voice transcription, the agent's voice response, and the corresponding text response are failing to appear or process correctly. 

## Scope
- **Audio/Speech Input:** Diagnose and fix issues related to capturing user audio and real-time transcription.
- **Output/Latency:** Resolve issues preventing the agent's voice and text responses from being generated or played back.
- **UI Integration:** Ensure that the conversation (both transcription and agent responses) is correctly integrated and displayed in the user interface.

## Reproduction Steps
Currently, when engaging with the voice agent:
1. The user speaks, but real-time voice transcription is not visible.
2. The agent fails to provide a voice response.
3. The agent fails to provide a text response.

## Acceptance Criteria
- [ ] User's spoken audio is successfully captured and transcribed in real-time.
- [ ] The transcribed text is correctly displayed in the UI.
- [ ] The agent processes the input and generates an appropriate response.
- [ ] The agent's response is played back as audio (voice) with acceptable latency.
- [ ] The agent's response is correctly displayed as text in the UI.
- [ ] The end-to-end conversation flows naturally without unexpected drops or missing components.

## Out of Scope
- Adding entirely new capabilities or skills to the agent not related to the core voice workflow.
- Complete architectural rewrites (unless necessary to fix the core issues).