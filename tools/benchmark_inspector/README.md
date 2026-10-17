# Benchmark inspector (Streamlit)

Local, read-only viewer for the external THL data: `thl_nidr` (register cases and incidence) and `finres`
(% resistant with n tested).

```bash
pip install -r tools/benchmark_inspector/requirements.txt
streamlit run tools/benchmark_inspector/app.py        # from the repository root
```

- **Live import preview** runs the real importer parsers. `thl_nidr` calls THL's public API (needs internet);
  `finres` reads `pipeline/benchmarks/data/`. No database needed.
- **Stored in Supabase** needs `SUPABASE_DB_URL` in your shell or a git-ignored `.env`. The app opens the
  connection read-only and never writes.
- Tabs: Overview, Explorer (filters + CSV download), Trends, Coverage (gaps per series and year), Quality checks,
  Live vs Supabase (what a new import would add or change), Runs & provenance, Comparability.
