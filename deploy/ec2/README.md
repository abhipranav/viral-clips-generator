# EC2 Deployment Guide

This repo is set up for a two-process deployment on one EC2 instance:

- Bun API and worker on port `3001`
- Next.js dashboard on port `3000`
- nginx in front on port `80`

## 1. Provision The Box

- Ubuntu 22.04 or newer
- 4 GB RAM minimum
- Add a 2 GB swap file if the box does not already have swap

Example swap setup:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Install System Packages

```bash
sudo apt update
sudo apt install -y ffmpeg python3 python3-pip nginx unzip
```

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

## 3. Deploy The App

```bash
sudo mkdir -p /opt/jiang-clips
sudo chown -R ubuntu:ubuntu /opt/jiang-clips
```

Copy this repo into `/opt/jiang-clips`, then:

```bash
cd /opt/jiang-clips
bun install
cp .env.example .env

cd /opt/jiang-clips/web
bun install
cp .env.example .env.local
bun run build
```

## 4. Configure Environment

Root API env:

- put your `GEMINI_API_KEY`
- keep `WHISPER_MODEL=tiny`
- keep `MAX_PARALLEL_CLIPS=1`
- keep `JOB_CONCURRENCY=1`
- keep `GENERATE_CAPTIONS=false` unless the box has more headroom

Web env:

- set `NEXT_PUBLIC_API_BASE_URL` to your public API origin if you serve API separately
- if nginx fronts both services on one host, `/api` requests can still point to the same host
- keep `NEXT_PUBLIC_LOCAL_YTDLP_ENABLED=false` and `LOCAL_YTDLP_ENABLED=false` on EC2

## 5. Enable systemd Services

```bash
sudo cp /opt/jiang-clips/deploy/ec2/jiang-clips-api.service /etc/systemd/system/
sudo cp /opt/jiang-clips/deploy/ec2/jiang-clips-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jiang-clips-api
sudo systemctl enable --now jiang-clips-web
```

## 6. Configure nginx

```bash
sudo cp /opt/jiang-clips/deploy/ec2/nginx.conf /etc/nginx/sites-available/jiang-clips
sudo ln -sf /etc/nginx/sites-available/jiang-clips /etc/nginx/sites-enabled/jiang-clips
sudo nginx -t
sudo systemctl reload nginx
```

## 7. Operational Notes

- Uploaded videos land in `data/uploads/`
- Rendered clips land in `output/<video-id>/`
- Run state is stored in `data/checkpoints.db`
- The local yt-dlp bridge is meant for your laptop, not the EC2 box
- If memory pressure becomes a problem, reduce `MAX_CLIPS` and keep captions disabled
- If disk pressure becomes a problem, periodically run the clean command for old runs
