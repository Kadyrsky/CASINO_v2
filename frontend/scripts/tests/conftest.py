"""The scripts are run as files (python scripts/map_model.py), not installed: the tests import them from there."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
