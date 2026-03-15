# Implementation Plan: Fix Pitch-Shifted Voice Agent Audio Playback

## Phase 1: Diagnostic & Reproduction
- [ ] Task: Reproduce the pitch-shifted audio in the local dev environment and identify the exact sample rate mismatch.
- [ ] Task: Inspect the audio metadata (sample rate, bit depth, channels) coming from the Gateway and ensure it matches expectations (e.g., OpenAI Realtime API's 24kHz).
- [ ] Task: Log the hardware sample rate of the browser's `AudioContext` and compare it with the incoming stream's expected sample rate.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Diagnostic & Reproduction' (Protocol in workflow.md)

## Phase 2: Core Fix (Sample Rate & Buffer Management)
- [ ] Task: Write failing unit tests that simulate audio buffer processing and demonstrate the pitch/speed error.
- [ ] Task: Correct any hardcoded sample rates in the frontend or Gateway that do not account for browser variations (e.g., 48kHz vs 44.1kHz).
- [ ] Task: Implement or fix the resampling logic in the `AudioWorklet` or `Web Audio API` pipeline to bridge the stream rate and hardware rate.
- [ ] Task: Fix the audio chunking logic to ensure that audio buffers are passed to the playback engine with correct timing and without data loss.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Core Fix' (Protocol in workflow.md)

## Phase 3: Stabilization & Regression Testing
- [ ] Task: Add regression tests for common sample rate configurations (16k, 24k, 44.1k, 48k) to ensure future stability.
- [ ] Task: Conduct cross-browser verification (Chrome, Safari, Firefox) to confirm the fix is universal as required.
- [ ] Task: Profile the audio pipeline for latency to ensure the fix hasn't introduced noticeable delays.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Stabilization & Regression Testing' (Protocol in workflow.md)

## Phase: Review Fixes
- [x] Task: Apply review suggestions d45a078
