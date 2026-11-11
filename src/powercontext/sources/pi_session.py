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

"""Pi session history as immutable, resumable event evidence.

One Pi session file stores a tree: every record names its parent, so a selected
leaf determines the branch the Pi coding agent actually followed.  This module
captures the raw visible events of that branch -- text, tool calls, tool results,
bash executions and compaction or branch summaries -- as captured Sources, and a
connector that imports only the events a previous run has not seen yet while
detecting rewritten history.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, JsonValue

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import (
    TEXT_EVIDENCE_PROJECTION_KEY,
    AdapterSourceDefinition,
    ConnectorRunCompletion,
    ConnectorRunSession,
    ConnectorRunStatus,
    TextEvidence,
)
from powercontext.sources.models import Source, SourceMaterialization

PI_EVENT_SOURCE_NAME = "pi-event"
PI_SESSION_CONNECTOR_NAME = "pi-session-history"
_IDENTITY_PREFIX = "pi"
CHECKPOINT_VERSION = 1


class PiSessionInput(BaseModel):
    """One raw Pi session archive plus the optional branch tip to follow."""

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """Adapter-native input describing exactly one visible branch event."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


class PiEventSource(Source):
    """Captured Pi event that keeps the complete original record."""

    source_id: str
    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


def pi_event_source_id(session_id: str, event_id: str, /) -> str:
    """Return the bounded identity that only the session and event determine."""

    if not session_id or not event_id:
        raise ValueError("session and event identifiers must not be empty")  # noqa: TRY003
    identity = f"{_IDENTITY_PREFIX}:{quote(session_id, safe='')}:{quote(event_id, safe='')}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError("pi event identity must not exceed the Source identifier limit")  # noqa: TRY003
    return identity


def parse_pi_session(value: PiSessionInput, /) -> tuple[PiEventInput, ...]:
    """Return the visible events of the selected branch, ordered root to leaf."""

    text = _decode(value.content)
    records = _load_records(text)
    header, nodes, order = _split_header_and_nodes(records)
    session_id = header["id"]
    leaf_id = value.leaf_id if value.leaf_id is not None else order[-1]
    if leaf_id not in nodes:
        raise ValueError(f"leaf {leaf_id!r} is not part of this session")  # noqa: TRY003

    events: list[PiEventInput] = []
    for event_id in _branch_order(nodes, leaf_id):
        content = _render_event(nodes[event_id])
        if content is None:
            continue
        record = nodes[event_id]
        events.append(
            PiEventInput(
                session_id=session_id,
                event_id=event_id,
                parent_id=record.get("parentId"),
                event_type=record["type"],
                role=content[0],
                content=f"{content[0]}: {content[1]}",
                record=record,
            )
        )
    return tuple(events)


def _decode(content: bytes) -> str:
    if not isinstance(content, bytes):
        raise TypeError("Pi session content must be raw bytes")  # noqa: TRY003
    return content.decode("utf-8").removeprefix("\ufeff")


def _load_records(text: str) -> list[Any]:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError("a Pi session archive must start with a session header")  # noqa: TRY003
    return [_parse_line(line) for line in lines]


def _parse_line(line: str) -> Any:
    try:
        return json.loads(line)
    except json.JSONDecodeError as error:
        raise ValueError(f"malformed Pi session record: {error}") from error


