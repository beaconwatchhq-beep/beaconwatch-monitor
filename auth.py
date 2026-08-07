"""Admin auth: bcrypt hash comparison + rate limiting. No plaintext password in source.

CLI usage: python auth.py "your-password"   -> prints a bcrypt hash for DEER_ADMIN_HASH
"""

import hmac
import os
import sys
import time

import bcrypt

MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 60


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str) -> bool:
    stored_hash = os.environ.get("DEER_ADMIN_HASH", "")
    if not stored_hash:
        return False
    try:
        is_match = bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
    except ValueError:
        return False
    return hmac.compare_digest(b"1" if is_match else b"0", b"1")


class RateLimiter:
    """Tracks failed attempts in a caller-supplied dict (e.g. st.session_state)."""

    def __init__(self, state: dict, max_attempts: int = MAX_ATTEMPTS, lockout_seconds: int = LOCKOUT_SECONDS):
        self.state = state
        self.max_attempts = max_attempts
        self.lockout_seconds = lockout_seconds
        self.state.setdefault("auth_failed_attempts", 0)
        self.state.setdefault("auth_locked_until", 0.0)

    def is_locked(self) -> bool:
        return time.time() < self.state.get("auth_locked_until", 0.0)

    def seconds_remaining(self) -> int:
        remaining = self.state.get("auth_locked_until", 0.0) - time.time()
        return max(0, int(remaining))

    def record_failure(self):
        self.state["auth_failed_attempts"] = self.state.get("auth_failed_attempts", 0) + 1
        if self.state["auth_failed_attempts"] >= self.max_attempts:
            self.state["auth_locked_until"] = time.time() + self.lockout_seconds
            self.state["auth_failed_attempts"] = 0

    def record_success(self):
        self.state["auth_failed_attempts"] = 0
        self.state["auth_locked_until"] = 0.0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python auth.py <password>", file=sys.stderr)
        sys.exit(1)
    print(hash_password(sys.argv[1]))
