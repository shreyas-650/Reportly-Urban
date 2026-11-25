"""
ReportlyUrban — Bounded In-Process LRU TTL Cache for Public Endpoints
Features:
  - Per-endpoint TTL expiration.
  - True LRU eviction bounded at max_entries.
  - Per-key async locking to prevent stampedes on concurrent cold reads,
    with automatic reference-counted cleanup so locks do not leak memory.
  - Never caches errors or failed responses.
"""

import asyncio
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Dict, Tuple

from app.config import settings


class BoundedTTLCache:
    """Thread/async-safe bounded LRU cache with per-entry TTL."""

    def __init__(self, max_entries: int = 512):
        self.max_entries = max(1, max_entries)
        self._store: OrderedDict[str, Tuple[float, Any]] = OrderedDict()
        self._meta_lock = asyncio.Lock()
        self._key_locks: Dict[str, asyncio.Lock] = {}
        self._key_lock_waiters: Dict[str, int] = {}

    def _evict_expired(self, now: float) -> None:
        expired_keys = [k for k, (expires_at, _) in self._store.items() if expires_at <= now]
        for k in expired_keys:
            self._store.pop(k, None)

    async def _acquire_key_lock(self, key: str) -> asyncio.Lock:
        async with self._meta_lock:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._key_locks[key] = lock
            self._key_lock_waiters[key] = self._key_lock_waiters.get(key, 0) + 1
            return lock

    async def _release_key_lock(self, key: str) -> None:
        async with self._meta_lock:
            remaining = self._key_lock_waiters.get(key, 0) - 1
            if remaining <= 0:
                self._key_lock_waiters.pop(key, None)
                self._key_locks.pop(key, None)
            else:
                self._key_lock_waiters[key] = remaining

    async def get(self, key: str) -> Any:
        now = time.monotonic()
        async with self._meta_lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at <= now:
                self._store.pop(key, None)
                return None
            self._store.move_to_end(key)
            return value

    async def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        now = time.monotonic()
        expires_at = now + ttl_seconds
        async with self._meta_lock:
            if key in self._store:
                self._store.pop(key, None)
            elif len(self._store) >= self.max_entries:
                self._evict_expired(now)
                while len(self._store) >= self.max_entries:
                    self._store.popitem(last=False)
            self._store[key] = (expires_at, value)

    async def get_or_load(
        self,
        key: str,
        ttl_seconds: int,
        loader: Callable[[], Awaitable[Any]],
    ) -> Any:
        """
        Returns cached value if valid; otherwise acquires a reference-counted
        per-key lock so concurrent callers share a single RPC execution.
        Lock entries are removed as soon as all waiters finish.
        Exceptions propagate without populating the cache.
        """
        cached = await self.get(key)
        if cached is not None:
            return cached

        key_lock = await self._acquire_key_lock(key)
        try:
            async with key_lock:
                cached = await self.get(key)
                if cached is not None:
                    return cached

                value = await loader()
                await self.set(key, value, ttl_seconds)
                return value
        finally:
            await self._release_key_lock(key)

    async def clear(self) -> None:
        async with self._meta_lock:
            self._store.clear()
            self._key_locks.clear()
            self._key_lock_waiters.clear()


public_cache = BoundedTTLCache(max_entries=settings.PUBLIC_CACHE_MAX_ENTRIES)
