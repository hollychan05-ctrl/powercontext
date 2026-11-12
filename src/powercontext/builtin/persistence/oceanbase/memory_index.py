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

"""OceanBase Memory search indexes using FULLTEXT and vector indexes."""

from __future__ import annotations

from collections.abc import Mapping

from pyobvector import VECTOR, VectorIndex
from sqlalchemy import (
    BigInteger,
    Column,
    MetaData,
    Table,
    UniqueConstraint,
    bindparam,
    delete,
    insert,
    select,
    text,
)
from sqlalchemy.dialects.mysql import match
from sqlalchemy.ext.asyncio import AsyncConnection

from powercontext.artifacts import ArtifactRef
from powercontext.builtin.artifacts.memory import (
    CapabilityNotSupportedError,
    EmbeddingProfile,
    MemoryCapabilities,
    MemoryProjection,
    MemorySearchChannels,
    MemorySearchRequest,
)
from powercontext.builtin.artifacts.memory.canonical import embedding_content_hash, validate_embedding
from powercontext.builtin.persistence.memory_index import memory_channel_hits
from powercontext.builtin.persistence.tables import (
    ARTIFACT_HEADS_TABLE,
    MAX_MEMORY_ENTRY_ID_LENGTH,
    MAX_MEMORY_HASH_LENGTH,
    MEMORY_ENTRY_HEADS_TABLE,
    MEMORY_ENTRY_VERSIONS_TABLE,
    identity_string,
)
from powercontext.builtin.persistence.tags import memory_tag_parameters, memory_tag_sql, tag_predicate
from powercontext.builtin.tags import TagFilter
from powercontext.limits import MAX_ARTIFACT_ID_LENGTH, MAX_SCOPE_ID_LENGTH

_OCEANBASE_FTS_TABLE_NAME = "pc_memory_entry_heads"
_OCEANBASE_FTS_INDEX_NAME = "ix_pc_memory_entry_heads_fts"
_OCEANBASE_CREATE_FTS_SQL = f"""
CREATE FULLTEXT INDEX {_OCEANBASE_FTS_INDEX_NAME}
ON pc_memory_entry_heads (searchable_text) WITH PARSER SPACE
"""
_OCEANBASE_FTS_INDEX_EXISTS_SQL = text(
    """
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'pc_memory_entry_heads'
      AND index_name = :index_name
    """
)
_OCEANBASE_VECTOR_TABLE_NAME = "pc_memory_vector_entries"
_OCEANBASE_VECTOR_INDEX_NAME = "ix_pc_memory_vector_entries_embedding"
_OCEANBASE_VECTOR_TYPE_SQL = text(
    """
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = :table_name
      AND column_name = 'embedding'
    """
)
_OCEANBASE_VECTOR_SEARCH_SQL = """
SELECT
    m.memory_artifact_id,
    m.head_revision,
    m.entry_id,
    m.entry_version_id,
    v.text,
    l2_distance(m.embedding, :query_vector) AS distance
FROM pc_memory_vector_entries AS m
JOIN pc_memory_entry_versions AS v
  ON v.scope_id = m.scope_id
 AND v.memory_artifact_id = m.memory_artifact_id
 AND v.entry_version_id = m.entry_version_id
WHERE m.scope_id = :scope_id
  AND m.memory_artifact_id IN :memory_artifact_ids
ORDER BY l2_distance(m.embedding, :query_vector) APPROXIMATE
LIMIT :candidate_limit
"""

