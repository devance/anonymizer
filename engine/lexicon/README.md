# Lexicon

Two word lists the detection model's spans are checked against
(`engine/ner.py`): a capitalised word that is an ordinary French or English
word ("Montant", "Colonne", "Aucun") isn't taken for a name or a company,
unless it's a first name.

- `words.txt.gz`: every word of 2+ letters in Tesseract's French and English
  LSTM dictionaries (`fra`/`eng` `lstm-word-dawg` from tessdata_fast commit
  87416418, the same files as `engine/tessdata`) that the dictionaries
  themselves write in lowercase (so not "Tremblay" or "Cogeco"). Apache-2.0.
  Rebuilt with `combine_tessdata -u` and `dawg2wordlist`.
- `first-names.txt.gz`: first names given at least 50 times in France since
  1900, lowercased, from INSEE's *Fichier des prénoms* (édition 2023,
  `nat2022.csv`). Licence Ouverte / Open Licence 2.0 (Etalab).