def _split_header_and_nodes(records: list[Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]], list[str]]:
    header = records[0]
    if not isinstance(header, dict) or header.get("type") != "session":
        raise ValueError("the first record must be a session header")  # noqa: TRY003
    if header.get("version") != 3:
        raise ValueError("only Pi session version 3 is supported")  # noqa: TRY003
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("the session header must carry a non-empty id")  # noqa: TRY003

    nodes: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for record in records[1:]:
        if not isinstance(record, dict):
            raise ValueError("every session record must be a JSON object")  # noqa: TRY003
        event_id = record.get("id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("every session record must carry a non-empty id")  # noqa: TRY003
        if event_id in nodes:
            raise ValueError(f"duplicate session record id {event_id!r}")  # noqa: TRY003
        event_type = record.get("type")
        if not isinstance(event_type, str) or not event_type:
            raise ValueError(f"record {event_id!r} must declare a type")  # noqa: TRY003
        parent_id = record.get("parentId")
        if parent_id is not None and parent_id not in nodes:
            raise ValueError(f"record {event_id!r} references an unknown parent {parent_id!r}")  # noqa: TRY003
        nodes[event_id] = record
        order.append(event_id)
    if not order:
        raise ValueError("a Pi session archive must contain at least one record")  # noqa: TRY003
    return header, nodes, order


def _branch_order(nodes: dict[str, dict[str, Any]], leaf_id: str) -> list[str]:
    order: list[str] = []
    current: str | None = leaf_id
    while current is not None:
        order.append(current)
        current = nodes[current].get("parentId")
    order.reverse()
    return order


def _render_event(record: dict[str, Any]) -> tuple[str, str] | None:
    """Return ``(role, body)`` for a visible event, or ``None`` when it has no text."""

    event_type = record["type"]
    if event_type == "message":
        message = record.get("message")
        if not isinstance(message, dict):
            return None
        role = message.get("role")
        if not isinstance(role, str) or not role:
            return None
        if role == "toolResult":
            tool_name = _text(message.get("toolName"), "unknown")
            tool_call_id = _text(message.get("toolCallId"), "unknown")
            body = f"[tool_result {tool_name} {tool_call_id}]"
            detail = _message_text(message.get("content"), include_tool_calls=False)
            if detail:
                body = f"{body} {detail}"
        elif role == "bashExecution":
            command = _text(message.get("command"), "")
            output = _text(message.get("output"), "")
            if not command and not output:
                return None
            body = f"$ {command}" if command else ""
            if output:
                body = f"{body}\n{output}" if body else output
        else:
            body = _message_text(message.get("content"), include_tool_calls=True)
        return (role, body) if body.strip() else None
    if event_type in {"compaction", "branch_summary"}:
        summary = _text(record.get("summary"), "")
        return (event_type, summary) if summary.strip() else None
    if event_type == "custom_message":
        body = _message_text(record.get("content"), include_tool_calls=False)
        return ("custom", body) if body.strip() else None
    return None


def _message_text(content: Any, *, include_tool_calls: bool) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
        elif block_type == "toolCall" and include_tool_calls:
            name = _text(block.get("name"), "unknown")
            call_id = _text(block.get("id"), "unknown")
            arguments = block.get("arguments")
            rendered = json.dumps(
                arguments if arguments is not None else {},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            parts.append(f"[tool_call {name} {call_id}] {rendered}")
    return "\n".join(parts)


def _text(value: Any, default: str) -> str:
    return value if isinstance(value, str) else default


class PiEventSourceAdapter:
    """Resolve and read the immutable Pi event Source."""

    input_class = PiEventInput
    name = PI_EVENT_SOURCE_NAME
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        identity = pi_event_source_id(value.session_id, value.event_id)
        return PiEventSource(
            name=identity,
            source_id=identity,
            materialization=SourceMaterialization.CAPTURED,
            session_id=value.session_id,
            event_id=value.event_id,
            parent_id=value.parent_id,
            event_type=value.event_type,
            role=value.role,
            content=value.content,
            record=value.record,
        )

    async def read(self, source: PiEventSource, /) -> PiEventInput:
        return PiEventInput(
            session_id=source.session_id,
            event_id=source.event_id,
            parent_id=source.parent_id,
            event_type=source.event_type,
            role=source.role,
            content=source.content,
            record=source.record,
        )


class PiEventTextEvidenceProjection:
    """Expose one event's original text without dropping its identity."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PiEventSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PI_EVENT_SOURCE_NAME,
            source_id=source.source_id,
            content=source.content,
            metadata={
                "session_id": source.session_id,
                "event_id": source.event_id,
                "parent_id": source.parent_id,
                "event_type": source.event_type,
                "role": source.role,
            },
        )


PI_EVENT_SOURCE_ADAPTER = PiEventSourceAdapter()
PI_EVENT_SOURCE_DEFINITION = AdapterSourceDefinition(
    PI_EVENT_SOURCE_ADAPTER,
    projections=(PiEventTextEvidenceProjection(),),
)


class PiSessionConnector:
    """Import the not-yet-imported visible events of one Pi branch."""

    name = PI_SESSION_CONNECTOR_NAME
    version = "1"
    source_definitions = frozenset({PI_EVENT_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self._path = Path(path)
        self._leaf_id = leaf_id

    async def run(self, session: ConnectorRunSession, /) -> ConnectorRunCompletion:
        events = parse_pi_session(PiSessionInput(content=self._path.read_bytes(), leaf_id=self._leaf_id))
        imported = _load_checkpoint(session.checkpoint)

        entries: list[dict[str, str]] = []
        pending: list[PiEventInput] = []
        for event in events:
            digest = _record_digest(event.record)
            known = imported.get(event.event_id)
            if known is None:
                pending.append(event)
            elif known != digest:
                raise ValueError(  # noqa: TRY003
                    f"event {event.event_id!r} was rewritten after it had been imported"
                )
            entries.append({"event_id": event.event_id, "digest": digest})

        for event in pending:
            await session.submit(event.event_id, PI_EVENT_SOURCE_NAME, event)

        checkpoint: JsonValue = {"version": CHECKPOINT_VERSION, "events": entries}
        if checkpoint == session.checkpoint:
            checkpoint = session.checkpoint
        return ConnectorRunCompletion(status=ConnectorRunStatus.COMPLETE, checkpoint=checkpoint)


def _load_checkpoint(checkpoint: JsonValue | None) -> dict[str, str]:
    if not isinstance(checkpoint, dict):
        return {}
    events = checkpoint.get("events")
    if not isinstance(events, list):
        return {}
    imported: dict[str, str] = {}
    for entry in events:
        if isinstance(entry, dict) and isinstance(entry.get("event_id"), str) and isinstance(entry.get("digest"), str):
            imported[entry["event_id"]] = entry["digest"]
    return imported


def _record_digest(record: dict[str, JsonValue], /) -> str:
    encoded = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


__all__ = [
    "CHECKPOINT_VERSION",
    "PI_EVENT_SOURCE_ADAPTER",
    "PI_EVENT_SOURCE_DEFINITION",
    "PI_EVENT_SOURCE_NAME",
    "PI_SESSION_CONNECTOR_NAME",
    "PiEventInput",
    "PiEventSource",
    "PiEventSourceAdapter",
    "PiEventTextEvidenceProjection",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
    "pi_event_source_id",
]
