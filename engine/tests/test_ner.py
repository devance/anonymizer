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


def test_a_company_and_a_person_read_as_one_name_are_split():
    got = found("Le 21 octobre 2022\n\nMarvale Inc. & Laurent Boisvenu\n44, chemin de l'Érablière\n")
    assert ("person", "Laurent Boisvenu") in got, got
    assert not any(t == "organization" and "Laurent" in v for t, v in got), got


def test_ordinary_words_are_not_people_or_companies():
    text = "Montant\tColonne\nAucun\nAjouté\nLe montant total, colonne 3. Locataire : Paul Gagnon\nSERVICES COURANTS\nTPS\n"
    got = found(text)
    assert not any(v in ("Montant", "Colonne", "Aucun", "Ajouté", "SERVICES COURANTS", "TPS") for _, v in got), got


def test_checkboxes_and_ocr_noise_are_not_people():
    noise = ["Cioui Érfon", "Ooui Cinon", "COoui Ænon", "Coûüi Cinon", "EOnon", "ÉHéton"]
    for v in noise:
        assert ner._debris(v), v
    for v in ["Jean-François LeBlanc", "Hélène TREMBLAY", "MORIN & ASSOCIÉS évaluateurs agréés", "Noël Côté", "Zoë Muñoz"]:
        assert not ner._debris(v), v


def test_misspelled_form_labels_are_not_people():
    o = ner._Ordinary("")
    assert o.near("Sjgnature") and o.near("Ipitiales") and not o.near("Tremblay")
    text = "Année Sjgnature\nJour Mois Année Ipitiales\nLocataire : Gabrielle Fortin-Lachance"
    got = [v for t, v in found(text) if t == "person"]
    assert got == ["Gabrielle Fortin-Lachance"], got


def test_a_price_after_a_code_is_not_part_of_it():
    assert ner._keep("Article LAH8387308 3.40", [], "id_number", 8, 23)["end"] == 18
    assert ner._keep("Article LAH8387308 3.40 FP", [], "sin", 8, 26)["end"] == 18


def test_a_name_in_a_form_field_is_kept_even_if_it_is_a_word():
    got = found("Nom de famille\n\nPetit\n\nPrénom\n\nRose\n")
    assert all(t != "person" or v in ("Petit", "Rose") for t, v in got)


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


def test_a_name_split_over_two_lines_by_the_ocr():
    text = "Nom du représentant\nJacques 5 S Ê\nPoulin Agent aux programmes\nMarie\nMontant total\nPaul\nLaurent\n😀 OUELLET Montant dû\nSYLVAIN Pour la police"
    r = client.post("/ner", content=text.encode("utf-8")).json()["entities"]
    js = text.encode("utf-16-le")
    piece = lambda a, b: js[2 * a : 2 * b].decode("utf-16-le")
    pairs = {(piece(e["start"], e["end"]), piece(*e["last"])) for e in r if "last" in e}
    assert pairs == {("Jacques", "Poulin")}
    text = text.replace("😀 ", "")
    r = client.post("/ner", content=text.encode("utf-8")).json()["entities"]
    pairs = {(text[e["start"] : e["end"]], text[e["last"][0] : e["last"][1]]) for e in r if "last" in e}
    assert pairs == {("Jacques", "Poulin"), ("SYLVAIN", "OUELLET")}


def test_a_surname_then_a_first_name_in_capitals():
    text = "Assuré\nBOISVENU LAURENT                   \nMONTANT TOTAL\nSAINT LAURENT\n"
    r = client.post("/ner", content=text.encode("utf-8")).json()["entities"]
    pairs = {(text[e["start"] : e["end"]], text[e["last"][0] : e["last"][1]]) for e in r if "last" in e}
    assert pairs == {("LAURENT", "BOISVENU")}
    assert not any(e["type"] == "organization" and "BOISVENU" in text[e["start"] : e["end"]] for e in r)


def test_towns_and_words_are_not_stacked_names():
    text = "50 rue\nSainte-Ursule\nBaie-Saint-Louis\nla salle de bain\nSalle\nFenestré\n"
    r = client.post("/ner", content=text.encode("utf-8")).json()["entities"]
    assert not any("last" in e for e in r)
