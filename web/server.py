"""Standalone HTTPS host for Sprigo's browser UI, local Ollama, and local Whisper."""
from array import array
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import base64
import binascii
import io
import json
import os
import sqlite3
import ssl
import struct
import threading
import tempfile
import time
import wave
from faster_whisper import WhisperModel
from accounts import Accounts, AccountError, SESSION_SECONDS

DIST = Path('/app/dist')
CERTS = Path('/app/certs')
OLLAMA = os.environ.get('OLLAMA_URL', 'http://host.docker.internal:11434').rstrip('/')
WHISPER_DIR = '/app/models'
_WHISPER = None
_WHISPER_LOCK = threading.Lock()
MODEL = os.environ.get('MODEL_NAME', 'qwen3:8b')
MAX_BODY = 4 * 1024 * 1024
MAX_ACCOUNT_BODY = 45 * 1024 * 1024
ACCOUNTS = Accounts(Path(os.environ.get('DATA_DIR', '/app/data')))
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
LOGIN_LOCK = threading.Lock()
ALLOWED = {'/api/generate', '/api/chat', '/v1/chat/completions'}


def wav_from_float32(body):
    if len(body) % 4:
        raise ValueError('Invalid float32 audio')
    values = array('f')
    values.frombytes(body)
    pcm = array('h', (int(max(-1, min(1, x)) * 32767) for x in values))
    out = io.BytesIO()
    with wave.open(out, 'wb') as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(16000)
        file.writeframes(pcm.tobytes())
    return out.getvalue()


def transcribe_english(wav):
    global _WHISPER
    with _WHISPER_LOCK:
        if _WHISPER is None:
            _WHISPER = WhisperModel('base.en', device='cpu', compute_type='int8',
                                    cpu_threads=4, num_workers=1, download_root=WHISPER_DIR)
        with tempfile.NamedTemporaryFile(suffix='.wav') as file:
            file.write(wav)
            file.flush()
            segments, _ = _WHISPER.transcribe(file.name, language='en', beam_size=1)
            return ' '.join(part.text.strip() for part in segments).strip()


