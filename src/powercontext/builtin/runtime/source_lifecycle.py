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

"""Propagate per-Source lifecycle state through one Scope's evidence DAG.

Each Scope owns an independent directed acyclic graph whose leaves are captured Sources and
whose interior nodes are derived Memory entries or Topic Memory revisions. Withdrawing a Source
recomputes every descendant with the node's own ``all`` / ``any`` policy, deactivates the Memory
entries that lost their support, and hides the unsupported Topics from native search and context.
Restoring a Source re-runs the same propagation so the surviving content becomes usable again
without rewriting any registered body.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, field_validator

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.artifacts.memory.errors import InvalidMemoryCitationError, MemoryEntryNotFoundError
from powercontext.builtin.persistence.source_lifecycle import LifecycleNodeRecord, SourceLifecycleStore
from powercontext.builtin.records import BaseValueNotFoundError
from powercontext.builtin.runtime.models import GetMemoryEntryRequest
from powercontext.builtin.statistics import ModelUsagePurpose
from powercontext.errors import ArtifactNotFoundError
from powercontext.sources import SourceRef

if TYPE_CHECKING:
    from powercontext.builtin.runtime.application import BuiltinRuntime

SourceLifecycleKind = Literal["source", "memory", "topic"]
LifecyclePolicy = Literal["all", "any"]
SourceLifecyclePurpose = Literal["generation", "audit"]
_Validator = Callable[[LifecycleNodeRecord], Awaitable[None]]

_SOURCE: SourceLifecycleKind = "source"
_MEMORY: SourceLifecycleKind = "memory"
_TOPIC: SourceLifecycleKind = "topic"
_POLICIES: frozenset[str] = frozenset({"all", "any"})
_PURPOSES: frozenset[str] = frozenset({"generation", "audit"})
_READ_ERRORS = (
    ArtifactNotFoundError,
    BaseValueNotFoundError,
    MemoryEntryNotFoundError,
    InvalidMemoryCitationError,
)


class SourceLifecycleError(ValueError):
    """Reject an invalid lifecycle registration, event, or resolution."""


class SourceLifecycleEvent(BaseModel):
    """One versioned availability change for a registered Source."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    node_id: str
    revision: StrictInt
    sequence: StrictInt
    available: StrictBool
    reason: str

    @field_validator("node_id", "reason")
    @classmethod
    def _reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must contain non-whitespace content")  # noqa: TRY003
        return value

    @field_validator("revision", "sequence")
    @classmethod
    def _require_positive(cls, value: int) -> int:
        if value < 1:
            raise ValueError("must be a positive integer")  # noqa: TRY003
        return value


