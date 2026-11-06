"""VidScript: upload a video, get a transcript. The video is deleted as soon
as its audio has been extracted, and the audio is deleted after transcription.

Jobs live in memory only, so run a single uvicorn worker.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from starlette.requests import ClientDisconnect

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("vidscript")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


WORK_DIR = Path(os.getenv("WORK_DIR", "/tmp/vidscript"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_CPU_THREADS = _env_int("WHISPER_CPU_THREADS", 0)  # 0 = let ctranslate2 decide
MAX_UPLOAD_MB = _env_int("MAX_UPLOAD_MB", 500)
MAX_CONCURRENT_JOBS = max(1, _env_int("MAX_CONCURRENT_JOBS", 1))
MAX_QUEUED_JOBS = max(1, _env_int("MAX_QUEUED_JOBS", 10))
RESULT_TTL_SECONDS = _env_int("RESULT_TTL_SECONDS", 3600)
FFMPEG_TIMEOUT_SECONDS = _env_int("FFMPEG_TIMEOUT_SECONDS", 1800)
# Long recordings are transcribed in pieces of about this length to cap memory use.
CHUNK_SECONDS = max(60, _env_int("CHUNK_SECONDS", 600))
SAMPLE_RATE = 16000

MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
STATIC_DIR = Path(__file__).parent / "static"
ACTIVE_STATUSES = {"queued", "extracting", "transcribing"}
LANG_RE = re.compile(r"^[a-z]{2,3}$")

JOBS: dict[str, dict] = {}
UPLOADING: set[str] = set()  # job ids whose upload is still streaming in
JOBS_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_JOBS, thread_name_prefix="transcribe")

_model = None
_model_lock = threading.Lock()


class JobError(Exception):
    """An error whose message is safe to show to the user."""


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            log.info("Loading Whisper model %r (%s/%s)", WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE)
            _model = WhisperModel(
                WHISPER_MODEL,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE_TYPE,
                cpu_threads=WHISPER_CPU_THREADS,
                num_workers=MAX_CONCURRENT_JOBS,
            )
            log.info("Model loaded")
        return _model


def _preload_model() -> None:
    try:
        get_model()
    except Exception:
        log.exception("Model preload failed; will retry on first job")


def _update(job_id: str, **fields) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return False
        job.update(fields)
        return True


def _load_pcm_wav(path: Path):
    """Read the 16 kHz mono s16le WAV that ffmpeg produced as int16 samples.

    We hand faster-whisper arrays (not files), which skips its PyAV decoder.
    int16 keeps a 1-hour recording at ~115 MB; chunks are converted to float32
    one at a time.
    """
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16)


def _chunk_bounds(samples) -> list[tuple[int, int]]:
    """Split audio into ~CHUNK_SECONDS pieces, cutting at the quietest half
    second within the last 30 s of each piece so words aren't split."""
    import numpy as np

    n = len(samples)
    chunk = CHUNK_SECONDS * SAMPLE_RATE
    search = 30 * SAMPLE_RATE
    win = SAMPLE_RATE // 2
    bounds, pos = [], 0
    # Don't leave a tiny tail: only cut if more than a minute would remain.
    while n - pos > chunk + 60 * SAMPLE_RATE:
        target = pos + chunk
        region = samples[target - search:target].astype(np.float32)
        k = len(region) // win
        energy = (region[: k * win].reshape(k, win) ** 2).mean(axis=1)
        cut = target - search + int(np.argmin(energy)) * win + win // 2
        bounds.append((pos, cut))
        pos = cut
    bounds.append((pos, n))
    return bounds


