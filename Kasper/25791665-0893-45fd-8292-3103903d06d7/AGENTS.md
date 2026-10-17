<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Dashboard data is preprocessed from the synthetic CSVs into `public/data/isolates.json` (one compact row per isolate) and loaded client-side by `src/lib/amr/store.ts`; user-added records and alerts persist in localStorage until a backend is connected. Why: keeps all analyses (maps, ward %, SaTScan, risk) computed from one record list so new records flow everywhere.
- Analytics live as pure functions in `src/lib/amr/` (satscan, risk, stats) with tests in `src/test/amr-rules.test.ts`. Why: testable and reusable once data moves to a database.
- `noUncheckedIndexedAccess` is disabled in tsconfig. Why: dense numeric array code in the scan statistic.
- Estimated ward occupancy and marker summaries live in pure functions in `src/lib/amr/occupancy.ts`; overview defaults to the latest sample date and labels occupancy as estimated. Why: missing discharge data must not imply confirmed current occupancy or justify ward isolation.
- Clinical antibiotic applicability is a conservative versioned EUCAST subset in `src/lib/amr/applicability.ts`, shared by spatial, ward and scan views; never infer treatment combinations or reinterpret stored AST. Why: testing coverage alone does not establish organism–agent applicability or clinical efficacy.
- Separate phenotype charts share `src/components/amr/marker-charts.tsx` and remain independent of organism/antibiotic selections. Why: marker surveillance must remain directly visible and include all recorded species.
- Scan reporting options change candidate inclusion only, not Monte Carlo p-values or significance thresholds. Why: exploratory visibility must not imply stronger statistical evidence.
- The overview atlas uses `wardOverview` and `wardHistory` for total/positive occupancy and weekly snapshots; selected-ward marker histories use rolling 28-day first isolates, and resistance links carry validated ward/date search parameters. Ward positioning stays schematic. Why: shared estimate rules prevent historical counts or navigation from diverging from the selected ward.
