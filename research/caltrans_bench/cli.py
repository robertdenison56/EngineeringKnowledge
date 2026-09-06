"""``caltrans-bench`` command line: manifest, questions, smoke."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import MANIFEST_PATH, QUESTIONS_DIR, RAW_DIR
from .manifest import build, fetch, load_manifest, save_manifest, verify


def _ids(value: str | None) -> list[str] | None:
    return [v.strip() for v in value.split(",") if v.strip()] if value else None


def cmd_manifest(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    raw_dir = Path(args.raw_dir)
    if args.mcmd == "fetch":
        local = Path(args.local_dir) if args.local_dir else None
        for doc, outcome in fetch(manifest, raw_dir, _ids(args.only), args.group, local, args.force):
            print(f"{outcome:13} {doc.id:32} {doc.file}")
        return 0
    if args.mcmd == "build":
        missing = build(manifest, raw_dir, with_pages=not args.no_pages)
        save_manifest(manifest, args.manifest)
        hashed = len(manifest.documents) - len(missing)
        print(f"hashed {hashed}/{len(manifest.documents)} documents → {args.manifest}")
        for doc in missing:
            print(f"  missing: {doc.id} ({doc.relative_path})")
        return 1 if missing else 0
    if args.mcmd == "verify":
        problems = verify(manifest, raw_dir, _ids(args.only), args.group, offline=args.offline)
        checked = len(manifest.select(_ids(args.only), args.group))
        for p in problems:
            print(f"PROBLEM {p}")
        print(f"{checked - len(problems)}/{checked} documents ok" + (" (offline)" if args.offline else ""))
        return 1 if problems else 0
    if args.mcmd == "table":
        print("| id | group | title | edition | revised | pages | sha256 | source |")
        print("|---|---|---|---|---|---|---|---|")
        for d in manifest.select(_ids(args.only), args.group):
            src = f"[url]({d.url})" if d.url else "local (see source_note)"
            print(
                f"| {d.id} | {d.group} | {d.title} | {d.edition or ''} | {d.revision_date or ''} | "
                f"{d.pages or ''} | {(d.sha256 or '')[:12]} | {src} |"
            )
        return 0
    raise AssertionError(args.mcmd)


def cmd_questions_xlsx(args: argparse.Namespace) -> int:
    from .schema import load_questions
    from .xlsx import export_xlsx, import_xlsx, write_jsonl

    if args.qcmd == "export-xlsx":
        src = Path(args.path)
        out = Path(args.out) if args.out else src.with_suffix(".xlsx")
        qs = load_questions(src)
        export_xlsx(qs, load_manifest(args.manifest), out, src.name)
        print(f"wrote {out} ({len(qs)} questions)")
        return 0
    src = Path(args.path)
    out = Path(args.out) if args.out else src.with_suffix(".jsonl")
    qs, errors = import_xlsx(src)
    for e in errors:
        print(f"FAIL {e}")
    if errors:
        print(f"{len(errors)} row(s) failed; nothing written. Fix them in {src.name} and re-run.")
        return 1
    write_jsonl(qs, out, src)
    print(f"wrote {out} ({len(qs)} questions); now run: caltrans-bench questions validate {out}")
    return 0


def cmd_questions(args: argparse.Namespace) -> int:
    from .schema import load_questions

    if args.qcmd in ("export-xlsx", "import-xlsx"):
        return cmd_questions_xlsx(args)
    path = Path(args.path)
    qs = load_questions(path, split=args.split)
    if args.qcmd == "docs":
        print(",".join(sorted({a.doc for q in qs for a in q.anchors})))
        return 0
    if args.qcmd == "stats":
        from collections import Counter

        buckets, types, splits, docs = Counter(), Counter(), Counter(), Counter()
        for q in qs:
            buckets[q.bucket] += 1
            types[q.answer_type] += 1
            splits[q.split] += 1
            for a in q.anchors:
                docs[a.doc] += 1
        print(f"{len(qs)} questions in {path.name}")
        for name, c in (("bucket", buckets), ("answer_type", types), ("split", splits), ("anchored doc", docs)):
            print(f"  {name}: " + ", ".join(f"{k}={v}" for k, v in sorted(c.items(), key=lambda kv: -kv[1])))
        return 0
    # validate
    manifest = load_manifest(args.manifest).by_id()
    failures: list[str] = []
    for q in qs:
        for a in q.anchors:
            doc = manifest.get(a.doc)
            if doc is None:
                failures.append(f"{q.id}: unknown doc {a.doc}")
                continue
            if args.offline:
                continue
            from .text import contains, page_text

            try:
                text = page_text(doc, a.page, Path(args.raw_dir))
            except (FileNotFoundError, IndexError) as exc:
                failures.append(f"{q.id}: {exc}")
                continue
            needles = [a.quote] if a.quote else [q.answer, *q.aliases]
            if not any(contains(text, n) for n in needles if n):
                failures.append(f"{q.id}: none of {needles!r} found on {a.doc} p{a.page}")
            if a.table and not contains(text, a.table):
                failures.append(f"{q.id}: table label {a.table!r} not on {a.doc} p{a.page}")
    for f in failures:
        print(f"FAIL {f}")
    print(
        f"{len(qs) - len({f.split(':')[0] for f in failures})}/{len(qs)} questions validated"
        + (" (schema only)" if args.offline else "")
    )
    return 1 if failures else 0


def cmd_corpus(args: argparse.Namespace) -> int:
    """Authoring helpers over the cached page text: grep a regex, or print one page."""
    import re

    from .text import page_text, page_texts

    manifest = load_manifest(args.manifest)
    raw_dir = Path(args.raw_dir)
    if args.ccmd == "page":
        doc = manifest.by_id()[args.doc]
        print(page_text(doc, args.page, raw_dir))
        return 0
    pattern = re.compile(args.pattern, re.IGNORECASE)
    lo_page, hi_page = 1, 10**9
    if args.pages:
        a, _, b = args.pages.partition("-")
        lo_page, hi_page = int(a or 1), int(b or a or 10**9)
    shown = 0
    for doc in manifest.select(_ids(args.docs), args.group):
        if not doc.path(raw_dir).exists():
            continue
        for page_no, text in enumerate(page_texts(doc, raw_dir), start=1):
            if not lo_page <= page_no <= hi_page:
                continue
            flat = " ".join(text.split())
            for m in pattern.finditer(flat):
                lo, hi = max(0, m.start() - args.context), min(len(flat), m.end() + args.context)
                print(f"{doc.id} p{page_no}: …{flat[lo:hi]}…")
                shown += 1
                if shown >= args.max:
                    print(f"(stopped at --max {args.max})")
                    return 0
                break  # one hit per page keeps the listing scannable
    print(f"{shown} page hit(s)")
    return 0


def cmd_smoke(args: argparse.Namespace) -> int:
    from inspect_ai import eval as inspect_eval

    from .task import caltrans_bench

    logs = inspect_eval(
        caltrans_bench(condition=args.condition, questions=args.questions, split=args.split),
        model=args.model,
        limit=args.limit,
        log_dir=args.log_dir,
        display="plain",
    )
    log = logs[0]
    if log.status != "success":
        print(f"smoke FAILED: {log.status} {log.error.message if log.error else ''}")
        return 1
    n = log.results.completed_samples if log.results else 0
    print(f"smoke ok: {n} samples, condition={args.condition}, model={args.model}")
    if log.results:
        for s in log.results.scores:
            for name, m in s.metrics.items():
                print(f"  {s.name}/{name}: {m.value:.3f}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="caltrans-bench")
    p.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    p.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    sub = p.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("manifest", help="corpus manifest: fetch, build, verify, table")
    ms = m.add_subparsers(dest="mcmd", required=True)
    f = ms.add_parser("fetch", help="download URL-backed documents; copy URL-less ones from --local-dir")
    f.add_argument("--only", help="comma-separated document ids")
    f.add_argument("--group")
    f.add_argument("--local-dir")
    f.add_argument("--force", action="store_true")
    b = ms.add_parser("build", help="fill bytes/sha256/pages from files on disk")
    b.add_argument("--no-pages", action="store_true")
    v = ms.add_parser("verify", help="re-hash files against the manifest")
    v.add_argument("--only")
    v.add_argument("--group")
    v.add_argument("--offline", action="store_true", help="manifest consistency only, touch no files")
    t = ms.add_parser("table", help="markdown table of the manifest")
    t.add_argument("--only")
    t.add_argument("--group")
    m.set_defaults(func=cmd_manifest)

    q = sub.add_parser("questions", help="question sets: validate, docs")
    qs = q.add_subparsers(dest="qcmd", required=True)
    for name, help_ in (
        ("validate", "schema + anchor check"),
        ("docs", "print the document ids a set anchors to"),
        ("stats", "bucket / answer-type / split / document counts"),
    ):
        sp = qs.add_parser(name, help=help_)
        sp.add_argument("path", nargs="?", default=str(QUESTIONS_DIR / "smoke.jsonl"))
        sp.add_argument("--split")
        sp.add_argument("--offline", action="store_true")
    ex = qs.add_parser(
        "export-xlsx", help="write an editable workbook (Questions, Docs, Stats, Guide sheets) from a JSONL set"
    )
    ex.add_argument("path", nargs="?", default=str(QUESTIONS_DIR / "caltrans-v0.jsonl"))
    ex.add_argument("--out", help="default: same name with .xlsx")
    im = qs.add_parser("import-xlsx", help="read the Questions sheet back into validated JSONL")
    im.add_argument("path", nargs="?", default=str(QUESTIONS_DIR / "caltrans-v0.xlsx"))
    im.add_argument("--out", help="default: same name with .jsonl")
    q.set_defaults(func=cmd_questions)

    c = sub.add_parser("corpus", help="authoring helpers over cached page text: grep, page")
    cs = c.add_subparsers(dest="ccmd", required=True)
    g = cs.add_parser("grep", help="regex search over every page; one hit per page")
    g.add_argument("pattern")
    g.add_argument("--docs", help="comma-separated document ids")
    g.add_argument("--group")
    g.add_argument("--context", type=int, default=90)
    g.add_argument("--pages", help="restrict to a PDF page range, e.g. 855-878")
    g.add_argument("--max", type=int, default=40)
    pg = cs.add_parser("page", help="print the text of one page")
    pg.add_argument("doc")
    pg.add_argument("page", type=int)
    c.set_defaults(func=cmd_corpus)

    s = sub.add_parser("smoke", help="run the Inspect task end to end (default: mock model)")
    s.add_argument("--condition", default="closed_book", choices=["closed_book", "rag", "ekg"])
    s.add_argument("--model", default="mockllm/model")
    s.add_argument("--questions", default=str(QUESTIONS_DIR / "smoke.jsonl"))
    s.add_argument("--split")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--log-dir", default="logs")
    s.set_defaults(func=cmd_smoke)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
