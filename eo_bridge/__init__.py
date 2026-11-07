"""ROZLF ExpertOption read-only bridge."""
import os
import sys

# The vendored library uses absolute `ExpertOptionsToolsV2.*` imports, so the
# vendor directory itself has to be importable.
_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)