def _process(job_id: str) -> None:
    job_dir = WORK_DIR / job_id
    video_path = job_dir / "upload"
    audio_path = job_dir / "audio.wav"
    try:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if job is None:  # cancelled while queued
                return
            language = job["requested_language"]
            job["status"] = "extracting"
            job["started_at"] = time.time()

        # 1. Extract 16 kHz mono audio, then delete the video no matter what.
        try:
            proc = subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(video_path),
                    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                    str(audio_path),
                ],
                capture_output=True,
                text=True,
                timeout=FFMPEG_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            raise JobError("Extracting the audio took too long.")
        finally:
            video_path.unlink(missing_ok=True)
            log.info("Job %s: video deleted", job_id)

        if proc.returncode != 0 or not audio_path.exists() or audio_path.stat().st_size < 1024:
            log.warning("Job %s: ffmpeg failed: %s", job_id, (proc.stderr or "").strip()[-500:])
            raise JobError("Couldn't find an audio track in this file. Is it a video with sound?")

        # 2. Load the audio (as compact int16) and delete it from disk too.
        samples = _load_pcm_wav(audio_path)
        audio_path.unlink(missing_ok=True)
        duration = len(samples) / SAMPLE_RATE
        if not _update(job_id, status="transcribing", progress=0.0, duration=round(duration, 2)):
            return

        # 3. Transcribe chunk by chunk. faster-whisper computes features for the
        #    whole input at once, so one long array can need several GB of RAM.
        model = get_model()
        prompt = None
        for start, end in _chunk_bounds(samples):
            offset = start / SAMPLE_RATE
            audio = samples[start:end].astype("float32") / 32768.0
            segments_iter, info = model.transcribe(
                audio,
                language=language,
                beam_size=5,
                vad_filter=True,
                initial_prompt=prompt,
            )
            if language is None:
                # Lock in the language detected on the first chunk.
                language = info.language
                if not _update(job_id, language=language):
                    return

            chunk_text = []
            for seg in segments_iter:
                text = seg.text.strip()
                with JOBS_LOCK:
                    job = JOBS.get(job_id)
                    if job is None:  # cancelled mid-transcription
                        return
                    if text:
                        job["segments"].append({
                            "start": round(offset + seg.start, 2),
                            "end": round(offset + seg.end, 2),
                            "text": text,
                        })
                    if duration:
                        job["progress"] = min((offset + seg.end) / duration, 1.0)
                if text:
                    chunk_text.append(text)

            # Carry the tail of this chunk into the next one for continuity.
            prompt = " ".join(chunk_text)[-200:] or None
            del audio
            if not _update(job_id, progress=min(end / len(samples), 1.0)):
                return

        _update(job_id, status="done", progress=1.0, finished_at=time.time())
        log.info("Job %s: done (%.0fs of audio)", job_id, duration)

    except JobError as e:
        _update(job_id, status="error", error=str(e), finished_at=time.time())
    except Exception:
        log.exception("Job %s failed", job_id)
        _update(job_id, status="error", error="Transcription failed. Please try again.", finished_at=time.time())
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _cleanup_loop() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with JOBS_LOCK:
            expired = [
                jid for jid, j in JOBS.items()
                if j.get("finished_at") and now - j["finished_at"] > RESULT_TTL_SECONDS
            ]
            for jid in expired:
                del JOBS[jid]
            known = set(JOBS) | UPLOADING
        # Remove any stray working dirs that no longer belong to a job.
        if WORK_DIR.exists():
            for d in WORK_DIR.iterdir():
                if d.name not in known:
                    shutil.rmtree(d, ignore_errors=True)
        if expired:
            log.info("Expired %d finished job(s)", len(expired))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Start clean: nothing from a previous run should survive.
    shutil.rmtree(WORK_DIR, ignore_errors=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_preload_model, daemon=True).start()
    threading.Thread(target=_cleanup_loop, daemon=True).start()
    yield
    EXECUTOR.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="VidScript", lifespan=lifespan, docs_url=None, redoc_url=None)


def _public(job_id: str, job: dict) -> dict:
    out = {
        "id": job_id,
        "filename": job["filename"],
        "status": job["status"],
        "progress": round(job.get("progress", 0.0), 4),
        "language": job.get("language"),
        "duration": job.get("duration"),
        "segments": list(job["segments"]),
        "error": job.get("error"),
    }
    if job["status"] == "queued":
        ahead = [j for j in JOBS.values() if j["status"] == "queued" and j["created_at"] < job["created_at"]]
        out["queue_position"] = len(ahead) + 1
    return out


@app.get("/api/config")
def config():
    return {"max_upload_mb": MAX_UPLOAD_MB, "model": WHISPER_MODEL, "result_ttl_seconds": RESULT_TTL_SECONDS}


@app.get("/api/health")
def health():
    return {"ok": True, "model": WHISPER_MODEL, "model_loaded": _model is not None}


@app.post("/api/jobs", status_code=201)
async def create_job(request: Request, language: str | None = None):
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_MB} MB.")

    with JOBS_LOCK:
        active = sum(1 for j in JOBS.values() if j["status"] in ACTIVE_STATUSES)
    if active >= MAX_QUEUED_JOBS:
        raise HTTPException(503, "The server is busy right now. Please try again in a few minutes.")

    lang = (language or "").strip().lower()
    lang = lang if LANG_RE.match(lang) else None
    filename = unquote(request.headers.get("x-filename", "video"))[:200] or "video"

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    video_path = job_dir / "upload"
    with JOBS_LOCK:
        UPLOADING.add(job_id)

    size = 0
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        with open(video_path, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File is larger than {MAX_UPLOAD_MB} MB.")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "The uploaded file is empty.")
    except ClientDisconnect:
        shutil.rmtree(job_dir, ignore_errors=True)
        with JOBS_LOCK:
            UPLOADING.discard(job_id)
        raise HTTPException(400, "Upload was interrupted.")
    except BaseException:
        shutil.rmtree(job_dir, ignore_errors=True)
        with JOBS_LOCK:
            UPLOADING.discard(job_id)
        raise

    with JOBS_LOCK:
        UPLOADING.discard(job_id)
        JOBS[job_id] = {
            "filename": filename,
            "status": "queued",
            "progress": 0.0,
            "requested_language": lang,
            "segments": [],
            "created_at": time.time(),
        }
    EXECUTOR.submit(_process, job_id)
    log.info("Job %s: queued %r (%.1f MB)", job_id, filename, size / 1024 / 1024)
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "Transcript not found. It may have expired.")
        return _public(job_id, job)


@app.delete("/api/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    with JOBS_LOCK:
        job = JOBS.pop(job_id, None)
    if job is None:
        raise HTTPException(404, "Transcript not found.")
    # If it hadn't started yet, remove the upload now instead of waiting.
    if job["status"] == "queued":
        shutil.rmtree(WORK_DIR / job_id, ignore_errors=True)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
