"""The detection model (engine/ner.py) on made-up text, through /ner."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from engine import ner
from engine.main import app

client = TestClient(app)

FR = (
    "JACQUES RICARD\n"
    "1032 CHEMIN DES PATRIOTES\n"
    "2026-08-05  Virement Interac à Kevin Ricard                         300,00                 8 755,63\n"
    "Mme Sylvie Beauchemin, née le 14 juin 1983, habite au 88, rue des Érables, app. 4, Terrebonne.\n"
)
EN = "Your file is handled by Priya Natarajan (licence no. M17044210). Mr. Gordon MacPhail lives at 4410 Wilson Avenue, Montreal.\n"


def found(text: str) -> list[tuple[str, str]]:
    r = client.post("/ner", content=text.encode("utf-8"))
    assert r.status_code == 200
    return [(e["type"], text[e["start"] : e["end"]]) for e in r.json()["entities"]]


def test_finds_people_and_addresses_in_french_and_english():
    fr = found(FR)
    people = {v for t, v in fr if t == "person"}
    assert {"JACQUES RICARD", "Kevin Ricard", "Sylvie Beauchemin"} <= people
    assert ("address", "1032 CHEMIN DES PATRIOTES") in fr
    assert any(t == "address" and v.startswith("88, rue des Érables") for t, v in fr)
    en = found(EN)
    assert {"Priya Natarajan", "Gordon MacPhail"} <= {v for t, v in en if t == "person"}
    assert ("address", "4410 Wilson Avenue") in en


def test_two_people_joined_by_and_stay_two():
    text = "Signé : J.-F. Tremblay et Isabelle Côté - 1842 rue des Érables\nDaniel O'Connor and Priya Raman-O'Connor, buyers\n"
    people = [v for t, v in found(text) if t == "person"]
    assert any(p.endswith("Tremblay") for p in people)
    assert "Isabelle Côté" in people
    assert not any(" et " in p or " and " in p for p in people)
    assert "Priya Raman-O'Connor" in people
    # Surname first: one span or two, both parts are found.
    people = " | ".join(v for t, v in found("Assuré : Tremblay, Jean-François\n") if t == "person")
    assert "Tremblay" in people and "Jean-François" in people


def test_people_never_start_or_end_with_a_lowercase_word():
    text = "À la demande de Paul Gagnon le 12 octobre 2010, puis de Jean d'Amours et de Mme Thi Le, le 14 octobre.\n"
    for t, v in found(text):
        if t == "person":
            assert v.split()[0][0].isupper() or v.startswith("d'"), v
            assert not v.endswith((" le", " de", " et")), v


def test_no_word_fragments_and_no_lone_unit_as_address():
    for t, v in found(FR + EN):
        assert v == v.strip()
        assert not (t == "address" and v.lower().startswith(("app", "apt", "unit", "suite")))


def test_offsets_count_utf16_units_like_javascript():
    text = "😀 " + EN
    shift = len("😀 ".encode("utf-16-le")) // 2
    r = client.post("/ner", content=text.encode("utf-8")).json()["entities"]
    js = text.encode("utf-16-le")
    names = {js[2 * e["start"] : 2 * e["end"]].decode("utf-16-le") for e in r if e["type"] == "person"}
    assert "Priya Natarajan" in names
    assert shift == 3


def test_about_a_second_for_four_dense_pages():
    text = (FR + EN) * 30
    ner.find("Bonjour Jean Tremblay.")
    t = time.time()
    ner.find(text)
    assert time.time() - t < 3, f"{len(text)} chars took {time.time() - t:.1f} s"
