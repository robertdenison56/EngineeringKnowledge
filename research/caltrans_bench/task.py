"""Inspect task for the Caltrans benchmark (task 11 of the Arc 1 plan).

Three solver conditions over the same questions:

* ``closed_book`` — the model answers from parametric memory only.
* ``rag``         — page-level BM25 (or dense) retrieval over the manifest corpus, top-k in context.
* ``ekg``         — the EKG MCP gateway's read tools in a tool loop against a pinned snapshot.

Run, for example::

    inspect eval caltrans_bench/task.py -T condition=closed_book --model openai/gpt-5.5
    inspect eval caltrans_bench/task.py -T condition=rag -T split=smoke --model mockllm/model
"""

from __future__ import annotations

from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import Score, Scorer, Target, accuracy, scorer, stderr
from inspect_ai.solver import Generate, Solver, TaskState, generate, solver, system_message, use_tools

from . import MANIFEST_PATH, QUESTIONS_DIR, RAW_DIR, SNAPSHOT_DIR
from .manifest import load_manifest
from .schema import Question, load_questions
from .scoring import (
    REFUSAL_TOKEN,
    cited_pages,
    final_answer,
    score_citation,
    score_number,
    score_refusal,
    score_text,
)

DEFAULT_QUESTIONS = QUESTIONS_DIR / "smoke.jsonl"
DEFAULT_SNAPSHOT = SNAPSHOT_DIR / "ekg-caltrans.db"
# The benchmark corpus: current HDM chapter files plus the 2025 Standard Plans and
# Specifications. Older editions and the District 3 bid documents stay in the manifest
# for the grounding study but are not retrieval targets here.
BENCH_GROUPS = "hdm,std-2025"
BENCH_EXCLUDE = {"hdm-combined"}


def bench_doc_ids(manifest) -> list[str]:
    return [d.id for d in manifest.select(group=BENCH_GROUPS) if d.id not in BENCH_EXCLUDE]


SYSTEM_PROMPT = f"""You answer questions about Caltrans design standards: the Highway Design Manual,
the Standard Plans, and the Standard Specifications.

Finish every reply with exactly these two lines:
ANSWER: <the value, with its unit if it has one, or {REFUSAL_TOKEN}>
CITE: <doc-id> p<page>; <doc-id> p<page>

Rules: give one value on the ANSWER line, use {REFUSAL_TOKEN} when the documents do not
contain the answer, and cite only pages you actually used (document id and PDF page number).
If you have no source to cite, write CITE: none."""


def _sample(q: Question) -> Sample:
    return Sample(
        id=q.id,
        input=q.question,
        target=q.answer,
        metadata=q.model_dump(),
    )


@solver
def rag_context(k: int, retriever: str, only: list[str] | None) -> Solver:
    from .rag import PageIndex, format_context

    manifest = load_manifest(MANIFEST_PATH)
    index = PageIndex(manifest, RAW_DIR, only=only or bench_doc_ids(manifest))
    if retriever != "lexical":
        raise NotImplementedError("dense retrieval lands with the `dense` extra in task 11")

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        passages = index.retrieve(state.input_text, k)
        context = format_context(passages) if passages else "(no passages retrieved)"
        state.user_prompt.text = (
            "Use only the passages below. Each is labelled [doc-id pPAGE] for citing.\n\n"
            f"{context}\n\nQuestion: {state.input_text}"
        )
        return state

    return solve


@scorer(
    metrics={
        "answer": [accuracy(), stderr()],
        "citation": [accuracy(), stderr()],
        "protocol": [accuracy()],
    }
)
def bench_scorer(strict: bool = True) -> Scorer:
    """Deterministic scoring dispatched on the question's answer_type; see scoring.py.

    ``strict`` (default) requires the ANSWER: line: a reply without one scores 0 on
    `answer`, and `protocol` reports how often the line was present. With
    ``strict=False`` the scorer falls back to the last number in the reply, which is
    lenient enough that a small model echoing retrieved context can hit by accident.
    """

    async def score(state: TaskState, target: Target) -> Score:
        meta = state.metadata
        response = state.output.completion
        anchors = [(a["doc"], a["page"]) for a in meta.get("anchors", [])]
        atype = meta["answer_type"]
        followed = final_answer(response) is not None
        if strict and not followed:
            cited = cited_pages(response)
            citation_ok = score_citation(response, anchors).correct if anchors else not cited
            return Score(
                value={"answer": 0.0, "citation": 1.0 if citation_ok else 0.0, "protocol": 0.0},
                answer=None,
                explanation="no ANSWER line (protocol not followed)",
                metadata={"bucket": meta["bucket"], "answer_type": atype},
            )
        if atype == "number":
            v = score_number(
                response, float(meta["answer"].replace(",", "")), meta.get("unit"), meta.get("tolerance", 0.0)
            )
        elif atype == "refusal":
            v = score_refusal(response)
        elif atype == "citation":
            v = score_citation(response, anchors)
        else:
            v = score_text(response, meta["answer"], meta.get("aliases"))
        if anchors:
            cite = score_citation(response, anchors)
            citation_ok, citation_reason = cite.correct, cite.reason
        else:  # refusal questions: a citation would be a false citation
            citation_ok = not cited_pages(response)
            citation_reason = "no citation on a refusal" if citation_ok else "cited a page for a refusal"
        return Score(
            value={
                "answer": 1.0 if v.correct else 0.0,
                "citation": 1.0 if citation_ok else 0.0,
                "protocol": 1.0 if followed else 0.0,
            },
            answer=final_answer(response),
            explanation=f"{v.reason} | citation: {citation_reason}",
            metadata={"bucket": meta["bucket"], "answer_type": atype},
        )

    return score


@task
def caltrans_bench(
    condition: str = "closed_book",
    questions: str = str(DEFAULT_QUESTIONS),
    split: str | None = None,
    k: int = 8,
    retriever: str = "lexical",
    ekg_db: str = str(DEFAULT_SNAPSHOT),
    docs: str | None = None,
    strict: bool = True,
) -> Task:
    qs = load_questions(Path(questions), split=split)
    if not qs:
        raise ValueError(f"no questions in {questions} (split={split})")
    only = docs.split(",") if docs else None
    if condition == "closed_book":
        chain = [system_message(SYSTEM_PROMPT), generate()]
    elif condition == "rag":
        chain = [system_message(SYSTEM_PROMPT), rag_context(k, retriever, only), generate()]
    elif condition == "ekg":
        from .ekg_tools import ekg_tool_source

        chain = [system_message(SYSTEM_PROMPT), use_tools(ekg_tool_source(Path(ekg_db))), generate()]
    else:
        raise ValueError(f"unknown condition {condition!r}; expected closed_book, rag, or ekg")
    return Task(
        dataset=MemoryDataset([_sample(q) for q in qs], name=f"caltrans-bench:{Path(questions).stem}"),
        solver=chain,
        scorer=bench_scorer(strict=strict),
        metadata={"condition": condition, "split": split, "k": k, "retriever": retriever, "strict": strict},
    )
