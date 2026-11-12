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

"""Share embedding work between concurrent callers and reuse cached vectors.

Callers that ask for the same text at the same time should not pay for it more
than once, so requests inside one coalescing window are deduplicated, split into
bounded provider batches and served from a single in-flight future per batch.  A
small LRU keeps successful vectors for later calls.  Waiters stay independent:
cancelling one caller never cancels the provider work the others are waiting on.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from typing import Any

from powercontext.builtin.inference.models import EmbeddingResult, InferenceUsage


class _Batch:
    """One underlying provider request and the waiters that share it."""

    __slots__ = ("future", "texts", "usage")

    def __init__(self, texts: tuple[str, ...], future: asyncio.Future[dict[str, tuple[float, ...]]]) -> None:
        self.texts = texts
        self.future = future
        self.usage: InferenceUsage | None = None


class _Window:
    """Texts gathered while one coalescing window stays open."""

    __slots__ = ("batches", "closed", "texts")

    def __init__(self) -> None:
        self.texts: dict[str, None] = {}
        self.batches: tuple[_Batch, ...] = ()
        self.closed = asyncio.Event()


class CoalescingEmbeddingModel:
    """Wrap an embedding model with cross-call coalescing and an LRU cache."""

    def __init__(
        self,
        model: Any,
        *,
        max_batch_size: int = 64,
        coalesce_ms: float = 5.0,
        cache_size: int = 1024,
    ) -> None:
        if type(max_batch_size) is not int or max_batch_size < 1:
            raise ValueError("max_batch_size must be a positive integer")  # noqa: TRY003
        if type(cache_size) is not int or cache_size < 0:
            raise ValueError("cache_size must be a non-negative integer")  # noqa: TRY003
        if isinstance(coalesce_ms, bool) or not isinstance(coalesce_ms, (int, float)) or coalesce_ms < 0:
            raise ValueError("coalesce_ms must be a non-negative number")  # noqa: TRY003
        self._model = model
        self.profile = model.profile
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = float(coalesce_ms) / 1000.0
        self._cache_size = cache_size
        self._cache: OrderedDict[str, tuple[float, ...]] = OrderedDict()
        self._inflight: dict[str, _Batch] = {}
        self._window: _Window | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    async def embed(self, texts: Any) -> EmbeddingResult:
        """Embed one caller's texts, reusing shared and cached vectors."""

        requested = tuple(texts)
        if not requested:
            return EmbeddingResult(vectors=(), usage=InferenceUsage(requests=0))

        vectors: dict[str, tuple[float, ...]] = {}
        misses: list[str] = []
        for text in dict.fromkeys(requested):
            cached = self._cache.get(text)
            if cached is None:
                misses.append(text)
            else:
                self._cache.move_to_end(text)
                vectors[text] = cached

        shared: dict[_Batch, None] = {}
        if misses:
            assigned = await self._assign(misses)
            shared = dict.fromkeys(assigned.values())
            outcomes = await asyncio.gather(
                *(asyncio.shield(batch.future) for batch in shared),
                return_exceptions=True,
            )
            failure: BaseException | None = None
            for batch, outcome in zip(shared, outcomes, strict=True):
                if isinstance(outcome, BaseException):
                    failure = failure or outcome
                    continue
                vectors.update(outcome)
            if failure is not None:
                raise failure

        return EmbeddingResult(
            vectors=tuple(vectors[text] for text in requested),
            usage=_aggregate_usage(shared),
        )

    async def _assign(self, misses: list[str]) -> dict[str, _Batch]:
        """Return the batch each of this caller's texts must wait on."""

        assigned: dict[str, _Batch] = {}
        fresh: list[str] = []
        for text in misses:
            batch = self._inflight.get(text)
            if batch is None:
                fresh.append(text)
            else:
                assigned[text] = batch
        if not fresh:
            return assigned

        if self._coalesce_seconds > 0:
            window = self._open_window()
            for text in fresh:
                window.texts.setdefault(text, None)
            await window.closed.wait()
            mapping = {text: batch for batch in window.batches for text in batch.texts}
            for text in fresh:
                assigned[text] = mapping[text]
            return assigned

        for batch in self._start_batches(fresh):
            for text in batch.texts:
                assigned[text] = batch
        return assigned

    def _open_window(self) -> _Window:
        window = self._window
        if window is None:
            window = _Window()
            self._window = window
            self._track(asyncio.get_running_loop().create_task(self._close_window(window)))
        return window

    async def _close_window(self, window: _Window) -> None:
        await asyncio.sleep(self._coalesce_seconds)
        self._window = None
        window.batches = tuple(self._start_batches(list(window.texts)))
        window.closed.set()

    def _start_batches(self, texts: list[str]) -> tuple[_Batch, ...]:
        loop = asyncio.get_running_loop()
        batches: list[_Batch] = []
        for start in range(0, len(texts), self._max_batch_size):
            chunk = tuple(texts[start : start + self._max_batch_size])
            batch = _Batch(chunk, loop.create_future())
            batch.future.add_done_callback(_consume)
            for text in chunk:
                self._inflight[text] = batch
            self._track(loop.create_task(self._run_batch(batch)))
            batches.append(batch)
        return tuple(batches)

    async def _run_batch(self, batch: _Batch) -> None:
        try:
            result = await self._model.embed(batch.texts)
        except Exception as error:  # noqa: BLE001 - forwarded verbatim to every waiter
            self._release(batch)
            if not batch.future.done():
                batch.future.set_exception(error)
            return

        vector_values = tuple(result.vectors)
        if len(vector_values) != len(batch.texts):
            self._release(batch)
            if not batch.future.done():
                batch.future.set_exception(
                    ValueError("embedding model returned the wrong number of vectors")
                )
            return

        mapping = dict(zip(batch.texts, vector_values, strict=True))
        if self._cache_size > 0:
            for text, vector in mapping.items():
                self._cache[text] = vector
                self._cache.move_to_end(text)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        batch.usage = result.usage
        self._release(batch)
        if not batch.future.done():
            batch.future.set_result(mapping)

    def _release(self, batch: _Batch) -> None:
        for text in batch.texts:
            if self._inflight.get(text) is batch:
                del self._inflight[text]

    def _track(self, task: asyncio.Task[Any]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


def _consume(future: asyncio.Future[Any]) -> None:
    """Mark a finished future's outcome as observed for every waiter shape."""

    if not future.cancelled():
        future.exception()


def _aggregate_usage(batches: dict[_Batch, None]) -> InferenceUsage:
    requests = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    for batch in batches:
        usage = batch.usage
        if usage is None:
            continue
        requests += usage.requests
        if usage.input_tokens is not None:
            input_tokens = (input_tokens or 0) + usage.input_tokens
        if usage.output_tokens is not None:
            output_tokens = (output_tokens or 0) + usage.output_tokens
    return InferenceUsage(requests=requests, input_tokens=input_tokens, output_tokens=output_tokens)


__all__ = ["CoalescingEmbeddingModel"]
