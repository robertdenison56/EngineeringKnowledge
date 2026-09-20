"""``caltrans-bench`` command line: manifest, questions, smoke."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import MANIFEST_PATH, QUESTIONS_DIR, RAW_DIR
from .manifest import build, fetch, load_manifest, save_manifest, verify
from .schema import DEFAULT_SHARD, MAX_SHARD, SHARDS


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


def cmd_questions_shard(args: argparse.Namespace) -> int:
    """Deal a set into run shards and write the assignment back into the JSONL."""
    from collections import Counter

    from .schema import MAX_SHARD, load_questions, stratify, write_shards

    path = Path(args.path)
    qs = load_questions(path)
    assigned = stratify(qs, shards=args.shards)
    counts = Counter(assigned.values())
    over = [f"{k}={v}" for k, v in sorted(counts.items()) if v > MAX_SHARD]
    if over:
        print(f"FAIL shard(s) over the {MAX_SHARD}-question cap: {', '.join(over)}")
        return 1
    by_shard: dict[str, Counter] = {sh: Counter() for sh in counts}
    docs: dict[str, set[str]] = {sh: set() for sh in counts}
    moved = 0
    for q in qs:
        sh = assigned[q.id]
        by_shard[sh][q.bucket] += 1
        docs[sh].update(a.doc for a in q.anchors)
        moved += q.shard != sh
    for sh in sorted(counts):
        mix = " ".join(f"{b}={by_shard[sh][b]}" for b in ("lookup", "multihop", "trap", "refusal"))
        print(f"  {sh}: {counts[sh]:3d} questions  {mix}  ({len(docs[sh])} documents)")
    if args.dry_run:
        print(f"{len(qs)} questions in {len(counts)} shards; {moved} would move (dry run, nothing written)")
        return 0
    changed = write_shards(path, assigned)
    print(f"{len(qs)} questions in {len(counts)} shards; {changed} line(s) updated in {path.name}")
    return 0


def cmd_questions(args: argparse.Namespace) -> int:
    from .schema import load_questions

    if args.qcmd in ("export-xlsx", "import-xlsx"):
        return cmd_questions_xlsx(args)
    if args.qcmd == "shard":
        return cmd_questions_shard(args)
    path = Path(args.path)
    qs = load_questions(path, split=args.split, shard=args.shard)
    if args.qcmd == "docs":
        print(",".join(sorted({a.doc for q in qs for a in q.anchors})))
        return 0
    if args.qcmd == "stats":
        from collections import Counter

        buckets, types, splits, docs = Counter(), Counter(), Counter(), Counter()
        shards: dict[str, Counter] = {}
        shard_docs: dict[str, set[str]] = {}
        for q in qs:
            buckets[q.bucket] += 1
            types[q.answer_type] += 1
            splits[q.split] += 1
            for a in q.anchors:
                docs[a.doc] += 1
            if q.shard:
                shards.setdefault(q.shard, Counter())[q.bucket] += 1
                shard_docs.setdefault(q.shard, set()).update(a.doc for a in q.anchors)
        print(f"{len(qs)} questions in {path.name}")
        for name, c in (("bucket", buckets), ("answer_type", types), ("split", splits), ("anchored doc", docs)):
            print(f"  {name}: " + ", ".join(f"{k}={v}" for k, v in sorted(c.items(), key=lambda kv: -kv[1])))
        if shards:
            print("  shards (one shard is a runnable estimate of the whole set):")
            for sh in sorted(shards):
                mix = " ".join(f"{b}={shards[sh][b]}" for b in ("lookup", "multihop", "trap", "refusal"))
                print(f"    {sh}: {sum(shards[sh].values()):3d}  {mix}  ({len(shard_docs[sh])} documents)")
        return 0
    # validate
    manifest = load_manifest(args.manifest).by_id()
    failures: list[str] = []
    # A part-sharded set is the quiet failure: `shard=a` filters on the field, so questions
    # added since the last deal would sit out every run instead of erroring.
    if args.shard is None:
        missing = [q.id for q in qs if not q.shard]
        if missing and len(missing) != len(qs):
            failures.append(
                f"{len(missing)} question(s) carry no shard while the rest do ({', '.join(missing[:5])}"
                f"{', …' if len(missing) > 5 else ''}); run: caltrans-bench questions shard {path}"
            )
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


def cmd_plans(args: argparse.Namespace) -> int:
    """Plan understanding work: gold templates, renders, validation, extraction, scoring."""
    import json

    from . import plans

    manifest = load_manifest(args.manifest)
    raw_dir = Path(args.raw_dir)
    if args.pcmd == "template":
        out = Path(args.out)
        existing: dict[str, plans.SheetGold] = {}
        if out.exists():
            existing = {r.id: r for r in plans.load_gold(out, include_todo=True)}
        fresh = [r for r in plans.template_rows(manifest, _ids(args.docs) or [], raw_dir) if r.id not in existing]
        rows = sorted([*existing.values(), *fresh], key=lambda r: (r.doc, r.page))
        header = (
            "Plan understanding work — Tier 1 sheet gold. One line per PDF page; status=todo rows are unscored.\n"
            "Scalars null = not printed; lists empty = none printed. See caltrans_bench/plans.py for field meanings."
        )
        plans.dump_gold(rows, out, header=header if not existing else None)
        print(f"{out}: {len(fresh)} new todo rows, {len(existing)} kept ({len(rows)} total)")
        return 0
    if args.pcmd == "render":
        doc = manifest.by_id()[args.doc]
        for page in _page_list(args.pages):
            print(plans.render_page(doc, page, Path(args.out_dir), args.dpi, raw_dir))
        return 0
    if args.pcmd == "extract":
        if args.system == "textlayer":
            from .plans_context import write_textlayer_predictions

            out_dir = Path(args.out_dir or plans.PLANS_DIR / "preds-textlayer")
            for doc in manifest.select(_ids(args.docs), args.group):
                n = write_textlayer_predictions(doc, out_dir / f"{doc.id}.jsonl", raw_dir)
                print(f"{doc.id}: {n} pages (text-layer context baseline) → {out_dir / f'{doc.id}.jsonl'}")
            return 0
        problems = plans.extraction_prerequisites()
        if problems:
            print("\n".join(f"PROBLEM {p}" for p in problems))
            return 1
        out_dir = Path(args.out_dir or plans.PREDS_DIR)
        lo_hi = None
        if args.pages:
            a, _, b = args.pages.partition("-")
            lo_hi = (int(a), int(b or a))
        for doc in manifest.select(_ids(args.docs), args.group):
            n = plans.run_extraction(doc, out_dir / f"{doc.id}.jsonl", raw_dir, lo_hi)
            print(f"{doc.id}: {n} pages → {out_dir / f'{doc.id}.jsonl'}")
        return 0
    if args.pcmd == "import-log":
        from .plans_context import import_eval_log

        n, files = import_eval_log(Path(args.log), Path(args.out_dir))
        for f in files:
            print(f"wrote {f}")
        print(f"{n} sample replies imported; now: caltrans-bench plans score --preds {args.out_dir}")
        return 0
    if args.pcmd == "score":
        gold_path = Path(args.gold)
        gold = plans.load_gold(gold_path, split=args.split)
        pred_paths = plans.prediction_files(Path(args.preds))
        preds = plans.load_predictions(pred_paths)
        card = plans.score(gold, preds, plans.scorecard_meta(gold_path, pred_paths, args.split))
        print(plans.format_scorecard(card, errors=args.errors))
        data = card.to_dict()
        if args.out:
            out = Path(args.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            print(f"wrote {out}")
        if args.baseline:
            drops = plans.regressions(data, json.loads(Path(args.baseline).read_text(encoding="utf-8")), args.tolerance)
            for d in drops:
                print(f"REGRESSION {d}")
            print(f"{len(drops)} regression(s) against {args.baseline}")
            return 1 if drops else 0
        return 0
    # validate / stats
    path = Path(args.path)
    rows = plans.load_gold(path, split=args.split, include_todo=args.pcmd == "stats" or args.include_todo)
    if args.pcmd == "stats":
        stats = plans.gold_stats(rows)
        print(f"{len(rows)} sheets in {path.name}")
        for name, counter in stats.items():
            print(f"  {name}: " + ", ".join(f"{k}={v}" for k, v in sorted(counter.items(), key=lambda kv: -kv[1])))
        return 0
    problems = plans.validate_gold(rows, manifest, raw_dir, offline=args.offline)
    for p in problems:
        print(f"FAIL {p}")
    bad = {p.split(":")[0] + ":" + p.split(":")[1] for p in problems}
    print(f"{len(rows) - len(bad)}/{len(rows)} sheets validated" + (" (schema only)" if args.offline else ""))
    return 1 if problems else 0


def _page_list(spec: str) -> list[int]:
    pages: list[int] = []
    for part in spec.split(","):
        a, _, b = part.strip().partition("-")
        pages.extend(range(int(a), int(b or a) + 1))
    return pages


def cmd_smoke(args: argparse.Namespace) -> int:
    from inspect_ai import eval as inspect_eval

    from .task import caltrans_bench

    logs = inspect_eval(
        caltrans_bench(condition=args.condition, questions=args.questions, split=args.split, shard=args.shard),
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
    print(f"smoke ok: {n} samples, condition={args.condition}, model={args.model}, shard={args.shard}")
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
        sp.add_argument("--shard", choices=list(SHARDS), help="one run shard; ignored on an unsharded set")
        sp.add_argument("--offline", action="store_true")
    sh = qs.add_parser("shard", help=f"deal a set into run shards of at most {MAX_SHARD}, each with the whole mix")
    sh.add_argument("path", nargs="?", default=str(QUESTIONS_DIR / "caltrans-v0.jsonl"))
    sh.add_argument("--shards", type=int, help=f"how many (default: the fewest that keep each at {MAX_SHARD})")
    sh.add_argument("--dry-run", action="store_true", help="print the deal, write nothing")
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

    from .plans import DEFAULT_GOLD, PREDS_DIR, RENDERS_DIR

    pl = sub.add_parser("plans", help="plan understanding work: sheet gold, renders, extraction, Tier 1 scoring")
    ps = pl.add_subparsers(dest="pcmd", required=True)
    tp = ps.add_parser("template", help="add one todo row per page of the given plan sets to a gold file")
    tp.add_argument("--docs", required=True, help="comma-separated plan-set document ids")
    tp.add_argument("--out", default=str(DEFAULT_GOLD))
    rd = ps.add_parser("render", help="PNG renders of sheets for labelling")
    rd.add_argument("doc")
    rd.add_argument("pages", help="e.g. 2 or 1-5,9")
    rd.add_argument("--dpi", type=int, default=80)
    rd.add_argument("--out-dir", default=str(RENDERS_DIR))
    for name, help_ in (("validate", "schema + text-layer check of every labelled string"), ("stats", "counts")):
        sp = ps.add_parser(name, help=help_)
        sp.add_argument("path", nargs="?", default=str(DEFAULT_GOLD))
        sp.add_argument("--split", choices=["dev", "test"])
        sp.add_argument("--offline", action="store_true")
        sp.add_argument("--include-todo", action="store_true")
    ex = ps.add_parser("extract", help="run a prediction system over plan sets and write prediction JSONL per document")
    ex.add_argument("--docs", help="comma-separated document ids")
    ex.add_argument("--group", help="manifest group, e.g. district3")
    ex.add_argument("--pages", help="page range, e.g. 1-10 (default: every page; parser only)")
    ex.add_argument(
        "--system",
        default="parser",
        choices=["parser", "textlayer"],
        help="parser = the product SheetFacts extractor; textlayer = regex context baseline over the page text",
    )
    ex.add_argument("--out-dir", help=f"default: {PREDS_DIR} for parser, plans/preds-textlayer for textlayer")
    il = ps.add_parser("import-log", help="write the model replies of a plan_sheets Inspect log as prediction JSONL")
    il.add_argument("log", help="path to the .eval log")
    il.add_argument("--out-dir", required=True)
    sc = ps.add_parser("score", help="Tier 1 scorecard of gold against predictions")
    sc.add_argument("--gold", default=str(DEFAULT_GOLD))
    sc.add_argument("--preds", default=str(PREDS_DIR), help="prediction JSONL file or directory")
    sc.add_argument("--split", choices=["dev", "test"])
    sc.add_argument("--out", help="write the scorecard JSON here")
    sc.add_argument("--baseline", help="committed scorecard JSON to compare against; exit 1 on regression")
    sc.add_argument("--tolerance", type=float, default=0.0)
    sc.add_argument("--errors", type=int, default=20, help="how many error lines to print")
    pl.set_defaults(func=cmd_plans)

    s = sub.add_parser("smoke", help="run the Inspect task end to end (default: mock model)")
    s.add_argument("--condition", default="closed_book", choices=["closed_book", "rag", "ekg"])
    s.add_argument("--model", default="mockllm/model")
    s.add_argument("--questions", default=str(QUESTIONS_DIR / "smoke.jsonl"))
    s.add_argument("--split")
    s.add_argument("--shard", default=DEFAULT_SHARD, help=f"run shard, or 'all' (default: {DEFAULT_SHARD})")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--log-dir", default="logs")
    s.set_defaults(func=cmd_smoke)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
