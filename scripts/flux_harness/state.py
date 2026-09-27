"""Durable turn checkpoints, outbox intent, and a process-lifetime worker lock."""

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import time

from .github import HarnessError


class State:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.directory / "journal.sqlite3"
        self.connection = sqlite3.connect(self.database, timeout=30)
        os.chmod(self.database, 0o600)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript("""
          CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, issue INTEGER NOT NULL,
            body TEXT NOT NULL, comment_id INTEGER);
          CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, started REAL NOT NULL,
            snapshot TEXT NOT NULL, result TEXT, status TEXT NOT NULL);
        """)

    def close(self):
        self.connection.close()

    def get(self, key, default=None):
        row = self.connection.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        with self.connection:
            self.connection.execute("INSERT OR REPLACE INTO state VALUES(?,?)", (key, json.dumps(value)))

    def begin(self, turn_id, snapshot):
        with self.connection:
            self.connection.execute("INSERT INTO turns VALUES(?,?,?,?,?)",
                                    (turn_id, time.time(), snapshot, None, "running"))
        self.set("active_turn", turn_id)

    def finish(self, turn_id, result, status):
        with self.connection:
            self.connection.execute("UPDATE turns SET result=?,status=? WHERE id=?",
                                    (json.dumps(result), status, turn_id))
        self.set("last_result", result)
        self.set("active_turn", None)

    def stage_message(self, message_id, issue, body):
        row = self.connection.execute("SELECT issue,body FROM outbox WHERE id=?", (message_id,)).fetchone()
        if row and row != (issue, body):
            raise HarnessError("A durable message ID cannot be reused for a different action")
        with self.connection:
            self.connection.execute("INSERT OR IGNORE INTO outbox VALUES(?,?,?,NULL)",
                                    (message_id, issue, body))

    def delivered(self, message_id, comment_id):
        with self.connection:
            self.connection.execute("UPDATE outbox SET comment_id=? WHERE id=?", (comment_id, message_id))

    def pending(self):
        return self.connection.execute("SELECT id,issue,body FROM outbox WHERE comment_id IS NULL").fetchall()


@contextmanager
def worker_lock(directory):
    path = Path(directory) / "worker.lock"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise HarnessError("Another runner for this worker is active in this checkout") from error
        try:
            handle.seek(0)
            handle.truncate()
            handle.write(str(os.getpid()))
            handle.flush()
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
