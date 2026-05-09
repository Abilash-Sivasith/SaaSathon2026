#!/usr/bin/env python3
"""Local transcription server using OpenAI.

POST multipart/form-data with field "audio" to /transcribe.
Returns JSON: { "text": "...", "isFinal": true }

Env:
- OPENAI_API_KEY (required unless you pass Authorization/X-API-Key header)
- OPENAI_MODEL (optional, default: gpt-4o-mini-transcribe)
- PORT (optional, default: 5123)
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import base64

from openai import OpenAI

HOST = "127.0.0.1"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(Path(__file__).with_name('.env'))

PORT = int(os.getenv("PORT", "5123"))
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini-transcribe")


def parse_multipart(body: bytes, boundary: bytes) -> tuple[dict, dict]:
    fields: dict[str, str] = {}
    files: dict[str, dict] = {}

    delimiter = b"--" + boundary
    for part in body.split(delimiter):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue

        header_blob, _, content = part.partition(b"\r\n\r\n")
        headers = header_blob.decode("utf-8", errors="ignore").split("\r\n")
        header_map: dict[str, str] = {}
        for line in headers:
            if ":" in line:
                k, v = line.split(":", 1)
                header_map[k.strip().lower()] = v.strip()

        disp = header_map.get("content-disposition", "")
        name = ""
        filename = ""
        for item in disp.split(";"):
            item = item.strip()
            if item.startswith("name="):
                name = item.split("=", 1)[1].strip('"')
            elif item.startswith("filename="):
                filename = item.split("=", 1)[1].strip('"')

        if not name:
            continue

        if filename:
            if content.endswith(b"\r\n"):
                content = content[:-2]
            files[name] = {
                "filename": filename,
                "content": content,
                "content_type": header_map.get("content-type", ""),
            }
        else:
            fields[name] = content.decode("utf-8", errors="ignore").strip()

    return fields, files


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/":
            self._send_json(200, {"ok": True, "model": MODEL})
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/transcribe":
            self._send_json(404, {"error": "not_found"})
            return

        content_type = self.headers.get("content-type", "")
        if "application/json" in content_type:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            try:
                data = json.loads(body.decode("utf-8"))
            except Exception:
                self._send_json(400, {"error": "invalid_json"})
                return

            audio_b64 = data.get("audioB64", "")
            if not audio_b64:
                self._send_json(400, {"error": "missing_audio_field"})
                return

            try:
                audio = base64.b64decode(audio_b64)
            except Exception:
                self._send_json(400, {"error": "invalid_base64"})
                return

            source = data.get("source", "unknown")
            chunk_index = data.get("chunkIndex", "?")
            filename = data.get("filename", "audio.webm")
            content_type = data.get("mimeType", "audio/webm")
        else:
            if "multipart/form-data" not in content_type:
                self._send_json(400, {"error": "expected_multipart_or_json"})
                return

            boundary = ""
            for part in content_type.split(";"):
                part = part.strip()
                if part.startswith("boundary="):
                    boundary = part.split("=", 1)[1]
                    break
            if not boundary:
                self._send_json(400, {"error": "missing_boundary"})
                return

            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length)
            fields, files = parse_multipart(body, boundary.encode("utf-8"))

            if "audio" not in files:
                self._send_json(400, {"error": "missing_audio_field"})
                return

            source = fields.get("source", "unknown")
            chunk_index = fields.get("chunkIndex", "?")
            audio = files["audio"]["content"]
            filename = files["audio"]["filename"] or "audio.webm"
            content_type = files["audio"]["content_type"] or "audio/webm"

        header_key = self.headers.get("authorization") or self.headers.get("x-api-key")
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key and header_key:
            api_key = header_key.replace("Bearer ", "").strip()

        if not api_key:
            self._send_json(401, {"error": "missing_openai_api_key"})
            return

        print(f"[Server] {source} chunk {chunk_index} size={len(audio)} bytes type={content_type}")
        client = OpenAI(api_key=api_key)

        try:
            if content_type.startswith("audio/wav"):
                transcript = client.audio.transcriptions.create(
                    model=MODEL,
                    file=("audio.wav", audio, "audio/wav"),
                    response_format="json",
                )
            else:
                if len(audio) < 40000:
                    self._send_json(200, {"text": "", "isFinal": False})
                    return
                with tempfile.TemporaryDirectory() as tmpdir:
                    in_path = Path(tmpdir) / "input.webm"
                    out_path = Path(tmpdir) / "output.wav"
                    in_path.write_bytes(audio)

                    ffmpeg_cmd = [
                        "ffmpeg",
                        "-y",
                        "-i",
                        str(in_path),
                        "-ac",
                        "1",
                        "-ar",
                        "16000",
                        str(out_path),
                    ]
                    proc = subprocess.run(
                        ffmpeg_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        check=False,
                    )
                    if proc.returncode != 0 or not out_path.exists():
                        err_text = proc.stderr.decode("utf-8", errors="ignore")
                        print("[Server] ffmpeg failed:", err_text)
                        self._send_json(
                            500,
                            {
                                "error": "ffmpeg_failed",
                                "message": err_text,
                            },
                        )
                        return

                    wav_bytes = out_path.read_bytes()
                    transcript = client.audio.transcriptions.create(
                        model=MODEL,
                        file=("audio.wav", wav_bytes, "audio/wav"),
                        response_format="json",
                    )
        except Exception as exc:
            self._send_json(500, {"error": "openai_request_failed", "message": str(exc)})
            return

        text = getattr(transcript, "text", None)
        if not text and isinstance(transcript, dict):
            text = transcript.get("text")

        stamp = datetime.utcnow().strftime("%H:%M:%S")
        prefix = f"[{stamp}] {source} chunk {chunk_index}: "
        self._send_json(200, {"text": f"{prefix}{text or ''}", "isFinal": True})


if __name__ == "__main__":
    print(f"OpenAI transcription server listening on http://{HOST}:{PORT}")
    HTTPServer((HOST, PORT), Handler).serve_forever()
