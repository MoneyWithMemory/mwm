"""
Unit tests for the negotiation queue: arrival order, one negotiation at a time, positions.
"""

import threading
import time

from backend.negotiation_queue import NegotiationQueue


def _wait_for(condition, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met in time")


def test_queue_runs_in_arrival_order_one_at_a_time():
    started = []
    release = {sid: threading.Event() for sid in ("a", "b", "c")}

    def runner(sid):
        started.append(sid)
        release[sid].wait(5)

    queue = NegotiationQueue(runner, concurrency=1)
    for sid in ("a", "b", "c"):
        queue.submit(sid)

    _wait_for(lambda: started == ["a"])
    assert queue.snapshot() == {"running": ["a"], "waiting": ["b", "c"]}
    assert (queue.position("a"), queue.position("b"), queue.position("c")) == (None, 1, 2)

    release["a"].set()
    _wait_for(lambda: started == ["a", "b"])
    assert queue.position("c") == 1

    release["b"].set()
    release["c"].set()
    _wait_for(lambda: queue.snapshot() == {"running": [], "waiting": []})
    assert started == ["a", "b", "c"]


def test_queue_keeps_going_after_a_crashing_negotiation():
    done = threading.Event()

    def runner(sid):
        if sid == "boom":
            raise RuntimeError("agent crashed")
        done.set()

    queue = NegotiationQueue(runner, concurrency=1)
    queue.submit("boom")
    queue.submit("ok")
    assert done.wait(5)


def test_cancelled_waiting_negotiation_leaves_the_queue():
    release = threading.Event()
    started = []

    def runner(sid):
        started.append(sid)
        release.wait(5)

    queue = NegotiationQueue(runner, concurrency=1)
    for sid in ("a", "b", "c"):
        queue.submit(sid)
    _wait_for(lambda: started == ["a"])
    queue.discard("b")
    assert queue.snapshot() == {"running": ["a"], "waiting": ["c"]}
    assert queue.position("c") == 1
    release.set()
    _wait_for(lambda: queue.snapshot() == {"running": [], "waiting": []})
    assert started == ["a", "c"]