class ScopedSourceLifecycle:
    """Register one Scope's evidence graph, apply events, and resolve references."""

    def __init__(self, runtime: BuiltinRuntime, scope_id: str) -> None:
        self._runtime = runtime
        self.scope_id = scope_id
        self._lock = asyncio.Lock()
        self._nodes: dict[str, LifecycleNodeRecord] | None = None

    async def register_source(self, node_id: str, source_ref: SourceRef, /, *, revision: int) -> None:
        """Register a captured Source at one lifecycle revision."""

        _validate_node_id(node_id)
        _validate_revision(revision)
        record = LifecycleNodeRecord(
            node_id=node_id,
            kind=_SOURCE,
            ordinal=-1,
            binding=source_ref.model_dump(mode="json"),
            parents=(),
            policy="all",
            revision=revision,
            sequence=0,
            available=True,
        )
        await self._register(record, validate=self._validate_source_ref)

    async def register_memory(
        self,
        node_id: str,
        citation: MemoryCitation,
        /,
        *,
        parents: tuple[str, ...],
        policy: LifecyclePolicy,
    ) -> None:
        """Register one exact Memory entry version derived from ``parents``."""

        record = self._derived_record(node_id, _MEMORY, citation.model_dump(mode="json"), parents, policy)
        await self._register(record, validate=self._validate_memory_citation)

    async def register_topic(
        self,
        node_id: str,
        artifact_ref: ArtifactRef,
        /,
        *,
        parents: tuple[str, ...],
        policy: LifecyclePolicy,
    ) -> None:
        """Register one exact Topic Memory revision derived from ``parents``."""

        record = self._derived_record(node_id, _TOPIC, artifact_ref.model_dump(mode="json"), parents, policy)
        await self._register(record, validate=self._validate_topic_ref)

    async def apply(self, event: SourceLifecycleEvent, /) -> list[str]:
        """Apply one Source event, propagate it, and return every available node id."""

        async with self._lock:
            nodes = await self._ensure_loaded()
            node = nodes.get(event.node_id)
            if node is None or node.kind != _SOURCE:
                raise SourceLifecycleError(f"unknown Source: {event.node_id}")  # noqa: TRY003
            if event.revision != node.revision:
                raise SourceLifecycleError("lifecycle revision mismatch")  # noqa: TRY003
            if event.sequence < node.sequence:
                raise SourceLifecycleError("lifecycle sequence regressed")  # noqa: TRY003
            if event.sequence == node.sequence:
                if event.available != node.available:
                    raise SourceLifecycleError("lifecycle sequence reused with a different state")  # noqa: TRY003
                # A successful replay must still reconcile native state so an interrupted
                # first attempt finishes without committing a second Memory revision.
                await self._reconcile()
                return self._available_ids()
            updated = replace(node, sequence=event.sequence, available=event.available)
            nodes[event.node_id] = updated
            changed = [updated, *self._propagate()]
            await self._store().save(self.scope_id, changed)
            await self._reconcile()
            return self._available_ids()

    async def resolve(self, node_id: str, /, *, purpose: SourceLifecyclePurpose) -> object:
        """Return the registered reference when ``purpose`` may use the node."""

        if purpose not in _PURPOSES:
            raise SourceLifecycleError(f"unknown lifecycle purpose: {purpose}")  # noqa: TRY003
        nodes = await self._ensure_loaded()
        node = nodes.get(node_id)
        if node is None:
            raise SourceLifecycleError(f"unknown lifecycle node: {node_id}")  # noqa: TRY003
        if purpose == "generation" and not node.available:
            raise SourceLifecycleError(f"node is not available for generation: {node_id}")  # noqa: TRY003
        return _decode_ref(node.kind, node.binding)

    async def inactive_topic_ids(self) -> frozenset[str]:
        """Return the artifact ids of topics this scope no longer supports."""

        return await self._store().inactive_topic_ids(self.scope_id)

    def _derived_record(
        self,
        node_id: str,
        kind: SourceLifecycleKind,
        binding: dict[str, object],
        parents: tuple[str, ...],
        policy: str,
    ) -> LifecycleNodeRecord:
        _validate_node_id(node_id)
        if policy not in _POLICIES:
            raise SourceLifecycleError(f"unknown lifecycle policy: {policy}")  # noqa: TRY003
        if not parents:
            raise SourceLifecycleError("a derived node needs at least one parent")  # noqa: TRY003
        if len(set(parents)) != len(parents):
            raise SourceLifecycleError("duplicate lifecycle parent")  # noqa: TRY003
        if node_id in parents:
            raise SourceLifecycleError("a node cannot derive from itself")  # noqa: TRY003
        return LifecycleNodeRecord(
            node_id=node_id,
            kind=kind,
            ordinal=-1,
            binding=binding,
            parents=tuple(parents),
            policy=policy,
            revision=None,
            sequence=0,
            available=True,
        )

    async def _register(self, record: LifecycleNodeRecord, *, validate: _Validator) -> None:
        async with self._lock:
            nodes = await self._ensure_loaded()
            existing = nodes.get(record.node_id)
            if existing is not None:
                if _same_binding(existing, record):
                    return
                raise SourceLifecycleError(f"conflicting lifecycle registration: {record.node_id}")  # noqa: TRY003
            for parent in record.parents:
                if parent not in nodes:
                    raise SourceLifecycleError(f"unknown lifecycle parent: {parent}")  # noqa: TRY003
            await validate(record)
            ordinal = max((node.ordinal for node in nodes.values()), default=-1) + 1
            stored = replace(record, ordinal=ordinal)
            stored = replace(stored, available=self._initial_availability(stored, nodes))
            nodes[record.node_id] = stored
            await self._store().insert(self.scope_id, stored)
            await self._reconcile()

    def _initial_availability(
        self,
        record: LifecycleNodeRecord,
        nodes: dict[str, LifecycleNodeRecord],
    ) -> bool:
        if record.kind == _SOURCE:
            return True
        support = [nodes[parent].available for parent in record.parents]
        return all(support) if record.policy == "all" else any(support)

    def _propagate(self) -> list[LifecycleNodeRecord]:
        nodes = self._nodes or {}
        changed: list[LifecycleNodeRecord] = []
        for node in sorted(nodes.values(), key=lambda item: item.ordinal):
            if node.kind == _SOURCE:
                continue
            support = [nodes[parent].available for parent in node.parents]
            available = all(support) if node.policy == "all" else any(support)
            if available != node.available:
                updated = replace(node, available=available)
                nodes[node.node_id] = updated
                changed.append(updated)
        return changed

    async def _reconcile(self) -> None:
        nodes = self._nodes or {}
        memory_nodes = [node for node in nodes.values() if node.kind == _MEMORY]
        if not memory_nodes:
            return
        runtime = self._runtime
        async with (
            runtime._context(self.scope_id, embedding_purpose=ModelUsagePurpose.MEMORY_INDEXING) as context,
            runtime._locked(self.scope_id),
        ):
            service = context.artifacts.memory
            try:
                memory = await service.head(context.artifacts.memory_artifact_id)
            except ArtifactNotFoundError:
                return
            versions = {version.entry_id: version for version in await service.entries(memory)}
            for node in sorted(memory_nodes, key=lambda item: item.ordinal):
                entry_id = str(node.binding.get("entry_id", ""))
                version = versions.get(entry_id)
                manifest = {item.entry_id: item for item in memory.content.manifest.entries}
                item = manifest.get(entry_id)
                if version is None or item is None:
                    continue
                target = "active" if node.available else "inactive"
                if item.state == target:
                    continue
                memory = (
                    await service.reactivate(memory, entries=(version,))
                    if target == "active"
                    else await service.forget(memory, entries=(version,))
                )

    async def _validate_source_ref(self, record: LifecycleNodeRecord) -> None:
        ref = SourceRef.model_validate(record.binding)
        try:
            await self._runtime.records.for_scope(self.scope_id).get_source(ref.source_type, ref.source_id)
        except _READ_ERRORS as error:
            raise SourceLifecycleError(f"source is not readable: {ref.source_id}") from error  # noqa: TRY003

    async def _validate_memory_citation(self, record: LifecycleNodeRecord) -> None:
        citation = MemoryCitation.model_validate(record.binding)
        try:
            await self._runtime.memory.for_scope(self.scope_id).get(GetMemoryEntryRequest(citation=citation))
        except _READ_ERRORS as error:
            raise SourceLifecycleError(f"memory entry is not readable: {citation.entry_id}") from error  # noqa: TRY003

    async def _validate_topic_ref(self, record: LifecycleNodeRecord) -> None:
        ref = ArtifactRef.model_validate(record.binding)
        try:
            await self._runtime.records.for_scope(self.scope_id).get_artifact_revision(
                ref.family, ref.artifact_id, ref.revision
            )
        except _READ_ERRORS as error:
            raise SourceLifecycleError(f"topic revision is not readable: {ref.artifact_id}") from error  # noqa: TRY003

    async def _ensure_loaded(self) -> dict[str, LifecycleNodeRecord]:
        if self._nodes is None:
            loaded = await self._store().load(self.scope_id)
            self._nodes = {node.node_id: node for node in loaded}
        return self._nodes

    def _available_ids(self) -> list[str]:
        return sorted(node_id for node_id, node in (self._nodes or {}).items() if node.available)

    def _store(self) -> SourceLifecycleStore:
        store = self._runtime._lifecycle_store
        if store is None:
            raise SourceLifecycleError("source lifecycle requires a relational Runtime")  # noqa: TRY003
        return store


