# AgentOS Demo Automation System

Fully automated demo recording system using an LLM agent to control the workbench and capture high-resolution video demos.

## Overview

This system uses Playwright for browser automation and screen recording, combined with an LLM agent that follows scripted instructions to demonstrate AgentOS features.

## Requirements

- Node.js 22 or later (the root `package.json` requires it)
- FFmpeg (for video processing)
- OpenAI API key (for LLM agent)

## Installation

```bash
cd apps/agentos-workbench
pnpm install
pnpm exec playwright install chromium
```

## Recording Demos

### Quick Start

```bash
# Record all demos
pnpm run demo:record

# Record specific demo
pnpm run demo:record -- --demo agent-creation

# Record with custom resolution
pnpm run demo:record -- --width 2560 --height 1440
```

### Available Demos

| ID | Title | Duration | Description |
|----|-------|----------|-------------|
| `agent-creation` | Creating an AI Agent | ~2 min | Build a custom persona from scratch |
| `multi-agent` | Multi-Agent Collaboration | ~3 min | Orchestrate agent teams |
| `rag-memory` | RAG Memory System | ~2 min | Semantic search and retrieval |
| `planning-engine` | Planning Engine | ~2.5 min | Multi-step task decomposition |
| `streaming` | Real-time Streaming | ~1.5 min | Token-level response delivery |

## Architecture

```
demo-automation/
├── README.md                 # This file
├── agent-instructions.md     # LLM agent system prompt
├── demo-scripts/             # Individual demo scripts
│   ├── agent-creation.ts
│   ├── multi-agent.ts
│   ├── rag-memory.ts
│   ├── planning-engine.ts
│   └── streaming.ts
├── lib/
│   ├── recorder.ts           # Screen recording controller
│   ├── browser-agent.ts      # LLM-powered browser automation
│   ├── caption-overlay.ts    # Caption injection system
│   └── video-processor.ts    # FFmpeg video processing
├── output/                   # Generated videos (gitignored)
│   ├── raw/                  # Raw WebM recordings
│   ├── processed/            # Final MP4s with captions
│   └── thumbnails/           # Video thumbnails
└── run.ts                    # Main entry point
```

## Configuration

Create `.env` in the demo-automation folder:

```env
OPENAI_API_KEY=sk-...
DEMO_RESOLUTION_WIDTH=1920
DEMO_RESOLUTION_HEIGHT=1080
DEMO_FPS=60
DEMO_BITRATE=8000000
```

## Output Format

- Resolution: 1920x1080 (configurable up to 4K)
- Frame rate: 60 FPS
- Video codec: H.264 (libx264)
- Audio: AAC 192kbps (if narration enabled)
- Container: MP4 with faststart for web

## Captions

Captions are burned into the video during post-processing:
- Font: Inter Bold
- Size: 32px
- Position: Bottom center with 80px margin
- Background: Semi-transparent black pill

## Integration with Landing Page

After recording, copy videos to the landing page:

```bash
cp output/processed/*.mp4 ../../agentos.sh/public/videos/
cp output/thumbnails/*.jpg ../../agentos.sh/public/videos/
```

## Troubleshooting

### Recording fails to start
- Ensure Playwright browsers are installed: `pnpm exec playwright install`
- Check that the workbench dev server is running on port 5175

### Video quality issues
- Increase bitrate: `--bitrate 12000000` for 12 Mbps
- Use higher resolution: `--width 2560 --height 1440`

### Captions not appearing
- Ensure FFmpeg is installed with libass support
- Check SRT file encoding is UTF-8





