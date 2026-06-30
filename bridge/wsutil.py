"""Minimal server-side WebSocket framing (RFC 6455) for the dashboard terminal.

Stdlib only. Localhost, single-user, same trust boundary as the rest of the
dashboard — so this is deliberately minimal: server frames are sent unmasked,
client frames are always masked and unmasked here, and only unfragmented frames
are handled (terminal keystrokes + small control messages never fragment). The
HTTP Upgrade handshake itself is written by the dashboard Handler using
``accept_key``; this module only deals with the framing once the socket is hijacked.
"""

import base64
import hashlib
import struct

# RFC 6455 magic GUID appended to the client key before hashing.
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


def accept_key(client_key: str) -> str:
    """Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key."""
    digest = hashlib.sha1((client_key + _GUID).encode()).digest()
    return base64.b64encode(digest).decode()


def encode_frame(payload: bytes, opcode: int = OP_BINARY) -> bytes:
    """One final, unmasked server frame carrying ``payload``."""
    n = len(payload)
    header = bytearray([0x80 | opcode])
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload


def _read_exact(rfile, n: int) -> bytes | None:
    """Read exactly ``n`` bytes; None on EOF / short read (closed connection)."""
    if n == 0:
        return b""
    buf = bytearray()
    while len(buf) < n:
        chunk = rfile.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def decode_frame(rfile):
    """Read one client frame -> ``(opcode, payload)``; None on EOF.

    Payloads are unmasked (clients always mask). Control opcodes (close/ping) are
    returned as-is for the caller to handle.
    """
    head = _read_exact(rfile, 2)
    if head is None:
        return None
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        ext = _read_exact(rfile, 2)
        if ext is None:
            return None
        length = struct.unpack(">H", ext)[0]
    elif length == 127:
        ext = _read_exact(rfile, 8)
        if ext is None:
            return None
        length = struct.unpack(">Q", ext)[0]
    mask = b"\x00\x00\x00\x00"
    if masked:
        mask = _read_exact(rfile, 4)
        if mask is None:
            return None
    payload = _read_exact(rfile, length)
    if payload is None:
        return None
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload
