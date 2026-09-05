"""Caltrans benchmark: manifest, question schema, deterministic scoring, Inspect task."""

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = PACKAGE_DIR.parent
REPO_ROOT = RESEARCH_DIR.parent
CORPUS_DIR = RESEARCH_DIR / "corpus"
RAW_DIR = CORPUS_DIR / "raw"
CACHE_DIR = CORPUS_DIR / "cache"
MANIFEST_PATH = CORPUS_DIR / "manifest.json"
QUESTIONS_DIR = RESEARCH_DIR / "questions"
SNAPSHOT_DIR = RESEARCH_DIR / "snapshots"

__all__ = [
    "CACHE_DIR",
    "CORPUS_DIR",
    "MANIFEST_PATH",
    "PACKAGE_DIR",
    "QUESTIONS_DIR",
    "RAW_DIR",
    "REPO_ROOT",
    "RESEARCH_DIR",
    "SNAPSHOT_DIR",
]
