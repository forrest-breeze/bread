# Bread portal sub-folder proxy

> **Public mirror:** the in-app "Connect Cloudflare" button deploys from
> https://github.com/<your-org>/bread-cloudflare-proxy because Cloudflare's
> deploy flow can only fetch public repos. After changing files here, copy them
> to a clone of the mirror and push — otherwise customers deploy stale code.

This Cloudflare Worker mounts one Bread portal below a path on an existing
website, such as `customer.com/docs`, without changing the site's DNS target or
replacing its homepage.

## Deploy

1. Deploy this directory with Cloudflare's **Deploy to Cloudflare** flow.
2. Open **Settings → Variables and Secrets** and replace the three example
   Worker variables with the values shown by Bread:
   - `EXPECTED_HOST` — `customer.com`
   - `BREAD_ORIGIN` — `https://app.example.com`
   - `BREAD_ROUTES` — `{\"/docs\":\"/p/<workspace>/docs\",\"/help\":\"/p/<workspace>/help\"}`
3. In **Workers & Pages → your Worker → Settings → Domains & Routes**, add two
   Worker Routes per project path for the existing Cloudflare zone:
   - `customer.com/docs`
   - `customer.com/docs/*`
4. Keep the zone's existing proxied A/CNAME records. Do not point the root
   domain at Bread.

Repeat those two exact/child routes for every entry in `BREAD_ROUTES`. Using
exact routes instead of `customer.com/docs*` prevents the Worker from capturing
unrelated paths such as `/docs-old`.

The template sets `keep_vars` so later source-code deployments preserve the
customer-specific variables configured in Cloudflare.

## How it proxies

The Worker preserves the browser-visible path, request method, query string,
and request body. It maps each customer mount in `BREAD_ROUTES` directly to
its stable portal path, avoiding canonical-address redirect loops, and sends the
external host and mount path so Bread renders links below the customer path.
The Worker also rewrites Bread redirects back to the customer's URL.

## Local validation

Run `npm test`. Do not put credentials in this Worker; all three settings are
non-secret routing values.
