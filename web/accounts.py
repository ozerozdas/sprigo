"""Per-account SQLite databases with optional passwords for standalone Sprigo Web."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

SESSION_SECONDS = 30 * 24 * 3600
USERNAME = re.compile(r"[A-Za-z0-9_.-]{3,32}\Z")
DENIED = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_CREATE_VTABLE,
          sqlite3.SQLITE_DROP_VTABLE}


class AccountError(ValueError):
    pass


class Accounts:
    def __init__(self, root: Path):
        self.root = root
        self.db_dir = root / 'accounts'
        self.db_dir.mkdir(parents=True, exist_ok=True)
        self.meta = root / 'accounts.sqlite3'
        self.lock = threading.RLock()
        self.db_locks: dict[str, threading.Lock] = {}
        with self._meta() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS accounts(
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at INTEGER NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS sessions(
                    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
            ''')
            if 'revision' not in [row[1] for row in db.execute('PRAGMA table_info(accounts)')]:
                db.execute('ALTER TABLE accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')

    def _meta(self):
        db = sqlite3.connect(self.meta, timeout=20)
        db.execute('PRAGMA foreign_keys=ON')
        return db

    @staticmethod
    def _hash(password: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 400_000)

    def _session(self, db: sqlite3.Connection, account_id: str) -> str:
        db.execute('DELETE FROM sessions WHERE expires_at <= ?', (int(time.time()),))
        token = secrets.token_urlsafe(32)
        db.execute('INSERT INTO sessions VALUES (?, ?, ?)',
                   (hashlib.sha256(token.encode()).hexdigest(), account_id, int(time.time()) + SESSION_SECONDS))
        return token

    def register(self, username: str, password: str, import_db: bytes | None = None) -> str:
        if not isinstance(username, str) or not isinstance(password, str):
            raise AccountError('Invalid account details')
        username = username.strip()
        if not USERNAME.fullmatch(username):
            raise AccountError('Username: 3–32 letters, numbers, dots, dashes or underscores')
        if password and not 4 <= len(password) <= 128:
            raise AccountError('Password must be 4–128 characters or empty')
        if import_db is not None and (len(import_db) < 100 or len(import_db) > 32 * 1024 * 1024 or not import_db.startswith(b'SQLite format 3\0')):
            raise AccountError('Invalid local database')
        account_id = secrets.token_hex(16)
        path = self.db_dir / f'{account_id}.sqlite3'
        if import_db is not None:
            path.write_bytes(import_db)
            try:
                with sqlite3.connect(path) as db:
                    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise AccountError('Local database integrity check failed')
                    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profiles'").fetchone():
                        raise AccountError('Local database has no Sprigo profiles')
            except Exception:
                path.unlink(missing_ok=True)
                raise
        else:
            sqlite3.connect(path).close()
        salt = secrets.token_bytes(16)
        try:
            with self.lock, self._meta() as db:
                db.execute('INSERT INTO accounts(id, username, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
                           (account_id, username, salt, self._hash(password, salt), int(time.time())))
                token = self._session(db, account_id)
            return token
        except sqlite3.IntegrityError as exc:
            path.unlink(missing_ok=True)
            raise AccountError('Username already exists') from exc
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def login(self, username: str, password: str) -> str:
        if not isinstance(username, str) or not isinstance(password, str):
            raise AccountError('Invalid username or password')
        with self.lock, self._meta() as db:
            row = db.execute('SELECT id, salt, password_hash FROM accounts WHERE username = ?', (username.strip(),)).fetchone()
            if row is None or not hmac.compare_digest(self._hash(password, row[1]), row[2]):
                raise AccountError('Invalid username or password')
            return self._session(db, row[0])

    def session(self, token: str | None) -> tuple[str, str] | None:
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock, self._meta() as db:
            row = db.execute('''SELECT accounts.id, accounts.username FROM sessions
                JOIN accounts ON accounts.id = sessions.account_id
                WHERE token_hash = ? AND expires_at > ?''', (digest, int(time.time()))).fetchone()
            return (row[0], row[1]) if row else None

    def revision(self, account_id: str) -> int:
        with self.lock, self._meta() as db:
            row = db.execute('SELECT revision FROM accounts WHERE id = ?', (account_id,)).fetchone()
            return row[0] if row else 0

    def logout(self, token: str | None):
        if token:
            with self.lock, self._meta() as db:
                db.execute('DELETE FROM sessions WHERE token_hash = ?', (hashlib.sha256(token.encode()).hexdigest(),))

    def sql(self, account_id: str, kind: str, statement: str, args: list):
        if kind not in ('select', 'execute') or not isinstance(statement, str) or len(statement) > 100_000 or not isinstance(args, list) or len(args) > 1000:
            raise AccountError('Invalid SQL request')
        lead = statement.lstrip().split(None, 1)[0].lower().rstrip(';') if statement.strip() else ''
        if kind == 'select' and lead not in ('select', 'with', 'pragma'):
            raise AccountError('Invalid read query')
        if kind == 'select' and lead == 'pragma' and statement.strip().lower().rstrip(';') != 'pragma user_version':
            raise AccountError('SQL operation not allowed')
        if lead in ('attach', 'detach', 'vacuum'):
            raise AccountError('SQL operation not allowed')
        path = self.db_dir / f'{account_id}.sqlite3'
        with self.lock:
            lock = self.db_locks.setdefault(account_id, threading.Lock())
        with lock:
            db = sqlite3.connect(path, timeout=20)
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA trusted_schema=OFF')
            db.execute('PRAGMA busy_timeout=5000')
            def authorize(action, arg1, arg2, db_name, source):
                if action in DENIED:
                    return sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_PRAGMA and (arg1 or '').lower() != 'user_version':
                    return sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_FUNCTION and (arg2 or '').lower() == 'load_extension':
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorize)
            try:
                if kind == 'select':
                    return [dict(row) for row in db.execute(statement, args).fetchall()]
                before = db.total_changes
                if args:
                    db.execute(statement, args)
                elif ';' in statement.strip().rstrip(';'):
                    db.executescript(statement)
                else:
                    db.execute(statement)
                last_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
                db.commit()
                changed = db.total_changes > before or lead in ('begin', 'create', 'alter', 'drop')
                if changed:
                    with self.lock, self._meta() as meta:
                        meta.execute('UPDATE accounts SET revision = revision + 1 WHERE id = ?', (account_id,))
                return {'lastInsertId': last_id, 'revision': self.revision(account_id)}
            finally:
                db.close()
