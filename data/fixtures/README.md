# Test fixtures

Hand-built, tiny CSVs in the same shape as the synthetic LIS export, used by `tests/`.
Weeks 1-6 (2023-W40..W45). Each row exercises a rule:

| Row | Exercises |
|---|---|
| C1, C2 (P1, same window) | first-isolate de-duplication: the C2 repeat must not count |
| C3 (P1, week 5) | same patient in a later window counts again |
| C4 / C5 (P2, URO, admitted 2023-10-03) | onset: day 1 = community, day 3 = hospital |
| C4-1 K. pneumoniae AMP, C6-1 P. mirabilis NIT | R1 intrinsic resistance flagged and excluded |
| C5-1 TMP on a wound | R2 urine-only agent marked not reportable |
| C7 (ICU, day 2) | onset community; C7-2 unknown organism rejected; ZZZ unknown code rejected |
| C6-1 AMP = I | result outside {S, R} rejected |
| C8 ward XXX | unknown ward rejected, its isolate and AST rows rejected with it |
| C9-C12 negatives | keep every week non-empty for the volume check |