class App(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def reply(self, status, data, content_type='text/plain; charset=utf-8', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def read_body(self, limit=MAX_BODY):
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ValueError('Missing content length')
        if size < 1 or size > limit:
            raise ValueError('Request body too large or empty')
        return self.rfile.read(size)

    def token(self):
        for part in self.headers.get('Cookie', '').split(';'):
            if part.strip().startswith('sprigo_session='):
                return part.strip().split('=', 1)[1]
        return None

    def account(self):
        return ACCOUNTS.session(self.token())

    def account_post(self, path):
        if self.headers.get('X-Sprigo') != '1' or self.headers.get('Origin') != f"https://{self.headers.get('Host')}":
            return self.reply(403, b'Origin rejected')
        body = self.read_body(MAX_ACCOUNT_BODY if path == '/account/register' else MAX_BODY)
        data = json.loads(body)
        if not isinstance(data, dict):
            return self.reply(400, b'Invalid request')
        if path == '/account/register':
            encoded = data.get('localDb')
            local = base64.b64decode(encoded, validate=True) if encoded is not None else None
            token = ACCOUNTS.register(data.get('username', ''), data.get('password', ''), local)
            return self.reply(201, b'{"ok":true}', 'application/json',
                {'Set-Cookie': f'sprigo_session={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}'})
        if path == '/account/login':
            ip = self.client_address[0]
            with LOGIN_LOCK:
                recent = [x for x in LOGIN_ATTEMPTS.get(ip, []) if x > time.time() - 600]
                LOGIN_ATTEMPTS[ip] = recent
                if len(recent) >= 8:
                    return self.reply(429, b'Too many login attempts. Try again later.')
            try:
                token = ACCOUNTS.login(data.get('username', ''), data.get('password', ''))
            except AccountError:
                with LOGIN_LOCK:
                    LOGIN_ATTEMPTS.setdefault(ip, []).append(time.time())
                return self.reply(401, b'Invalid username or password')
            with LOGIN_LOCK:
                LOGIN_ATTEMPTS.pop(ip, None)
            return self.reply(200, b'{"ok":true}', 'application/json',
                {'Set-Cookie': f'sprigo_session={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={SESSION_SECONDS}'})
        account = self.account()
        if not account:
            return self.reply(401, b'Login required')
        if path == '/account/logout':
            ACCOUNTS.logout(self.token())
            return self.reply(200, b'{"ok":true}', 'application/json',
                {'Set-Cookie': 'sprigo_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'})
        if path == '/account/sql':
            answer = ACCOUNTS.sql(account[0], data.get('kind'), data.get('sql'), data.get('args', []))
            return self.reply(200, json.dumps(answer).encode(), 'application/json')
        return self.reply(404, b'Not found')

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/account/me':
            account = self.account()
            return self.reply(200, json.dumps({'username': account[1], 'revision': ACCOUNTS.revision(account[0])}).encode(), 'application/json') if account else self.reply(401, b'Login required')
        if path == '/account/revision':
            account = self.account()
            return self.reply(200, json.dumps({'revision': ACCOUNTS.revision(account[0])}).encode(), 'application/json') if account else self.reply(401, b'Login required')
        if path.startswith('/account/'):
            return self.reply(404, b'Not found')
        if path == '/health':
            return self.reply(200, b'{"ok":true}', 'application/json')
        if path == '/web-config':
            return self.reply(200, json.dumps({'model': MODEL}).encode(), 'application/json')
        if path == '/ollama/api/tags':
            return self.reply(200, json.dumps({'models': [{'name': MODEL, 'model': MODEL}]}).encode(), 'application/json')
        if path == '/ollama/v1/models':
            return self.reply(200, json.dumps({'object': 'list', 'data': [{'id': MODEL, 'object': 'model'}]}).encode(), 'application/json')
        if path.startswith('/ollama/'):
            return self.reply(404, b'Not found')
        if path == '/ca.crt':
            return self.reply(200, (CERTS/'ca.crt').read_bytes(), 'application/x-x509-ca-cert')
        if not (DIST/path.lstrip('/')).is_file():
            self.path = '/index.html'
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path.startswith('/account/'):
                return self.account_post(path)
            body = self.read_body()
            if path == '/transcribe':
                language = parse_qs(urlsplit(self.path).query).get('lang', ['en'])[0][:2]
                if language != 'en':
                    return self.reply(400, b'English transcription only')
                text = transcribe_english(wav_from_float32(body))
                return self.reply(200, text.encode('utf-8'))
            if path.startswith('/ollama/') and path[len('/ollama'):] in ALLOWED:
                data = json.loads(body)
                if data.get('model') != MODEL:
                    return self.reply(403, b'Model not available')
                req = Request(OLLAMA + path[len('/ollama'):], data=body,
                              headers={'Content-Type': 'application/json'}, method='POST')
                with urlopen(req, timeout=180) as response:
                    self.send_response(response.status)
                    self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    self.close_connection = True
                    while chunk := response.read(8192):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                return
            return self.reply(404, b'Not found')
        except (ValueError, json.JSONDecodeError, binascii.Error, sqlite3.Error) as exc:
            return self.reply(400, str(exc).encode())
        except HTTPError as exc:
            return self.reply(exc.code, exc.read()[:1000])
        except (URLError, TimeoutError) as exc:
            return self.reply(502, str(exc).encode())
        except Exception as exc:
            self.log_error('transcription failed: %s', exc)
            return self.reply(500, b'Transcription failed')


class CertOnly(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/ca.crt':
            self.send_error(404)
            return
        data = (CERTS/'ca.crt').read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-x509-ca-cert')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    cert_server = ThreadingHTTPServer(('0.0.0.0', 1432), CertOnly)
    threading.Thread(target=cert_server.serve_forever, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', 1431), App)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(CERTS/'server.crt'), str(CERTS/'server.key'))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
