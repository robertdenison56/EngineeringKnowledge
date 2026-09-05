from caltrans_bench.scoring import (
    cited_pages,
    convert,
    final_answer,
    is_refusal,
    parse_quantity,
    score_citation,
    score_number,
    score_refusal,
    score_text,
)


def test_final_answer_takes_last_answer_line():
    r = "thinking...\nANSWER: 500 ft\nactually\nANSWER: 580 ft\nCITE: hdm-chp0200 p12"
    assert final_answer(r) == "580 ft"


def test_parse_quantity_handles_commas_and_units():
    assert parse_quantity("1,200 ft") == (1200.0, "ft")
    assert parse_quantity("65 mph max") == (65.0, "mph")
    assert parse_quantity("about 12") == (12.0, None)
    assert parse_quantity("no digits") is None


def test_convert_same_dimension_only():
    assert abs(convert(100, "ft", "m") - 30.48) < 1e-9
    assert convert(60, "mph", "km/h") > 96.5
    assert convert(5, "ft", "mph") is None
    assert convert(5, None, "ft") == 5


def test_score_number_tolerance_and_units():
    assert score_number("ANSWER: 580 ft\nCITE: x p1", 580, "ft", 0).correct
    assert score_number("ANSWER: 176.8 m\nCITE: x p1", 580, "ft", 1).correct
    assert not score_number("ANSWER: 500 ft\nCITE: x p1", 580, "ft", 5).correct
    assert not score_number("ANSWER: 580 mph\nCITE: x p1", 580, "ft", 0).correct
    assert not score_number("ANSWER: NOT IN DOCUMENT\nCITE: none", 580, "ft", 0).correct


def test_score_number_without_protocol_uses_last_number():
    assert score_number("The SSD is 580 feet.", 580, "ft", 0).correct


def test_citations_parse_and_match():
    r = "ANSWER: 3\nCITE: hdm-chp0200 p12; stdspecs-2025, page 401"
    assert cited_pages(r) == {("hdm-chp0200", 12), ("stdspecs-2025", 401)}
    assert score_citation(r, [("stdspecs-2025", 401)]).correct
    assert score_citation(r, [("hdm-chp0200", 13)], page_slack=1).correct
    assert not score_citation(r, [("hdm-chp0300", 12)]).correct
    assert not score_citation("ANSWER: 3\nCITE: none", [("hdm-chp0200", 12)]).correct


def test_refusal_detection():
    assert is_refusal("ANSWER: NOT IN DOCUMENT\nCITE: none")
    assert is_refusal("ANSWER: not in the document")
    assert not is_refusal("ANSWER: 42 ft")
    assert score_refusal("ANSWER: NOT IN DOCUMENT").correct
    assert not score_refusal("ANSWER: 42").correct


def test_score_text_normalized_containment():
    assert score_text("ANSWER: Section 19, Earthwork\nCITE: x p1", "Section 19").correct
    assert score_text("ANSWER: earth-work\nCITE: x p1", "Section 19", aliases=["Earthwork"]).correct
    assert not score_text("ANSWER: Section 39\nCITE: x p1", "Section 19").correct


def test_fractions_fold_into_numbers():
    from caltrans_bench.scoring import fold_fractions

    assert fold_fractions("16½ ft") == "16.5 ft"
    assert fold_fractions("1-1/2 inches") == "1.5 inches"
    assert fold_fractions("16 1/2 ft") == "16.5 ft"
    assert fold_fractions("½ inch") == "0.5 inch"
    assert parse_quantity("7½ s") == (7.5, "s")
    assert score_number("ANSWER: 16½ ft\nCITE: x p1", 16.5, "ft", 0).correct
    assert score_number("ANSWER: 1-1/2 in\nCITE: x p1", 1.5, "in", 0).correct


def test_day_units_and_refusal_phrases():
    assert score_number("ANSWER: 10 days\nCITE: x p1", 10, "day", 0).correct
    assert is_refusal("ANSWER: The document does not specify this value.")


def test_feet_inches_fold():
    from caltrans_bench.scoring import fold_fractions

    assert fold_fractions("23'-4\"").startswith("23.3333 ft")
    assert score_number("ANSWER: 23'-4\"\nCITE: x p1", 23.33, "ft", 0.01).correct
    assert score_number("ANSWER: 19 ft 0 in\nCITE: x p1", 19, "ft", 0).correct


def test_narrow_no_break_space_before_unit():
    assert parse_quantity("580\u202fft") == (580.0, "ft")
    assert score_number("ANSWER: 176.8\u202fm\nCITE: x p1", 580, "ft", 1).correct