def _hybrid_tag_predicate(alias: str, suffix: str) -> str:
    """A pre-LIMIT tag match for one branch of the hybrid statement.

    Parameter names are suffixed per branch so the FULLTEXT and vector predicates can share a
    single statement without colliding on ``tag_keys`` / ``tag_hashes`` / ``tag_minimum``.
    """

    tags = f"tags_{suffix}"
    return f"""
  AND (SELECT COUNT(*) FROM pc_artifact_tags AS {tags}
       WHERE {tags}.scope_id = {alias}.scope_id
         AND {tags}.family = 'memory'
         AND {tags}.artifact_id = {alias}.memory_artifact_id
         AND {tags}.target_type = 'memory_entry'
         AND {tags}.target_id = {alias}.entry_id
         AND {tags}.tag_key_hash IN :tag_hashes_{suffix}
         AND {tags}.tag_key IN :tag_keys_{suffix}) >= :tag_minimum_{suffix}
"""


_OCEANBASE_HYBRID_SELECT_COLUMNS = """
    {channel} AS matched_by,
    {alias}.memory_artifact_id AS memory_artifact_id,
    {alias}.head_revision AS head_revision,
    {alias}.entry_id AS entry_id,
    {alias}.entry_version_id AS entry_version_id,
    v.text AS text
"""

_OCEANBASE_HYBRID_FROM = """
FROM {table} AS {alias}
JOIN pc_memory_entry_versions AS v
  ON v.scope_id = {alias}.scope_id
 AND v.memory_artifact_id = {alias}.memory_artifact_id
 AND v.entry_version_id = {alias}.entry_version_id
WHERE {alias}.scope_id = :scope_id
  AND {alias}.memory_artifact_id IN :{artifacts}
"""

# One seekdb statement returns both the FULLTEXT and the vector candidate channels. Each
# branch keeps its own native index and ORDER BY ... LIMIT, so the application still fuses
# two identically ordered candidate lists; the only change is that they arrive together.
_OCEANBASE_HYBRID_SEARCH_SQL = (
    "("
    + "SELECT"
    + _OCEANBASE_HYBRID_SELECT_COLUMNS.format(channel="'fts'", alias="h")
    + ",\n    NULL AS distance\n"
    + _OCEANBASE_HYBRID_FROM.format(
        table=_OCEANBASE_FTS_TABLE_NAME, alias="h", artifacts="memory_artifact_ids_fts"
    )
    + "  AND MATCH(h.searchable_text) AGAINST (:fts_query)\n"
    + "ORDER BY MATCH(h.searchable_text) AGAINST (:fts_query) DESC,\n"
    + "         h.memory_artifact_id, h.entry_id, h.entry_version_id\n"
    + "LIMIT :candidate_limit\n"
    + ")\nUNION ALL\n(\n"
    + "SELECT"
    + _OCEANBASE_HYBRID_SELECT_COLUMNS.format(channel="'vector'", alias="m")
    + ",\n    l2_distance(m.embedding, :query_vector) AS distance\n"
    + _OCEANBASE_HYBRID_FROM.format(
        table=_OCEANBASE_VECTOR_TABLE_NAME, alias="m", artifacts="memory_artifact_ids_vec"
    )
    + "ORDER BY l2_distance(m.embedding, :query_vector) APPROXIMATE\n"
    + "LIMIT :candidate_limit\n"
    + ")"
)

_OCEANBASE_HYBRID_TAGGED_SEARCH_SQL = (
    "("
    + "SELECT"
    + _OCEANBASE_HYBRID_SELECT_COLUMNS.format(channel="'fts'", alias="h")
    + ",\n    NULL AS distance\n"
    + _OCEANBASE_HYBRID_FROM.format(
        table=_OCEANBASE_FTS_TABLE_NAME, alias="h", artifacts="memory_artifact_ids_fts"
    )
    + _hybrid_tag_predicate("h", "fts")
    + "  AND MATCH(h.searchable_text) AGAINST (:fts_query)\n"
    + "ORDER BY MATCH(h.searchable_text) AGAINST (:fts_query) DESC,\n"
    + "         h.memory_artifact_id, h.entry_id, h.entry_version_id\n"
    + "LIMIT :candidate_limit\n"
    + ")\nUNION ALL\n(\n"
    + "SELECT"
    + _OCEANBASE_HYBRID_SELECT_COLUMNS.format(channel="'vector'", alias="m")
    + ",\n    l2_distance(m.embedding, :query_vector) AS distance\n"
    + _OCEANBASE_HYBRID_FROM.format(
        table=_OCEANBASE_VECTOR_TABLE_NAME, alias="m", artifacts="memory_artifact_ids_vec"
    )
    + _hybrid_tag_predicate("m", "vec")
    + "ORDER BY l2_distance(m.embedding, :query_vector)\n"
    + "LIMIT :candidate_limit\n"
    + ")"
)


