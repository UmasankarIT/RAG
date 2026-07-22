"""
ColPali / ColQwen2 embedding service.

The only Python in this project. It does one thing: bytes in, vectors out.
No database, no business logic. Deploy it, call it over HTTP, don't open it.

  POST /embed/pages   page images  -> coarse vector + quantized patch vectors
  POST /embed/query   query text   -> coarse vector + quantized token vectors

Patch vectors are binary-quantized here so they never cross the wire as
float32 (512 KB/page vs 16 KB/page). Scoring downstream is Hamming distance.
"""

from __future__ import annotations

import base64
import io
import os
from typing import List

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

MODEL_NAME = os.getenv("COLPALI_MODEL", "vidore/colqwen2-v1.0")
QUANTIZE = os.getenv("QUANTIZE", "true").lower() == "true"

app = FastAPI(title="colpali-embedder")

model = None
processor = None


def _dtype() -> torch.dtype:
    # bfloat16 needs Ampere or newer. Older CUDA (e.g. Turing/T4) uses float16.
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    if torch.cuda.is_available():
        return torch.float16
    return torch.float32


@app.on_event("startup")
def load_model() -> None:
    global model, processor

    if "colqwen" in MODEL_NAME.lower():
        from colpali_engine.models import ColQwen2, ColQwen2Processor

        model_cls, processor_cls = ColQwen2, ColQwen2Processor
    else:
        from colpali_engine.models import ColPali, ColPaliProcessor

        model_cls, processor_cls = ColPali, ColPaliProcessor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = model_cls.from_pretrained(
        MODEL_NAME, torch_dtype=_dtype(), device_map=device
    ).eval()
    processor = processor_cls.from_pretrained(MODEL_NAME)


class PagesRequest(BaseModel):
    """images: base64-encoded PNGs, one per page."""

    images: List[str]


class QueryRequest(BaseModel):
    queries: List[str]


class Embedding(BaseModel):
    """One page or one query."""

    # Mean-pooled over patches/tokens, L2-normalized. Stage 1 searches this.
    coarse: List[float]
    # Binary-quantized patch/token vectors, base64. Stage 2 scores these.
    patches_b64: str
    patch_count: int
    dim: int


def _quantize(vectors: np.ndarray) -> bytes:
    """
    (n_patches, dim) float -> packed bits, one bit per dimension.

    Sign-based: positive dimensions become 1, the rest 0. Costs some recall
    versus float32 and buys a 32x size reduction plus XOR/popcount scoring.
    """
    bits = (vectors > 0).astype(np.uint8)
    return np.packbits(bits, axis=-1).tobytes()


def _encode(vectors: np.ndarray) -> Embedding:
    """vectors: (n_patches, dim) for a single page/query."""
    coarse = vectors.mean(axis=0)
    norm = np.linalg.norm(coarse)
    if norm > 0:
        coarse = coarse / norm

    payload = _quantize(vectors) if QUANTIZE else vectors.astype(np.float32).tobytes()

    return Embedding(
        coarse=coarse.astype(np.float32).tolist(),
        patches_b64=base64.b64encode(payload).decode("ascii"),
        patch_count=int(vectors.shape[0]),
        dim=int(vectors.shape[1]),
    )


@torch.no_grad()
def _run(batch) -> np.ndarray:
    out = model(**batch)
    return out.to(torch.float32).cpu().numpy()


@app.post("/embed/pages", response_model=List[Embedding])
def embed_pages(req: PagesRequest) -> List[Embedding]:
    if not req.images:
        raise HTTPException(400, "images must not be empty")

    try:
        images = [
            Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
            for b64 in req.images
        ]
    except Exception as exc:
        raise HTTPException(400, f"could not decode images: {exc}") from exc

    batch = processor.process_images(images).to(model.device)
    embeddings = _run(batch)
    return [_encode(embeddings[i]) for i in range(embeddings.shape[0])]


@app.post("/embed/query", response_model=List[Embedding])
def embed_query(req: QueryRequest) -> List[Embedding]:
    if not req.queries:
        raise HTTPException(400, "queries must not be empty")

    batch = processor.process_queries(req.queries).to(model.device)
    embeddings = _run(batch)
    return [_encode(embeddings[i]) for i in range(embeddings.shape[0])]


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_NAME,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "quantized": QUANTIZE,
    }
