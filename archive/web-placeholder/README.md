# web/ (placeholder)

Next.js (App Router, TypeScript) + Tailwind + shadcn/ui + ECharts dashboard, deployed on Vercel
(BUILD_PLAN.md §6). Owned by the dashboard build.

Reads only the `api.*` views with the anon key (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`). Never import the service role key here.
