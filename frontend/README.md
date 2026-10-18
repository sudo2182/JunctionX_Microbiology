# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Deploying to Vercel

The build targets Vercel automatically: on Vercel, Nitro detects the platform and writes `.vercel/output`
(static assets plus one server function). `vercel.json` pins the build command. Locally, `npm run build` still
produces the Cloudflare build that Lovable uses.

Vercel project settings: **Root Directory** `frontend`, production branch `main`.

Environment variables (Production and Preview):

| Name | Used by | Notes |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | browser, baked in at build | public values; changing them needs a redeploy |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | server (`/api/assistant` session check) | same values as above |
| `GEMINI_API_KEY` | server only | mark Sensitive; never prefix with `VITE_` |
| `GEMINI_MODEL` | server, optional | defaults to `gemini-3.8-flash` |

Locally these live in `frontend/.env` (git-ignored); the names are listed in the repository's root `.env.example`.

In Supabase, add the Vercel URL under Authentication → URL Configuration (Site URL and Redirect URLs) so
sign-up confirmation emails link back to the deployed app.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
