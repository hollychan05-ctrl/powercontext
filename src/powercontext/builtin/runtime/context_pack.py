# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Chunked context packs and prefix-reusing deltas.

A prepared context is represented as an ordered tuple of byte chunks with a
content digest.  When a client already holds the previous round's pack it only
needs the chunks that follow the common prefix, so consecutive rounds stop
resending text the receiver already has.  Both wire formats are self-describing
and verifiable, and the receiver rebuilds the target pack from the base pack and
the delta alone.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

PACK_SCHEMA = "powercontext.context-pack.v1"
DELTA_SCHEMA = "powercontext.context-pack-delta.v1"
_PACK_FIELDS = frozenset({"schema", "items", "digest", "byte_count"})
_DELTA_FIELDS = frozenset({"schema", "base_digest", "target_digest", "prefix_items", "appended"})


class ContextPackError(Exception):
    """Raised when a pack or delta payload fails protocol validation."""


@dataclass(frozen=True, slots=True)
class ContextPack:
    """A complete, verifiable context payload."""

    items: tuple[bytes, ...]
    digest: str
    byte_count: int

    @classmethod
    def build(cls, items: tuple[bytes, ...], /) -> ContextPack:
        chunks = tuple(bytes(item) for item in items)
        digest = _digest(chunks)
        byte_count = 0
        for _ in range(4):
            encoded = _canonical(_pack_payload(chunks, digest, byte_count))
            if len(encoded) == byte_count:
                break
            byte_count = len(encoded)
        return cls(items=chunks, digest=digest, byte_count=byte_count)

    @classmethod
    def from_content(cls, content: str, /, *, chunk_bytes: int = 512) -> ContextPack:
        """Split text into deterministic, UTF-8-safe bounded chunks."""

        if type(chunk_bytes) is not int or chunk_bytes < 1:
            raise ContextPackError("chunk_bytes must be a positive integer")
        data = _content_bytes(content)
        return cls.build(_split_chunks(data, chunk_bytes))

    @classmethod
    def from_bytes(cls, data: bytes, /) -> ContextPack:
        payload = _load_object(data, _PACK_FIELDS, "pack")
        if payload["schema"] != PACK_SCHEMA:
            raise ContextPackError("unexpected pack schema")
        chunks = _decode_items(payload["items"])
        digest = _digest(chunks)
        if payload["digest"] != digest:
            raise ContextPackError("pack digest does not match its chunks")
        byte_count = payload["byte_count"]
        if type(byte_count) is not int or byte_count != len(data):
            raise ContextPackError("pack byte_count does not match the payload length")
        return cls(items=chunks, digest=digest, byte_count=byte_count)

    def to_bytes(self) -> bytes:
        return _canonical(_pack_payload(self.items, self.digest, self.byte_count))


@dataclass(frozen=True, slots=True)
class ContextPackDelta:
    """The suffix a receiver must append to a shared prefix."""

    base_digest: str
    target_digest: str
    prefix_items: int
    appended: tuple[bytes, ...] = field(default=())

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack, /) -> ContextPackDelta:
        prefix = 0
        limit = min(len(base.items), len(target.items))
        while prefix < limit and base.items[prefix] == target.items[prefix]:
            prefix += 1
        return cls(
            base_digest=base.digest,
            target_digest=target.digest,
            prefix_items=prefix,
            appended=target.items[prefix:],
        )

    @classmethod
    def from_bytes(cls, data: bytes, /) -> ContextPackDelta:
        payload = _load_object(data, _DELTA_FIELDS, "delta")
        if payload["schema"] != DELTA_SCHEMA:
            raise ContextPackError("unexpected delta schema")
        base_digest = payload["base_digest"]
        target_digest = payload["target_digest"]
        if not isinstance(base_digest, str) or not isinstance(target_digest, str):
            raise ContextPackError("delta digests must be strings")
        prefix_items = payload["prefix_items"]
        if type(prefix_items) is not int or prefix_items < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        return cls(
            base_digest=base_digest,
            target_digest=target_digest,
            prefix_items=prefix_items,
            appended=_decode_items(payload["appended"]),
        )

    @property
    def byte_count(self) -> int:
        return len(self.to_bytes())

    def to_bytes(self) -> bytes:
        return _canonical(
            {
                "schema": DELTA_SCHEMA,
                "base_digest": self.base_digest,
                "target_digest": self.target_digest,
                "prefix_items": self.prefix_items,
                "appended": _encode_items(self.appended),
            }
        )


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta, /) -> ContextPack:
    """Rebuild the target pack from one base pack and one delta."""

    if delta.base_digest != base.digest:
        raise ContextPackError("delta does not belong to this base pack")
    if delta.prefix_items > len(base.items):
        raise ContextPackError("delta prefix exceeds the base pack")
    rebuilt = ContextPack.build((*base.items[: delta.prefix_items], *delta.appended))
    if rebuilt.digest != delta.target_digest:
        raise ContextPackError("rebuilt pack does not match the delta target digest")
    return rebuilt


def _content_bytes(content: object) -> bytes:
    if isinstance(content, str):
        return content.encode("utf-8")
    if isinstance(content, bytes):
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ContextPackError("content must be valid UTF-8") from error
        return content
    raise ContextPackError("content must be text")


def _split_chunks(data: bytes, limit: int) -> tuple[bytes, ...]:
    chunks: list[bytes] = []
    position = 0
    while position < len(data):
        end = min(position + limit, len(data))
        while end < len(data) and (data[end] & 0xC0) == 0x80:
            end -= 1
        if end <= position:
            raise ContextPackError("chunk limit cannot hold one character")
        chunks.append(data[position:end])
        position = end
    return tuple(chunks)


def _digest(chunks: tuple[bytes, ...]) -> str:
    canonical = _canonical({"schema": PACK_SCHEMA, "items": _encode_items(chunks)})
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def _pack_payload(chunks: tuple[bytes, ...], digest: str, byte_count: int) -> dict[str, Any]:
    return {
        "schema": PACK_SCHEMA,
        "items": _encode_items(chunks),
        "digest": digest,
        "byte_count": byte_count,
    }


def _canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _encode_items(chunks: tuple[bytes, ...]) -> list[str]:
    return [base64.b64encode(chunk).decode("ascii") for chunk in chunks]


def _decode_items(values: object) -> tuple[bytes, ...]:
    if not isinstance(values, list):
        raise ContextPackError("chunk payloads must be a list")
    chunks: list[bytes] = []
    for value in values:
        if not isinstance(value, str):
            raise ContextPackError("chunk payloads must be base64 strings")
        try:
            chunks.append(base64.b64decode(value, validate=True))
        except (binascii.Error, ValueError) as error:
            raise ContextPackError("chunk payload is not valid base64") from error
    return tuple(chunks)


def _load_object(data: bytes, expected: frozenset[str], kind: str) -> dict[str, Any]:
    if not isinstance(data, bytes):
        raise ContextPackError(f"{kind} payload must be bytes")
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContextPackError(f"{kind} payload is not valid JSON") from error
    if not isinstance(payload, dict) or set(payload) != expected:
        raise ContextPackError(f"{kind} payload must contain exactly {sorted(expected)}")
    return payload


__all__ = [
    "DELTA_SCHEMA",
    "PACK_SCHEMA",
    "ContextPack",
    "ContextPackDelta",
    "ContextPackError",
    "apply_context_pack_delta",
]
