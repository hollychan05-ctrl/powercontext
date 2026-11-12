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

"""Persistence for scope-local Source lifecycle dependency graphs.

Every row is one registered node of the evidence DAG: its kind, the exact registered binding,
its parents and policy, and the lifecycle state the Runtime last committed. Registration order
is stored as ``ordinal`` so restarting a scope can recompute derived availability in the same
parent-before-child order the writer registered it.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from powercontext.builtin.persistence.database import AsyncDatabase
from powercontext.builtin.persistence.tables import SOURCE_LIFECYCLE_TABLE


@dataclass(frozen=True)
class LifecycleNodeRecord:
    """One persisted node; ``binding`` is the canonical registered reference."""

    node_id: str
    kind: str
    ordinal: int
    binding: dict[str, object]
    parents: tuple[str, ...]
    policy: str
    revision: int | None
    sequence: int
    available: bool


class SourceLifecycleStore:
    """Read and write one scope's Source lifecycle rows."""

    def __init__(self, database: AsyncDatabase) -> None:
        self._database = database

    async def load(self, scope_id: str) -> tuple[LifecycleNodeRecord, ...]:
        async with self._database.transaction() as connection:
            rows = (
                await connection.execute(
                    select(SOURCE_LIFECYCLE_TABLE)
                    .where(SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id)
                    .order_by(SOURCE_LIFECYCLE_TABLE.c.ordinal)
                )
            ).mappings()
            return tuple(_record(row) for row in rows)

    async def insert(self, scope_id: str, record: LifecycleNodeRecord, /) -> None:
        async with self._database.transaction() as connection:
            await connection.execute(
                insert(SOURCE_LIFECYCLE_TABLE).values(_values(scope_id, record))
            )

    async def save(self, scope_id: str, records: Sequence[LifecycleNodeRecord], /) -> None:
        """Persist the current sequence/availability of every changed node in one transaction."""

        if not records:
            return
        async with self._database.transaction() as connection:
            await self._save(connection, scope_id, records)

    async def _save(
        self,
        connection: AsyncConnection,
        scope_id: str,
        records: Sequence[LifecycleNodeRecord],
    ) -> None:
        for record in records:
            await connection.execute(
                update(SOURCE_LIFECYCLE_TABLE)
                .where(
                    SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id,
                    SOURCE_LIFECYCLE_TABLE.c.node_id == record.node_id,
                )
                .values(sequence=record.sequence, available=record.available)
            )

    async def inactive_topic_ids(self, scope_id: str, /) -> frozenset[str]:
        """Return the artifact ids of topics this scope no longer supports."""

        async with self._database.transaction() as connection:
            rows = (
                await connection.execute(
                    select(SOURCE_LIFECYCLE_TABLE.c.binding).where(
                        SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id,
                        SOURCE_LIFECYCLE_TABLE.c.kind == "topic",
                        SOURCE_LIFECYCLE_TABLE.c.available.is_(False),
                    )
                )
            ).scalars()
        inactive: set[str] = set()
        for row in rows:
            artifact_id = json.loads(row).get("artifact_id")
            if artifact_id is not None:
                inactive.add(str(artifact_id))
        return frozenset(inactive)


def _values(scope_id: str, record: LifecycleNodeRecord) -> dict[str, object]:
    return {
        "scope_id": scope_id,
        "node_id": record.node_id,
        "ordinal": record.ordinal,
        "kind": record.kind,
        "binding": json.dumps(record.binding, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        "parents": json.dumps(list(record.parents), ensure_ascii=False, separators=(",", ":")),
        "policy": record.policy,
        "revision": record.revision,
        "sequence": record.sequence,
        "available": record.available,
    }


def _record(row: object) -> LifecycleNodeRecord:
    mapping = dict(row)  # type: ignore[arg-type]
    return LifecycleNodeRecord(
        node_id=str(mapping["node_id"]),
        kind=str(mapping["kind"]),
        ordinal=int(mapping["ordinal"]),
        binding=dict(json.loads(str(mapping["binding"]))),
        parents=tuple(str(parent) for parent in json.loads(str(mapping["parents"]))),
        policy=str(mapping["policy"]),
        revision=None if mapping["revision"] is None else int(mapping["revision"]),
        sequence=int(mapping["sequence"]),
        available=bool(mapping["available"]),
    )
