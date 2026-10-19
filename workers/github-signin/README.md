# GitHub sign-in Worker

Lets the app sign a part publisher in with GitHub (docs/part-libraries.md, "Publisher identity"). It passes GitHub's
two device-flow endpoints through with CORS, which a page cannot call directly. It holds no secret and stores nothing.

## Set up once

1. Register a GitHub OAuth app under the Open-Industry-Project organization (Settings > Developer settings > OAuth
   Apps > New): name "Open Industry Project parts", homepage `https://www.openindustryproject.org`, callback URL
   `https://www.openindustryproject.org/app/` (unused by the device flow, but required). Tick **Enable Device Flow**.
2. Put its client id in `wrangler.toml` as `GITHUB_CLIENT_ID`. The client secret is not needed; do not generate one.
3. `npx wrangler deploy` from this folder. It serves at `https://signin.openindustryproject.org`.

The app reads the Worker's address from `src/editor/publish/github.ts` (`SIGNIN_URL`).
