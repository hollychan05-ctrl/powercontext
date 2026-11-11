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

"""Row-level Source for offline CSV documents.

Each data row becomes one captured Source identified by the document and the
row's primary-key value, so a retrieval citation can be traced back to the
complete original record even after the file is reordered or the process
restarts.  Field values, column order and surrounding whitespace are preserved
verbatim: this is evidence, not typed data.
"""

from __future__ import annotations

import csv
import io
import json
from urllib.parse import quote

from pydantic import BaseModel, field_validator

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

CSV_ROW_SOURCE_NAME = "csv-row"
_IDENTITY_PREFIX = "csv"


class CSVDocumentInput(BaseModel):
    """One complete offline CSV document plus the column that identifies a row."""

    document_id: str
    primary_key: str
    content: bytes

    @field_validator("document_id")
    @classmethod
    def require_canonical_document_id(cls, value: str) -> str:
        if not value or value != value.strip():
            raise ValueError("document_id must be a non-empty string without surrounding whitespace")  # noqa: TRY003
        return value

    @field_validator("primary_key")
    @classmethod
    def require_primary_key(cls, value: str) -> str:
        if not value:
            raise ValueError("primary_key must not be empty")  # noqa: TRY003
        return value


class CSVRowInput(BaseModel):
    """Adapter-native input describing exactly one CSV data row."""

    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


class CSVRowSource(Source):
    """Captured CSV row that can be cited back to its original record."""

    source_id: str
    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


def csv_row_source_id(document_id: str, primary_key_value: str, /) -> str:
    """Return the delimiter-safe, bounded identity of one row of one document."""

    if not document_id or document_id != document_id.strip():
        raise ValueError("document_id must be a non-empty string without surrounding whitespace")  # noqa: TRY003
    identity = f"{_IDENTITY_PREFIX}:{quote(document_id, safe='')}:{quote(primary_key_value, safe='')}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError("csv row identity must not exceed the Source identifier limit")  # noqa: TRY003
    return identity


def parse_csv_document(value: CSVDocumentInput, /) -> tuple[CSVRowInput, ...]:
    """Parse and validate a whole CSV document into row-level inputs.

    The document is validated in full before any row is returned; malformed
    quoting, encoding, headers, widths or primary keys raise ``ValueError``
    without producing partial results.
    """

    text = _decode(value.content)
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    try:
        records = list(reader)
    except csv.Error as error:
        raise ValueError(f"malformed CSV document: {error}") from error

    header = records[0] if records else []
    columns = _validate_header(header)
    primary_key_index = _primary_key_index(columns, value.primary_key)

    rows: list[CSVRowInput] = []
    seen: set[str] = set()
    for record in records[1:]:
        if not record:
            # A completely blank physical line carries no record.
            continue
        if len(record) != len(columns):
            raise ValueError(  # noqa: TRY003
                f"record width {len(record)} does not match the header width {len(columns)}"
            )
        primary_key_value = record[primary_key_index]
        if not primary_key_value.strip():
            raise ValueError("primary key values must not be blank")  # noqa: TRY003
        if primary_key_value in seen:
            raise ValueError("primary key values must be unique within a document")  # noqa: TRY003
        seen.add(primary_key_value)
        rows.append(
            CSVRowInput(
                document_id=value.document_id,
                primary_key=value.primary_key,
                primary_key_value=primary_key_value,
                columns=columns,
                values=tuple(record),
            )
        )
    return tuple(rows)


def _decode(content: bytes) -> str:
    if not isinstance(content, bytes):
        raise TypeError("CSV content must be raw bytes")  # noqa: TRY003
    text = content.decode("utf-8")
    return text.removeprefix("\ufeff")


def _validate_header(header: list[str]) -> tuple[str, ...]:
    if not header:
        raise ValueError("a CSV document must start with a header record")  # noqa: TRY003
    seen: set[str] = set()
    for column in header:
        if not column or not column.strip():
            raise ValueError("header column names must be non-empty and not blank")  # noqa: TRY003
        if column in seen:
            raise ValueError("header column names must be unique")  # noqa: TRY003
        seen.add(column)
    return tuple(header)


def _primary_key_index(columns: tuple[str, ...], primary_key: str) -> int:
    try:
        return columns.index(primary_key)
    except ValueError:
        raise ValueError(f"primary_key {primary_key!r} is not a header column") from None  # noqa: TRY003


class CSVRowSourceAdapter:
    """Resolve and read the row-level CSV Source."""

    input_class = CSVRowInput
    name = CSV_ROW_SOURCE_NAME
    source_class = CSVRowSource

    async def resolve(self, value: CSVRowInput, /) -> CSVRowSource:
        identity = csv_row_source_id(value.document_id, value.primary_key_value)
        return CSVRowSource(
            name=identity,
            source_id=identity,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            primary_key=value.primary_key,
            primary_key_value=value.primary_key_value,
            columns=value.columns,
            values=value.values,
        )

    async def read(self, source: CSVRowSource, /) -> CSVRowInput:
        return CSVRowInput(
            document_id=source.document_id,
            primary_key=source.primary_key,
            primary_key_value=source.primary_key_value,
            columns=source.columns,
            values=source.values,
        )


class CSVRowTextEvidenceProjection:
    """Expose one row as canonical text evidence without losing its columns."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = CSVRowSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: CSVRowSource, /) -> TextEvidence:
        row = dict(zip(source.columns, source.values, strict=True))
        return TextEvidence(
            source_type=CSV_ROW_SOURCE_NAME,
            source_id=source.source_id,
            content=json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            metadata={
                "document_id": source.document_id,
                "primary_key": source.primary_key,
                "primary_key_value": source.primary_key_value,
                "columns": list(source.columns),
                "row": row,
            },
        )


CSV_ROW_SOURCE_ADAPTER = CSVRowSourceAdapter()
CSV_ROW_SOURCE_DEFINITION = AdapterSourceDefinition(
    CSV_ROW_SOURCE_ADAPTER,
    projections=(CSVRowTextEvidenceProjection(),),
)

__all__ = [
    "CSV_ROW_SOURCE_ADAPTER",
    "CSV_ROW_SOURCE_DEFINITION",
    "CSV_ROW_SOURCE_NAME",
    "CSVDocumentInput",
    "CSVRowInput",
    "CSVRowSource",
    "CSVRowSourceAdapter",
    "CSVRowTextEvidenceProjection",
    "csv_row_source_id",
    "parse_csv_document",
]