class OceanBaseMemoryFTSIndex:
    """OceanBase FULLTEXT strategy over the relational active-head projection."""

    capabilities = MemoryCapabilities(fts=True, tag_filter=True)
    tables: tuple[Table, ...] = ()

    async def initialize(self, connection: AsyncConnection, /) -> None:
        if connection.dialect.name != "mysql":
            raise CapabilityNotSupportedError("oceanbase-fts")
        count = await connection.scalar(
            _OCEANBASE_FTS_INDEX_EXISTS_SQL,
            {"index_name": _OCEANBASE_FTS_INDEX_NAME},
        )
        if count == 0:
            await connection.exec_driver_sql(_OCEANBASE_CREATE_FTS_SQL)
        probe = match(MEMORY_ENTRY_HEADS_TABLE.c.searchable_text, against="powercontext")
        await connection.execute(select(MEMORY_ENTRY_HEADS_TABLE.c.entry_version_id).where(probe).limit(1))

    async def replace(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> None:
        del connection, scope_id, memory_ref, projections

    async def delete(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        entry_ids: tuple[str, ...],
        /,
    ) -> None:
        del connection, scope_id, memory_ref, entry_ids

    async def upsert(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> None:
        del connection, scope_id, memory_ref, projections

    async def search(
        self,
        connection: AsyncConnection,
        scope_id: str,
        request: MemorySearchRequest,
        /,
    ) -> MemorySearchChannels:
        if request.mode not in {"fts", "hybrid"}:
            return MemorySearchChannels()
        score = match(MEMORY_ENTRY_HEADS_TABLE.c.searchable_text, against=request.analyzed_query)
        rows = (
            await connection.execute(
                select(
                    MEMORY_ENTRY_HEADS_TABLE.c.memory_artifact_id,
                    MEMORY_ENTRY_HEADS_TABLE.c.head_revision,
                    MEMORY_ENTRY_HEADS_TABLE.c.entry_id,
                    MEMORY_ENTRY_HEADS_TABLE.c.entry_version_id,
                    MEMORY_ENTRY_VERSIONS_TABLE.c.text,
                )
                .join(
                    MEMORY_ENTRY_VERSIONS_TABLE,
                    (MEMORY_ENTRY_VERSIONS_TABLE.c.scope_id == MEMORY_ENTRY_HEADS_TABLE.c.scope_id)
                    & (
                        MEMORY_ENTRY_VERSIONS_TABLE.c.memory_artifact_id
                        == MEMORY_ENTRY_HEADS_TABLE.c.memory_artifact_id
                    )
                    & (MEMORY_ENTRY_VERSIONS_TABLE.c.entry_version_id == MEMORY_ENTRY_HEADS_TABLE.c.entry_version_id),
                )
                .where(
                    MEMORY_ENTRY_HEADS_TABLE.c.scope_id == scope_id,
                    MEMORY_ENTRY_HEADS_TABLE.c.memory_artifact_id.in_(
                        tuple(memory.artifact_id for memory in request.memories)
                    ),
                    score,
                    *(
                        ()
                        if request.tag_filter is None
                        else (
                            tag_predicate(
                                scope_id,
                                "memory",
                                MEMORY_ENTRY_HEADS_TABLE.c.memory_artifact_id,
                                "memory_entry",
                                MEMORY_ENTRY_HEADS_TABLE.c.entry_id,
                                request.tag_filter,
                            ),
                        )
                    ),
                )
                .order_by(
                    score.desc(),
                    MEMORY_ENTRY_HEADS_TABLE.c.memory_artifact_id,
                    MEMORY_ENTRY_HEADS_TABLE.c.entry_id,
                    MEMORY_ENTRY_HEADS_TABLE.c.entry_version_id,
                )
                .limit(request.candidate_limit)
            )
        ).mappings()
        return MemorySearchChannels(fts=memory_channel_hits(rows, request.memories))

    async def vector_complete(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memories: tuple[ArtifactRef, ...],
        profile: EmbeddingProfile,
        /,
    ) -> bool:
        del connection, scope_id, memories, profile
        return False

    async def hydrate(
        self,
        connection: AsyncConnection,
        scope_id: str,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> tuple[MemoryProjection, ...]:
        del connection, scope_id
        return projections


class OceanBaseMemoryVectorIndex:
    """OceanBase HNSW strategy over rebuildable active-head embeddings."""

    def __init__(self, profile: EmbeddingProfile) -> None:
        if profile.dimension < 1 or profile.distance != "l2" or profile.normalization != "unit":
            raise CapabilityNotSupportedError(
                "vector",
                "OceanBase requires a positive unit-normalized L2 embedding profile",
            )
        self.profile = profile
        self.capabilities = MemoryCapabilities(
            tag_filter=True,
            fts=False,
            vector=True,
            embedding_profile=profile,
        )
        metadata = MetaData()
        self.table = Table(
            _OCEANBASE_VECTOR_TABLE_NAME,
            metadata,
            Column("vector_id", BigInteger, primary_key=True, autoincrement=True),
            Column("scope_id", identity_string(MAX_SCOPE_ID_LENGTH), nullable=False),
            Column("memory_artifact_id", identity_string(MAX_ARTIFACT_ID_LENGTH), nullable=False),
            Column("head_revision", BigInteger, nullable=False),
            Column("entry_id", identity_string(MAX_MEMORY_ENTRY_ID_LENGTH), nullable=False),
            Column("entry_version_id", identity_string(MAX_MEMORY_ENTRY_ID_LENGTH), nullable=False),
            Column("entry_content_hash", identity_string(MAX_MEMORY_HASH_LENGTH), nullable=False),
            Column("embedding_content_hash", identity_string(MAX_MEMORY_HASH_LENGTH), nullable=False),
            Column("embedding", VECTOR(profile.dimension), nullable=False),
            UniqueConstraint(
                "scope_id",
                "memory_artifact_id",
                "entry_id",
                name="uq_pc_memory_vector_entries_head",
            ),
        )
        self.tables: tuple[Table, ...] = (self.table,)
        self._vector_index = VectorIndex(
            _OCEANBASE_VECTOR_INDEX_NAME,
            self.table.c.embedding,
            params="distance=l2,type=hnsw",
        )
        self._search_sql = text(_OCEANBASE_VECTOR_SEARCH_SQL).bindparams(
            bindparam("memory_artifact_ids", expanding=True),
            bindparam("query_vector", type_=VECTOR(profile.dimension)),
        )
        self._tagged_search_sql = text(
            _OCEANBASE_VECTOR_SEARCH_SQL.replace("ORDER BY", memory_tag_sql("m") + "ORDER BY").replace(
                " APPROXIMATE", ""
            )
        ).bindparams(
            bindparam("memory_artifact_ids", expanding=True),
            bindparam("tag_keys", expanding=True),
            bindparam("tag_hashes", expanding=True),
            bindparam("query_vector", type_=VECTOR(profile.dimension)),
        )

    async def initialize(self, connection: AsyncConnection, /) -> None:
        if connection.dialect.name != "mysql":
            raise CapabilityNotSupportedError("oceanbase-vector")
        column_type = await connection.scalar(
            _OCEANBASE_VECTOR_TYPE_SQL,
            {"table_name": _OCEANBASE_VECTOR_TABLE_NAME},
        )
        expected = f"VECTOR({self.profile.dimension})"
        if str(column_type).upper() != expected:
            raise CapabilityNotSupportedError(
                "vector",
                f"OceanBase projection uses {column_type!r}; expected {expected}",
            )
        await connection.run_sync(lambda sync_connection: self._vector_index.create(sync_connection, checkfirst=True))

    async def replace(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> None:
        await connection.execute(
            delete(self.table).where(
                self.table.c.scope_id == scope_id,
                self.table.c.memory_artifact_id == memory_ref.artifact_id,
            )
        )
        await self.upsert(connection, scope_id, memory_ref, projections)

    async def delete(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        entry_ids: tuple[str, ...],
        /,
    ) -> None:
        if not entry_ids:
            return
        await connection.execute(
            delete(self.table).where(
                self.table.c.scope_id == scope_id,
                self.table.c.memory_artifact_id == memory_ref.artifact_id,
                self.table.c.entry_id.in_(entry_ids),
            )
        )

    async def upsert(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> None:
        values = []
        for projection in projections:
            if projection.embedding is None or projection.embedding_content_hash is None:
                continue
            entry = projection.entry_version
            values.append({
                "scope_id": scope_id,
                "memory_artifact_id": memory_ref.artifact_id,
                "head_revision": memory_ref.revision,
                "entry_id": entry.entry_id,
                "entry_version_id": entry.entry_version_id,
                "entry_content_hash": entry.entry_content_hash,
                "embedding_content_hash": projection.embedding_content_hash,
                "embedding": validate_embedding(
                    projection.embedding,
                    dimension=self.profile.dimension,
                ),
            })
        if values:
            await connection.execute(insert(self.table), values)

    async def search(
        self,
        connection: AsyncConnection,
        scope_id: str,
        request: MemorySearchRequest,
        /,
    ) -> MemorySearchChannels:
        if request.mode not in {"vector", "hybrid"}:
            return MemorySearchChannels()
        if request.embedding_profile != self.profile or request.query_vector is None:
            raise CapabilityNotSupportedError("embedding-profile")
        if not await self.vector_complete(connection, scope_id, request.memories, self.profile):
            raise CapabilityNotSupportedError("vector")
        rows = (
            await connection.execute(
                self._search_sql if request.tag_filter is None else self._tagged_search_sql,
                {
                    "scope_id": scope_id,
                    "memory_artifact_ids": tuple(memory.artifact_id for memory in request.memories),
                    "query_vector": validate_embedding(
                        request.query_vector,
                        dimension=self.profile.dimension,
                    ),
                    "candidate_limit": request.candidate_limit,
                    **memory_tag_parameters(request.tag_filter),
                },
            )
        ).mappings()
        return MemorySearchChannels(vector=memory_channel_hits(rows, request.memories))

    async def vector_complete(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memories: tuple[ArtifactRef, ...],
        profile: EmbeddingProfile,
        /,
    ) -> bool:
        if profile != self.profile:
            return False
        for memory in memories:
            current = await connection.scalar(
                select(ARTIFACT_HEADS_TABLE.c.revision).where(
                    ARTIFACT_HEADS_TABLE.c.scope_id == scope_id,
                    ARTIFACT_HEADS_TABLE.c.family == "memory",
                    ARTIFACT_HEADS_TABLE.c.artifact_id == memory.artifact_id,
                )
            )
            if current is None or int(current) != memory.revision:
                # The caller validated this head before the search. If it moved while
                # this query ran, report a stale head so the runtime can retry with it.
                raise CapabilityNotSupportedError("head")
            heads = (
                await connection.execute(
                    select(
                        MEMORY_ENTRY_HEADS_TABLE.c.entry_id,
                        MEMORY_ENTRY_HEADS_TABLE.c.entry_version_id,
                        MEMORY_ENTRY_HEADS_TABLE.c.entry_content_hash,
                    ).where(
                        MEMORY_ENTRY_HEADS_TABLE.c.scope_id == scope_id,
                        MEMORY_ENTRY_HEADS_TABLE.c.memory_artifact_id == memory.artifact_id,
                    )
                )
            ).all()
            metadata = (
                await connection.execute(
                    select(
                        self.table.c.entry_id,
                        self.table.c.entry_version_id,
                        self.table.c.entry_content_hash,
                        self.table.c.embedding_content_hash,
                    ).where(
                        self.table.c.scope_id == scope_id,
                        self.table.c.memory_artifact_id == memory.artifact_id,
                    )
                )
            ).all()
            expected = {(str(row[0]), str(row[1]), str(row[2])) for row in heads}
            actual = {(str(row[0]), str(row[1]), str(row[2])) for row in metadata}
            if actual != expected:
                return False
            if any(str(row[3]) != _embedding_hash(self.profile, str(row[2])) for row in metadata):
                return False
        return True

    async def hydrate(
        self,
        connection: AsyncConnection,
        scope_id: str,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> tuple[MemoryProjection, ...]:
        hydrated: list[MemoryProjection] = []
        for projection in projections:
            entry = projection.entry_version
            row = (
                await connection.execute(
                    select(
                        self.table.c.entry_content_hash,
                        self.table.c.embedding_content_hash,
                        self.table.c.embedding,
                    ).where(
                        self.table.c.scope_id == scope_id,
                        self.table.c.memory_artifact_id == entry.memory_artifact_id,
                        self.table.c.entry_id == entry.entry_id,
                        self.table.c.entry_version_id == entry.entry_version_id,
                    )
                )
            ).one_or_none()
            if (
                row is None
                or str(row[0]) != entry.entry_content_hash
                or str(row[1]) != _embedding_hash(self.profile, entry.entry_content_hash)
            ):
                hydrated.append(projection)
                continue
            embedding = validate_embedding(
                tuple(float(value) for value in row[2]),
                dimension=self.profile.dimension,
            )
            hydrated.append(
                MemoryProjection(
                    entry_version=entry,
                    searchable_text=projection.searchable_text,
                    embedding=embedding,
                    embedding_content_hash=str(row[1]),
                )
            )
        return tuple(hydrated)


def _embedding_hash(profile: EmbeddingProfile, entry_hash: str) -> str:
    return embedding_content_hash(
        profile_id=profile.profile_id,
        model=profile.model,
        dimension=profile.dimension,
        distance=profile.distance,
        normalization=profile.normalization,
        entry_content_hash=entry_hash,
    )


class OceanBaseMemoryHybridIndex:
    """FULLTEXT and vector candidates from one seekdb statement in ``hybrid`` mode.

    The two single-channel queries keep their own native plan and ordering; only the hybrid
    mode is answered by a single ``UNION ALL`` statement whose branches reuse the exact same
    FULLTEXT and vector indexes. The application still fuses two ordered candidate lists, so
    quality and tie handling are unchanged while the candidate round costs one round trip.
    """

    def __init__(self, profile: EmbeddingProfile) -> None:
        self.profile = profile
        self._fts = OceanBaseMemoryFTSIndex()
        self._vector = OceanBaseMemoryVectorIndex(profile)
        self.capabilities = MemoryCapabilities(
            fts=True,
            vector=True,
            hybrid=True,
            tag_filter=True,
            embedding_profile=profile,
        )
        self.tables = self._fts.tables + self._vector.tables
        self._search_sql = text(_OCEANBASE_HYBRID_SEARCH_SQL).bindparams(
            bindparam("memory_artifact_ids_fts", expanding=True),
            bindparam("memory_artifact_ids_vec", expanding=True),
            bindparam("query_vector", type_=VECTOR(profile.dimension)),
        )
        self._tagged_search_sql = text(_OCEANBASE_HYBRID_TAGGED_SEARCH_SQL).bindparams(
            bindparam("memory_artifact_ids_fts", expanding=True),
            bindparam("memory_artifact_ids_vec", expanding=True),
            bindparam("tag_keys_fts", expanding=True),
            bindparam("tag_hashes_fts", expanding=True),
            bindparam("tag_keys_vec", expanding=True),
            bindparam("tag_hashes_vec", expanding=True),
            bindparam("query_vector", type_=VECTOR(profile.dimension)),
        )

    async def initialize(self, connection: AsyncConnection, /) -> None:
        await self._fts.initialize(connection)
        await self._vector.initialize(connection)

    async def replace(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> None:
        await self._fts.replace(connection, scope_id, memory_ref, projections)
        await self._vector.replace(connection, scope_id, memory_ref, projections)

    async def delete(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        entry_ids: tuple[str, ...],
        /,
    ) -> None:
        await self._fts.delete(connection, scope_id, memory_ref, entry_ids)
        await self._vector.delete(connection, scope_id, memory_ref, entry_ids)

    async def upsert(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memory_ref: ArtifactRef,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> None:
        await self._fts.upsert(connection, scope_id, memory_ref, projections)
        await self._vector.upsert(connection, scope_id, memory_ref, projections)

    async def vector_complete(
        self,
        connection: AsyncConnection,
        scope_id: str,
        memories: tuple[ArtifactRef, ...],
        profile: EmbeddingProfile,
        /,
    ) -> bool:
        return await self._vector.vector_complete(connection, scope_id, memories, profile)

    async def hydrate(
        self,
        connection: AsyncConnection,
        scope_id: str,
        projections: tuple[MemoryProjection, ...],
        /,
    ) -> tuple[MemoryProjection, ...]:
        return await self._vector.hydrate(connection, scope_id, projections)

    async def search(
        self,
        connection: AsyncConnection,
        scope_id: str,
        request: MemorySearchRequest,
        /,
    ) -> MemorySearchChannels:
        if request.mode == "fts":
            return await self._fts.search(connection, scope_id, request)
        if request.mode == "vector":
            return await self._vector.search(connection, scope_id, request)
        if request.mode != "hybrid":
            return MemorySearchChannels()
        if request.embedding_profile != self.profile or request.query_vector is None:
            raise CapabilityNotSupportedError("embedding-profile")
        if not await self._vector.vector_complete(connection, scope_id, request.memories, self.profile):
            raise CapabilityNotSupportedError("vector")
        artifact_ids = tuple(memory.artifact_id for memory in request.memories)
        rows = (
            await connection.execute(
                self._tagged_search_sql if request.tag_filter is not None else self._search_sql,
                {
                    "scope_id": scope_id,
                    "memory_artifact_ids_fts": artifact_ids,
                    "memory_artifact_ids_vec": artifact_ids,
                    "fts_query": request.analyzed_query,
                    "query_vector": validate_embedding(
                        request.query_vector,
                        dimension=self.profile.dimension,
                    ),
                    "candidate_limit": request.candidate_limit,
                    **_hybrid_tag_parameters(request.tag_filter),
                },
            )
        ).mappings()
        fts: list[Mapping[str, object]] = []
        vector: list[Mapping[str, object]] = []
        for row in rows:
            (fts if str(row["matched_by"]) == "fts" else vector).append(row)
        return MemorySearchChannels(
            fts=memory_channel_hits(fts, request.memories),
            vector=memory_channel_hits(vector, request.memories),
        )


def _hybrid_tag_parameters(tag_filter: TagFilter | None) -> dict[str, object]:
    base = memory_tag_parameters(tag_filter)
    if not base:
        return {}
    return {
        "tag_keys_fts": base["tag_keys"],
        "tag_hashes_fts": base["tag_hashes"],
        "tag_minimum_fts": base["tag_minimum"],
        "tag_keys_vec": base["tag_keys"],
        "tag_hashes_vec": base["tag_hashes"],
        "tag_minimum_vec": base["tag_minimum"],
    }
