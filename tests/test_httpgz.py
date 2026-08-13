"""maybe_gzip: compress JSON bodies over the threshold for clients that accept it."""
import gzip

from bridge.httpgz import THRESHOLD, maybe_gzip

BIG = b'{"x": "' + b"a" * (64 * 1024) + b'"}'


def test_small_body_passes_through():
    body, zipped = maybe_gzip(b'{"ok": true}', "gzip")
    assert (body, zipped) == (b'{"ok": true}', False)


def test_big_body_gzips_when_accepted():
    body, zipped = maybe_gzip(BIG, "gzip, deflate, br")
    assert zipped and len(body) < len(BIG)
    assert gzip.decompress(body) == BIG


def test_big_body_plain_without_accept():
    body, zipped = maybe_gzip(BIG, "")
    assert (body, zipped) == (BIG, False)


def test_accept_header_is_case_insensitive():
    _, zipped = maybe_gzip(BIG, "GZip")
    assert zipped


def test_none_accept_header():
    body, zipped = maybe_gzip(BIG, None)
    assert (body, zipped) == (BIG, False)


def test_threshold_is_exclusive():
    at = b"a" * THRESHOLD
    _, zipped = maybe_gzip(at, "gzip")
    assert not zipped
