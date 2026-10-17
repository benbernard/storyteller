"""Shared data contracts for local speech utilities."""

from __future__ import annotations
from typing import Protocol, TypedDict, Union, TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np
    import numpy.typing as npt
JsonValue = Union[
    None, bool, int, float, str, list["JsonValue"], dict[str, "JsonValue"]
]
JsonObject = dict[str, JsonValue]
if TYPE_CHECKING:
    FloatArray = npt.NDArray[np.float32]


class Reference(TypedDict):
    speaker: int
    reference_id: str
    transcript: str


class BookAPI(Protocol):
    def call(
        self,
        path: str,
        value: JsonValue = None,
        raw: bool = False,
    ) -> JsonValue | bytes: ...
    def wait(self, job: JsonObject) -> JsonObject: ...
