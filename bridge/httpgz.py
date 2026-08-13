"""Gzip large JSON bodies. The 2608-event transcript is 1.7 MB of JSON that
compresses 4.5x; below ~32 KB the CPU spent compressing outweighs the transfer
saved, so small responses pass through untouched. Stdlib only."""

import gzip

THRESHOLD = 32 * 1024


def maybe_gzip(raw: bytes, accept_encoding) -> tuple[bytes, bool]:
    """(body, gzipped). Gzips only when the client accepts it and it pays."""
    if len(raw) <= THRESHOLD or "gzip" not in (accept_encoding or "").lower():
        return raw, False
    return gzip.compress(raw, compresslevel=5), True
