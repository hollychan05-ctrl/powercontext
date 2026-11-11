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

"""Physical-page Sources for local PDF documents.

Every physical page of the original file becomes one captured Source carrying the
page's extractable text, the digest of the exact bytes it came from and its
physical page number, so a retrieval hit can be traced back to the page of the
original document rather than to a printed page label.
"""

from __future__ import annotations

import hashlib
import io
from typing import TYPE_CHECKING
from urllib.parse import quote

from pydantic import BaseModel, field_validator

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

if TYPE_CHECKING:
    from powercontext.builtin.artifacts.memory.models import MemoryCitation

PDF_PAGE_SOURCE_NAME = "pdf-page"
_IDENTITY_PREFIX = "pdf"


class PDFDocumentInput(BaseModel):
    """One complete original PDF file plus the identity assigned by the caller."""

    document_id: str
    content: bytes

    @field_validator("document_id")
    @classmethod
    def require_document_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("document_id must not be blank")  # noqa: TRY003
        return value


class PDFPageInput(BaseModel):
    """Adapter-native input describing exactly one physical page."""

    document_id: str
    document_sha256: str
    page_number: int
    text: str


class PDFPageSource(Source):
    """Captured page of one exact revision of a PDF document."""

    source_id: str
    document_id: str
    document_sha256: str
    page_number: int
    text: str


def pdf_page_source_id(document_id: str, document_sha256: str, page_number: int, /) -> str:
    """Return the stable identity of one page of one document revision."""

    identity = f"{_IDENTITY_PREFIX}:{quote(document_id, safe='')}:{document_sha256}:{page_number}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError("pdf page identity must not exceed the Source identifier limit")  # noqa: TRY003
    return identity


def pdf_page_location(source_id: str, /) -> tuple[str, int] | None:
    """Recover ``(document_id, page_number)`` from an identity produced above."""

    parts = source_id.split(":")
    if len(parts) != 4 or parts[0] != _IDENTITY_PREFIX:
        return None
    document_id, _digest, page_number = parts[1], parts[2], parts[3]
    if not page_number.isdigit():
        return None
    return document_id, int(page_number)


def parse_pdf_document(value: PDFDocumentInput, /) -> tuple[PDFPageInput, ...]:
    """Extract every physical page of an original PDF, in order."""

    if not isinstance(value.content, bytes):
        raise TypeError("PDF content must be raw bytes")  # noqa: TRY003
    digest = hashlib.sha256(value.content).hexdigest()
    pages = _extract_pages(value.content)
    return tuple(
        PDFPageInput(
            document_id=value.document_id,
            document_sha256=digest,
            page_number=index,
            text=text,
        )
        for index, text in enumerate(pages, start=1)
    )


def _extract_pages(content: bytes) -> tuple[str, ...]:
    """Read all page texts, failing atomically on an unreadable document."""

    from pypdf import PdfReader

    if not content:
        raise ValueError("a PDF document must not be empty")  # noqa: TRY003
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(""):
            # An empty user password is the documented readable permission marker;
            # anything else needs a secret this offline parser does not have.
            raise ValueError("the PDF document requires a user password")  # noqa: TRY003
        return tuple(_page_text(page) for page in reader.pages)
    except ValueError:
        raise
    except Exception as error:  # noqa: BLE001 - every pypdf failure is invalid input here
        raise ValueError(f"unreadable PDF document: {error}") from error


def _page_text(page: object, /) -> str:
    text = page.extract_text()  # type: ignore[attr-defined]
    return text if isinstance(text, str) else ""


class PDFPageSourceAdapter:
    """Resolve and read the page-level PDF Source."""

    input_class = PDFPageInput
    name = PDF_PAGE_SOURCE_NAME
    source_class = PDFPageSource

    async def resolve(self, value: PDFPageInput, /) -> PDFPageSource:
        identity = pdf_page_source_id(value.document_id, value.document_sha256, value.page_number)
        return PDFPageSource(
            name=identity,
            source_id=identity,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            document_sha256=value.document_sha256,
            page_number=value.page_number,
            text=value.text,
        )

    async def read(self, source: PDFPageSource, /) -> PDFPageInput:
        return PDFPageInput(
            document_id=source.document_id,
            document_sha256=source.document_sha256,
            page_number=source.page_number,
            text=source.text,
        )


class PDFPageTextEvidenceProjection:
    """Expose one page's text with the identity needed to refind the file."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PDFPageSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PDF_PAGE_SOURCE_NAME,
            source_id=source.source_id,
            content=f"{source.document_id}\n{source.text}",
            metadata={
                "document_id": source.document_id,
                "document_sha256": source.document_sha256,
                "page_number": source.page_number,
            },
        )


PDF_PAGE_SOURCE_ADAPTER = PDFPageSourceAdapter()
PDF_PAGE_SOURCE_DEFINITION = AdapterSourceDefinition(
    PDF_PAGE_SOURCE_ADAPTER,
    projections=(PDFPageTextEvidenceProjection(),),
)


async def search_pdf_pages(memory, question: str, limit: int = 10) -> tuple[MemoryCitation, ...]:
    """Return up to ``limit`` citations, each pointing at a distinct page."""

    from powercontext.builtin.artifacts.memory.models import MemoryCitation
    from powercontext.builtin.runtime import GetMemoryEntryRequest, SearchMemoryRequest

    if limit < 1:
        raise ValueError("limit must be at least 1")  # noqa: TRY003

    # Ask for a far wider candidate pool than the number of pages to return: the
    # fused ranking can then be thinned down to distinct pages without losing
    # recall to repeated hits from the same page.
    pool = max(limit * 20, 200)
    page = await memory.search(SearchMemoryRequest(query=question, mode="fts", limit=pool))

    citations: list[MemoryCitation] = []
    seen: set[tuple[str, int]] = set()
    for hit in page.hits:
        citation = MemoryCitation(
            memory_ref=hit.memory_ref,
            entry_id=hit.entry_id,
            entry_version_id=hit.entry_version_id,
        )
        locations = _entry_locations(await memory.get(GetMemoryEntryRequest(citation=citation)))
        if len(locations) != 1:
            continue
        location = next(iter(locations))
        if location in seen:
            continue
        seen.add(location)
        citations.append(citation)
        if len(citations) >= limit:
            break
    return tuple(citations)


def _entry_locations(entry: object, /) -> set[tuple[str, int]]:
    """Collect the distinct pages referenced by one retrieved Memory entry."""

    locations: set[tuple[str, int]] = set()
    for reference in getattr(getattr(entry, "entry", entry), "sources", ()):
        if getattr(reference, "source_type", None) != PDF_PAGE_SOURCE_NAME:
            continue
        location = pdf_page_location(getattr(reference, "source_id", ""))
        if location is not None:
            locations.add(location)
    return locations


__all__ = [
    "PDF_PAGE_SOURCE_ADAPTER",
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDF_PAGE_SOURCE_NAME",
    "PDFDocumentInput",
    "PDFPageInput",
    "PDFPageSource",
    "PDFPageSourceAdapter",
    "PDFPageTextEvidenceProjection",
    "parse_pdf_document",
    "pdf_page_location",
    "pdf_page_source_id",
    "search_pdf_pages",
]
