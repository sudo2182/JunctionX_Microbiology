Test fixtures for pipeline/benchmarks.

- `thl_nidr_dimensions.jsonp`, `thl_nidr_response.json`: real THL API output (CC BY 4.0), trimmed to a few categories.
- `ecdc_atlas_format_fixture.csv`: **invented placeholder values**, only to exercise the parser. The real Atlas export
  could not be downloaded automatically, so its column names are an assumption (see pipeline/benchmarks/ecdc_atlas.py).
  Never import this file into a database.