class SourceLifecycleApplication:
    """Select the scoped Source lifecycle service."""

    def __init__(self, runtime: BuiltinRuntime) -> None:
        self._runtime = runtime

    def for_scope(self, scope_id: str, /) -> ScopedSourceLifecycle:
        return ScopedSourceLifecycle(self._runtime, scope_id)

    async def inactive_topic_ids(self, scope_id: str, /) -> frozenset[str]:
        """Topics this scope no longer supports, for the native retrieval filter."""

        store = self._runtime._lifecycle_store
        if store is None:
            return frozenset()
        return await store.inactive_topic_ids(scope_id)


def _validate_node_id(node_id: str) -> None:
    if not isinstance(node_id, str) or not node_id.strip():
        raise SourceLifecycleError("node_id must contain non-whitespace content")  # noqa: TRY003


def _validate_revision(revision: int) -> None:
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise SourceLifecycleError("revision must be a positive integer")  # noqa: TRY003


def _same_binding(existing: LifecycleNodeRecord, incoming: LifecycleNodeRecord) -> bool:
    return (
        existing.kind == incoming.kind
        and existing.binding == incoming.binding
        and existing.parents == incoming.parents
        and existing.policy == incoming.policy
        and existing.revision == incoming.revision
    )


def _decode_ref(kind: SourceLifecycleKind, binding: dict[str, object]) -> object:
    if kind == _SOURCE:
        return SourceRef.model_validate(binding)
    if kind == _MEMORY:
        return MemoryCitation.model_validate(binding)
    return ArtifactRef.model_validate(binding)
