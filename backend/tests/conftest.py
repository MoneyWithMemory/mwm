"""
Backend Test Isolation (pytest conftest)
Runs before any test module imports the backend: points MWM_DATA_DIR at a throwaway
directory that is deleted when the run ends, and defaults QVAC_MOCK=1, so the suite never
opens the real rgb-lib wallets under ~/.mwm/data and never calls a live QVAC endpoint.
Export QVAC_MOCK=0 to opt into live QVAC inference.
"""

import os
import sys
import atexit
import shutil
import tempfile

# backend.config reads the environment once, at import time, and importing backend.api_server
# opens the seed wallets under settings.MWM_DATA_DIR: isolation must happen before either.
if "backend.config" in sys.modules:
    raise RuntimeError(
        "backend.config was imported before backend/tests/conftest.py, so its settings are bound "
        "to the caller's MWM_DATA_DIR (default ~/.mwm/data) instead of an isolated test directory."
    )

TEST_DATA_DIR = tempfile.mkdtemp(prefix="mwm-tests-")
os.environ["MWM_DATA_DIR"] = TEST_DATA_DIR
# Deleted at interpreter exit rather than in pytest_unconfigure, which pytest skips when it
# stops before configuring (e.g. on an unknown command-line option).
atexit.register(shutil.rmtree, TEST_DATA_DIR, ignore_errors=True)

# Mocked QVAC never sends the API key, so a placeholder keeps Settings.get_api_key()
# from falling back to ~/.mwm/qvac.key (truthy values parsed as in Settings.QVAC_MOCK).
os.environ.setdefault("QVAC_MOCK", "1")
if os.environ["QVAC_MOCK"].lower() in ("1", "true", "yes") and not os.environ.get("QVAC_API_KEY"):
    os.environ["QVAC_API_KEY"] = "mwm-test-placeholder"

def pytest_report_header(config):
    return f"mwm: MWM_DATA_DIR={TEST_DATA_DIR} (temporary), QVAC_MOCK={os.environ['QVAC_MOCK']}"
