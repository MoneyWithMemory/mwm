"""
MwM - Negotiation queue
QVAC serves one local model, so negotiations run in arrival order, at most `concurrency` at a time.
Waiting sessions stay NEGOTIATING with no rounds; position() tells the UI where they are in line.
"""

import logging
import threading
from typing import Callable, Dict, List, Optional

logger = logging.getLogger("mwm.queue")


class NegotiationQueue:
    def __init__(self, runner: Callable[[str], None], concurrency: int = 1) -> None:
        self._runner = runner
        self._concurrency = max(1, concurrency)
        self._cond = threading.Condition()
        self._waiting: List[str] = []
        self._running: List[str] = []
        self._dispatcher: Optional[threading.Thread] = None

    def submit(self, session_id: str) -> None:
        with self._cond:
            self._waiting.append(session_id)
            if self._dispatcher is None:
                self._dispatcher = threading.Thread(target=self._dispatch, name="negotiation-queue", daemon=True)
                self._dispatcher.start()
            self._cond.notify_all()
        logger.info(f"Negotiation {session_id} queued (position {self.position(session_id) or 'running'})")

    def discard(self, session_id: str) -> None:
        """Drop a waiting negotiation (e.g. cancelled before its turn); running ones finish their turn."""
        with self._cond:
            if session_id in self._waiting:
                self._waiting.remove(session_id)

    def position(self, session_id: str) -> Optional[int]:
        """1-based place among the waiting negotiations; None once running or not queued."""
        with self._cond:
            return self._waiting.index(session_id) + 1 if session_id in self._waiting else None

    def snapshot(self) -> Dict[str, List[str]]:
        with self._cond:
            return {"running": list(self._running), "waiting": list(self._waiting)}

    def _dispatch(self) -> None:
        while True:
            with self._cond:
                while not self._waiting or len(self._running) >= self._concurrency:
                    self._cond.wait()
                session_id = self._waiting.pop(0)
                self._running.append(session_id)
            threading.Thread(target=self._run, args=(session_id,), name=f"negotiation-{session_id}", daemon=True).start()

    def _run(self, session_id: str) -> None:
        try:
            self._runner(session_id)
        except Exception:
            logger.exception(f"Negotiation {session_id} crashed")
        finally:
            with self._cond:
                self._running.remove(session_id)
                self._cond.notify_all()
