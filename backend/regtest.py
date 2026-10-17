"""
MwM - Regtest Python Wrapper
Encapsulates regtest commands (mine, sendtoaddress, height) via scripts/regtest.sh.
"""

import subprocess
import time
import logging
from typing import List
from backend.config import settings

logger = logging.getLogger("mwm.regtest")

class RegtestError(RuntimeError):
    """Raised when a regtest command fails."""
    pass

def run_regtest_cmd(*args: str) -> str:
    """Execute a command against the regtest shell helper."""
    script_path = settings.REGTEST_SCRIPT
    cmd: List[str] = [script_path] + list(args)
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return res.stdout.strip()
    except subprocess.CalledProcessError as exc:
        err_msg = f"Regtest command failed: {' '.join(cmd)}\nStdout: {exc.stdout}\nStderr: {exc.stderr}"
        logger.error(err_msg)
        raise RegtestError(err_msg) from exc
    except FileNotFoundError as exc:
        err_msg = f"Regtest script not found at {script_path}"
        logger.error(err_msg)
        raise RegtestError(err_msg) from exc

def mine(blocks: int = 1) -> None:
    """Mine N blocks on regtest and wait briefly for indexer sync."""
    if blocks <= 0:
        return
    run_regtest_cmd("mine", str(blocks))
    time.sleep(0.5)

def send_to_address(address: str, btc_amount: str = "1.0") -> str:
    """Fund an address with BTC from miner wallet and mine 1 block."""
    txid = run_regtest_cmd("sendtoaddress", address, str(btc_amount))
    mine(1)
    return txid

def get_height() -> int:
    """Return the current block count on regtest."""
    output = run_regtest_cmd("height")
    return int(output)

def start_services() -> str:
    """Start regtest docker services if not already running."""
    return run_regtest_cmd("start")

def stop_services() -> str:
    """Stop regtest docker services."""
    return run_regtest_cmd("stop")
