# VidScript

Upload a video and get a transcript you can copy. The video is deleted as soon as its audio has been extracted.

Live at **https://vidscript.samuelgelacio.io** (password protected).

- Drag-and-drop upload with a progress bar, then live transcription progress with a preview of the text as it arrives
- A transcript box you can edit, a one-click **Copy** button, and downloads as **.txt / .srt / .vtt**
- An optional timestamps view, and automatic language detection (or pick the language for better accuracy)
- Runs entirely on your own server with [faster-whisper](https://github.com/SYSTRAN/faster-whisper): no API keys, no per-minute costs, and nothing leaves the VPS
- A **Minutes** tab that turns a transcript into editable Minutes of Meeting using your own Claude or ChatGPT subscription

## How files are handled

```
upload ──► disk ──► ffmpeg extracts 16 kHz mono audio ──► VIDEO DELETED
                                         │
                       audio read into memory ──► AUDIO DELETED
                                         │
                                 Whisper transcribes
                                         │
                transcript kept in memory for 1 hour, then removed
```

- The video is deleted right after audio extraction, even if extraction fails.
- Transcripts are only held in memory, never written to disk. Restarting the container clears them.
- The working folder is wiped on startup, and a cleanup task removes anything left over.
- "Transcribe another" and "Cancel" delete the job on the server immediately.

## Minutes of Meeting

The **Minutes** tab writes formal minutes (in English) from a transcript, using your existing Claude or ChatGPT subscription. No API key or extra cost is involved: a server can't call a chat subscription, so this works by copy and paste.

1. On a finished transcript, click **Create minutes →**, or paste any transcript into the Minutes tab. The title and date are filled in from the file name when possible. Adding known attendees helps get names right.
2. Click **Copy prompt & open Claude** (or ChatGPT). This copies a ready-made prompt with the transcript included. Paste it into the new chat and send it.
3. Copy the reply with the chat's Copy button and paste it into step 3. It becomes a formatted document.
4. Edit it directly. The toolbar has bold, italic, underline, headings, lists, undo and **+ Action row**. Then click **Copy minutes** and paste into Word, Google Docs or an email, keeping the headings, lists and the bordered action-items table.

Structure: title, date, attendees, prepared by, summary, discussion by topic, decisions, an action-items table (#, action, owner, due date), open issues, next meeting. The prompt tells the AI to write "Not stated" instead of inventing names, dates or numbers.

The draft autosaves **in your browser only**: nothing about the minutes is sent to or stored on the VidScript server. Pasted content is sanitized (only basic formatting tags are kept). "Start over" clears the draft.

## Project layout

```
app/main.py               FastAPI backend (upload, job queue, ffmpeg + Whisper)
app/static/index.html     Frontend page: Transcript and Minutes tabs (no build step)
app/static/minutes.js     Minutes of Meeting: prompt, paste import, editor, formatted copy
app/static/vendor/        Bundled marked 12.0.2 (Markdown) and DOMPurify 3.1.6 (sanitizing)
Dockerfile                Python 3.12 slim + ffmpeg
docker-compose.yml        Binds to 127.0.0.1:8010 for nginx to proxy
deploy/nginx/…conf        nginx site for vidscript.samuelgelacio.io
deploy/update.sh          Pull + rebuild on the VPS
```

## Run locally

Requires Docker.

```bash
cp .env.example .env        # optional
docker compose up -d --build
# open http://localhost:8010
```

The first start downloads the Whisper model (`base` is about 150 MB) into the `models` volume. Later starts reuse it.

## Deploy to the VPS

### 1. DNS
Add an **A record** for `vidscript` pointing to the VPS's IP (and an AAAA record if you use IPv6).

### 2. Get the code and start it
```bash
cd /opt                                   # or wherever you keep apps
sudo git clone https://github.com/GelacioCode/vidscript.git
sudo chown -R $USER vidscript && cd vidscript
cp .env.example .env                      # edit if you want a different model or limits
docker compose up -d --build
curl http://127.0.0.1:8010/api/health     # {"ok":true,...,"model_loaded":true} once ready
```

### 3a. Behind Caddy running in Docker (what samuelgelacio.io uses)

The Caddy container (`paint-rush-caddy-1`) reads its config from `/opt/paint-rush/deploy/Caddyfile` (mounted read-only), so edit that file on the host.

```bash
# Put vidscript on Caddy's Docker network (in /opt/vidscript)
NET=$(docker inspect paint-rush-caddy-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
cat > docker-compose.override.yml <<EOF2
services:
  vidscript:
    networks: [default, caddy]
networks:
  caddy:
    external: true
    name: $NET
EOF2
docker compose up -d

# Password hash + site block
HASH=$(docker exec paint-rush-caddy-1 caddy hash-password --plaintext 'CHOOSE-A-PASSWORD')
cat >> /opt/paint-rush/deploy/Caddyfile <<EOF2

vidscript.samuelgelacio.io {
	encode zstd gzip
	basic_auth {
		samuel $HASH
	}
	reverse_proxy vidscript:8000 {
		transport http {
			read_timeout 10m
			write_timeout 10m
		}
	}
}
EOF2
docker exec paint-rush-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec paint-rush-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```
Caddy fetches the HTTPS certificate on its own. Append with `cat >>` (or edit in place); editors that replace the file can leave the container seeing the old copy, in which case `docker restart paint-rush-caddy-1`.

### 3b. Or: nginx site + password
```bash
sudo cp deploy/nginx/vidscript.samuelgelacio.io.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/vidscript.samuelgelacio.io.conf /etc/nginx/sites-enabled/

sudo apt install -y apache2-utils                         # provides htpasswd
sudo htpasswd -c /etc/nginx/.htpasswd-vidscript samuel    # add more users without -c

sudo nginx -t && sudo systemctl reload nginx
```

### 4. HTTPS (nginx only)
```bash
sudo certbot --nginx -d vidscript.samuelgelacio.io
```
Certbot adds the SSL server block and the HTTP→HTTPS redirect to the same file.

### Updating
```bash
cd /opt/vidscript && sh deploy/update.sh
```

## Configuration

Set these in `.env` (read by `docker-compose.yml`), then run `docker compose up -d` to apply.

| Variable | Default | Notes |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium`, `large-v3` (see below) |
| `WHISPER_CPU_THREADS` | `0` | 0 = auto |
| `MAX_UPLOAD_MB` | `500` | If you raise this, also raise `client_max_body_size` in the nginx conf |
| `MAX_CONCURRENT_JOBS` | `1` | Jobs transcribed at once. Keep 1 on 2 vCPU |
| `MAX_QUEUED_JOBS` | `10` | Further uploads get a "server busy" message |
| `RESULT_TTL_SECONDS` | `3600` | How long a finished transcript stays available |
| `CHUNK_SECONDS` | `600` | Long audio is transcribed in pieces this long, cut at the quietest moment, to keep memory flat |
| `APP_PORT` | `8010` | Local port. Must match `proxy_pass` in the nginx conf |
| `MEM_LIMIT` | `2g` | Container memory cap |

### Choosing a model (CPU, int8)

| Model | Approx. RAM | Speed on 2 vCPU | Accuracy |
|---|---|---|---|
| `tiny` | ~0.3 GB | fastest | OK for clear speech |
| `base` | ~0.5 GB | fast | **good default for a small VPS** |
| `small` | ~1 GB | about 2–3× slower than base | noticeably better, especially non-English |
| `medium` | ~2.5 GB | slow | very good |
| `large-v3` | ~4.5 GB | very slow on CPU | best. Really needs a GPU |

Audio is transcribed in 10-minute chunks, so memory stays roughly flat regardless of video length (a 51-minute recording peaked around 830 MB with `base`). Without chunking, faster-whisper builds features for the whole file at once, which pushed a 51-minute meeting past 2 GB and got the container killed.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/jobs?language=en` | Raw file as the request body, `X-Filename` header (URL-encoded). Returns `{id}` |
| `GET` | `/api/jobs/{id}` | `status` (`queued`/`extracting`/`transcribing`/`done`/`error`), `progress`, `queue_position`, `language`, `duration`, `segments[]`, `error` |
| `DELETE` | `/api/jobs/{id}` | Cancel a job or remove a transcript |
| `GET` | `/api/config` | Upload limit and model name |
| `GET` | `/api/health` | Health check (no password needed through nginx) |

```bash
curl -u samuel -X POST "https://vidscript.samuelgelacio.io/api/jobs" \
     -H "X-Filename: talk.mp4" --data-binary @talk.mp4
```
