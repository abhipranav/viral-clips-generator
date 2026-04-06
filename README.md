# jiang-clips

Cloud-first short-form clip extraction for locally uploaded videos.

This repo now has two runtime surfaces:

- A Bun API and worker that accepts uploaded video files, queues jobs, and runs the heavy pipeline on EC2.
- A separate Next.js dashboard in [`web/`](/Users/abhijeetpranavmishra/Downloads/viral-clips-generator/web) for uploads, queue visibility, and clip review.

## Architecture

```text
Laptop / download tool
  -> upload MP4/MOV
Next.js dashboard (port 3000)
  -> POST /api/jobs
Bun API + queue (port 3001)
  -> checkpoint sqlite
  -> ffmpeg / ffprobe
  -> whisper / Gemini
  -> output clips
```

The YouTube download step is now optional. For EC2, the intended flow is:

1. Download the source video on your own machine with your own cookies/tooling.
2. Upload the finished video file through the dashboard.
3. Let EC2 handle transcription, silence cleanup, clip extraction, captions, and final reel rendering.

## Why This Fits A 4 GB EC2 Box

The default configuration is intentionally conservative:

- `WHISPER_MODEL=tiny`
- `MAX_PARALLEL_CLIPS=1`
- `JOB_CONCURRENCY=1`
- `MAX_CLIPS=5`
- `GENERATE_CAPTIONS=false`
- `PREFER_YOUTUBE_TRANSCRIPTS=false`

That keeps the instance focused on one heavy job at a time instead of competing ffmpeg and Whisper workloads.

## Prerequisites

- Bun
- FFmpeg and FFprobe in `PATH`
- Python 3 for transcript helpers
- `GEMINI_API_KEY`
- Optional: `whisper` Python package or `whisper-cli`, depending on which stages you enable

## Install

```bash
bun install
cd web && bun install
```

## Environment

Copy the example env files and adjust for your EC2 instance:

```bash
cp .env.example .env
cp web/.env.example web/.env.local
```

## Run Locally

Start the Bun API:

```bash
bun run api
```

Start the Next.js dashboard:

```bash
bun run web:dev
```

Open [http://localhost:3000](http://localhost:3000).

## CLI Usage

You can still run the pipeline directly.

```bash
# Existing YouTube flow
bun run src/index.ts pipeline <youtube-url>

# New local-file flow
bun run src/index.ts file /absolute/path/to/video.mp4 --title "Episode 14"

# Queue-backed API
bun run src/index.ts api

# Existing helpers
bun run src/index.ts resume <run-id>
bun run src/index.ts status [run-id]
bun run src/index.ts clean <run-id>
```

## API Endpoints

- `GET /health`
- `GET /api/jobs`
- `GET /api/jobs/:runId`
- `POST /api/jobs`
- `GET /media/output/...`

`POST /api/jobs` expects multipart form data with:

- `video`: uploaded video file
- `title`: optional display title
- `maxClips`: optional integer
- `removeSilence`: `true` or `false`
- `generateCaptions`: `true` or `false`

## EC2 Deployment

Deployment assets are included in [`deploy/ec2/`](/Users/abhijeetpranavmishra/Downloads/viral-clips-generator/deploy/ec2):

- systemd unit for the Bun API
- systemd unit for the Next.js app
- nginx reverse-proxy example
- an EC2 setup guide

Recommended instance posture:

- Ubuntu 22.04 or 24.04
- 4 GB RAM minimum
- 2 GB swap file
- EBS volume sized for temporary uploads plus rendered clips

## Testing

```bash
bun test
```

The quick local validation I ran for this refactor was:

```bash
bun test tests/pipeline/orchestrator.test.ts tests/utils/fs.test.ts
```

## Notes

- The dashboard is intentionally separate from the Bun worker so Next.js does not have to own Bun-only primitives like `bun:sqlite` and `Bun.spawn`.
- If you enable caption rendering on a 4 GB box, expect slower throughput and higher memory pressure.
- If you want horizontal scale later, the Bun API can be split into a dedicated worker tier while keeping the same dashboard contract.
