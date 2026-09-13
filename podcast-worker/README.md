# Th3rd Rule Podcast — standalone subdomain

A tiny Cloudflare Worker whose only job is to serve `public/index.html`
(a copy of `../podcast.html`) at a dedicated subdomain, e.g.
`podcast.thetobaccocenter.com`. Same pattern as `schedule-worker/` —
see that folder's README for the fuller explanation of why this shape
works. No API, no database: this page is fully static.

## Keep the copy in sync

**`public/index.html` is a copy, not a symlink.** Whenever `podcast.html`
changes, re-copy it and fix the two nav links that need to point back at
the main site instead of a local `index.html` (this file is served at the
subdomain's root, so a relative `index.html` link would 404):

```
cp ../podcast.html public/index.html
sed -i 's|href="index.html" class="nav-logo"|href="https://thetobaccocenter.com" class="nav-logo"|; s|href="index.html" class="nav-back"|href="https://thetobaccocenter.com" class="nav-back"|' public/index.html
```

Then redeploy (below).

## Deploy

From this folder, with `wrangler` authenticated against the same
Cloudflare account the other `ttc-*` workers live on:

```
wrangler deploy
```

That publishes the Worker as `ttc-podcast`, reachable immediately at
`https://ttc-podcast.<your-workers-dev-subdomain>.workers.dev` — no
custom domain needed to check it renders correctly before attaching one.

## Custom domain (e.g. podcast.thetobaccocenter.com)

There's no API for this — it's a one-time manual step in the dashboard:

1. Cloudflare dashboard → **Workers & Pages** → `ttc-podcast` →
   **Settings** → **Domains & Routes** → **Add** → **Custom Domain**.
2. Enter the subdomain (e.g. `podcast.thetobaccocenter.com`) and confirm.
   Cloudflare creates the DNS record and issues the SSL certificate
   automatically — this only works if `thetobaccocenter.com`'s DNS is
   already on this same Cloudflare account (it is — `thetobaccocenter.com`
   is already managed there, per the other `ttc-*` workers).

Once attached, that subdomain serves the page directly at `/` — no
separate hosting step needed. `thetobaccocenter.com/podcast.html` (the
copy served by the main `ttc-website-2026` Worker) keeps working too;
they're two independent copies of the same page.
