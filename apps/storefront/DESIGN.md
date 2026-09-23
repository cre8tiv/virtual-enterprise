# Storefront Design

The fictional company's public website and customer portal. It gives the environment a real web presence, a web-originated order stream, customer identity separate from workforce identity, and web analytics. See the environment design in [../../DESIGN.md](../../DESIGN.md).

Status: **Design** (2026-09-23)

---

## 1. Goals & Constraints

- **$0 hosting.** No paid plans for hosting or compute.
- **Static only.** The site is a static export with no application server. All dynamic behavior runs in the browser against APIs designed for browser use.
- **No secrets in the browser.** Only public/publishable keys ship to the client. Anything requiring a secret runs in a Supabase Edge Function.
- **Security in the data layer.** Client-side route guards are UX only; Postgres row-level security (RLS) is the real access control.
- **Catalog changes don't require a rebuild.** The simulator and loaders change products and prices; the site reads them at runtime.
- **Deterministic seeding.** Customer accounts come from the canonical dataset so expected answers stay stable.
- **Non-goals:** SEO, server-side rendering, performance at real-world scale, real payments.

## 2. Architecture

```
                         ┌───────────────────────────────────────────────┐
Browser ── static site ──┤ Shopify Storefront API (public token)         │ catalog, cart, checkout URL
  (Cloudflare, free)     │ Supabase Auth (publishable key)               │ customer sign-up / login
                         │ Supabase Postgres via PostgREST + RLS         │ profile, orders mirror, support requests
                         │ Supabase Edge Function: link-customer (JWT)   │ link Supabase user ↔ Shopify customer
                         │ GA4 gtag                                      │ page views + ecommerce events
                         └───────────────────────────────────────────────┘
Checkout ──> Shopify hosted checkout (Bogus Gateway on dev store)

Shopify webhooks (orders/*, refunds/*) ──> Edge Function: shopify-webhook
      ├─ verify HMAC
      ├─ upsert orders / order_lines mirror in Postgres
      └─ send GA4 Measurement Protocol `purchase` / `refund`
```

## 3. Technology Decisions

| Area | Choice | Notes |
|---|---|---|
| Framework | **Next.js** (App Router), `output: 'export'` | Static HTML/JS only. No route handlers, middleware, server actions, or ISR. |
| Language | **TypeScript** (strict) | |
| Hosting | **Cloudflare Workers static assets** (`wrangler deploy`) | Free; static asset requests are not billed and don't count against Worker CPU limits. `www.<domain>` custom domain; apex → `www` redirect rule. |
| Commerce API | **Shopify Storefront API** (GraphQL) with public access token | Products, collections, Cart API; checkout via `cart.checkoutUrl` (Shopify-hosted). |
| Customer identity | **Supabase Auth** via `@supabase/supabase-js` | Email + password (seeded accounts); magic link optional. Session held client-side. |
| Portal data | **Supabase Postgres** via PostgREST | RLS on every table; the browser uses the publishable (anon) key only. |
| Server-side logic | **Supabase Edge Functions** (Deno) | The only code that holds secrets. Free tier. |
| Analytics | **GA4** (gtag) + **Measurement Protocol** | Client events for browsing/cart; server-side `purchase`/`refund` from the webhook (reliable, not blockable). |
| Styling | **Tailwind CSS** | |
| Images | `next/image` with `unoptimized: true` | Static export has no image optimizer; Shopify CDN serves resized images via URL params. |
| Unit tests | **Jest** + React Testing Library | |
| E2E tests | **Playwright** | Same scripts reused by the simulator's synthetic sessions. |
| Package manager | **npm** | |

## 4. Routing

Static export requires every route to exist at build time. To avoid rebuilding when the catalog changes, product and collection pages are **single static shells that read an identifier from the query string** and fetch client-side.

| Route | Rendering | Auth |
|---|---|---|
| `/` | Static marketing content | Public |
| `/about`, `/contact` | Static | Public |
| `/catalog/?collection=<handle>&page=<n>` | Client fetch (Storefront API) | Public |
| `/product/?handle=<handle>` | Client fetch (Storefront API) | Public |
| `/cart/` | Client (Cart API; cart ID in `localStorage`) | Public |
| `/login/`, `/signup/`, `/reset-password/` | Client (Supabase Auth) | Public |
| `/account/` | Client (profile) | Signed in |
| `/account/orders/?id=<order>` | Client (orders mirror) | Signed in |
| `/account/support/` | Client (support requests) | Signed in |

B2B pricing, if added later, uses Shopify customer-specific catalogs or metafields read via the Storefront API.

## 5. Data Model (Supabase Postgres)

All tables live in `public` with RLS enabled. Customers can only read their own rows; writes from the browser are limited to `support_requests` and profile fields.

| Table | Key columns | Written by | Browser access |
|---|---|---|---|
| `customers` | `id` (= `auth.users.id`), `email`, `canonical_contact_id`, `canonical_account_id`, `shopify_customer_id`, `crm_account_id`, `display_name`, `company_name` | Seeder, `link-customer` | Read own; update `display_name` |
| `orders` | `id`, `shopify_order_id`, `customer_id`, `status`, `financial_status`, `fulfillment_status`, `currency`, `total`, `created_at` | `shopify-webhook` | Read own |
| `order_lines` | `order_id`, `sku`, `title`, `quantity`, `unit_price` | `shopify-webhook` | Read own (via order) |
| `support_requests` | `id`, `customer_id`, `order_id` (nullable), `subject`, `body`, `status`, `created_at` | Browser, simulator | Insert/read own |
| `webhook_events` | `id`, `topic`, `shopify_webhook_id` (unique), `received_at`, `payload` | `shopify-webhook` | None |

- `webhook_events.shopify_webhook_id` makes webhook processing idempotent (Shopify retries).
- Cross-system IDs (`canonical_*`, `crm_account_id`) let the SUT join portal data with CRM, ERP, and on-prem data.
- Support requests are later pushed to ServiceNow by the simulator, creating a portal → ITSM flow.

## 6. Edge Functions

| Function | Trigger | Auth | Does |
|---|---|---|---|
| `link-customer` | Browser, after sign-up/login | Supabase user JWT | Finds or creates the Shopify customer by email (Admin API); stores `shopify_customer_id`. No-op if already linked. |
| `shopify-webhook` | Shopify `orders/create`, `orders/updated`, `orders/fulfilled`, `refunds/create` | Shopify HMAC signature | Dedupe via `webhook_events`; upsert `orders`/`order_lines`; map to `customers` by Shopify customer ID, falling back to email; send GA4 Measurement Protocol event. |

**Order ↔ customer linking:** the cart sets `buyerIdentity.email` (and customer access token when available) so Shopify attaches the order to the linked customer.

## 7. Configuration & Secrets

| Value | Where | Exposure |
|---|---|---|
| Shopify store domain, Storefront API public token | Build-time env (`NEXT_PUBLIC_*`) | Public by design |
| Supabase URL, publishable (anon) key | Build-time env (`NEXT_PUBLIC_*`) | Public by design (RLS enforced) |
| GA4 measurement ID | Build-time env (`NEXT_PUBLIC_*`) | Public by design |
| Shopify Admin API token | Edge Function secret | Secret |
| Shopify webhook signing secret | Edge Function secret | Secret |
| GA4 Measurement Protocol API secret | Edge Function secret | Secret |
| Supabase service role key | Edge Function runtime (built in); seeder only | Secret |

All values come from the operator vault; `NEXT_PUBLIC_*` values are injected at build time, never committed.

## 8. Seeding & Simulation

- **Seeder** (runs with the canonical loaders): for each canonical customer contact, creates a Supabase Auth user (admin API, generated password stored in the vault's `Customers` group), a `customers` row with cross-system IDs, and the matching Shopify customer.
- **Simulator:** Playwright sessions log in as seeded customers, browse, add to cart, check out (Bogus Gateway), and file support requests. Produces GA4 traffic, Shopify orders, webhook-driven mirror rows, and portal data.

## 9. Repository Layout

```
apps/storefront/
  DESIGN.md
  app/                 Next.js App Router pages (static shells)
  components/
  lib/
    shopify/           Storefront API client, GraphQL queries, cart
    supabase/          browser client, typed queries
    analytics/         gtag wrapper, ecommerce event helpers
  public/
  supabase/
    migrations/        schema + RLS policies
    functions/
      link-customer/
      shopify-webhook/
    seed/              seed helpers used by loaders
  tests/
    unit/              Jest
    e2e/               Playwright (shared with simulator)
  next.config.ts       output: 'export', images.unoptimized
  wrangler.jsonc       static assets config, custom domain
  .env.example
```

## 10. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-23 | Static export, no SSR | $0 hosting; every API used is browser-safe; SEO is a non-goal. |
| 2026-09-23 | Host on Cloudflare Workers static assets | Free, same vendor as DNS/edge. Rejected: Vercel (Hobby is non-commercial), Workers with OpenNext SSR (likely needs Workers Paid), Azure Static Web Apps (needs an Azure subscription; hybrid Next.js still in preview). |
| 2026-09-23 | Webhooks and secret-bearing logic in Supabase Edge Functions | Only server-side component needed; free; co-located with the data. |
| 2026-09-23 | Query-string product/collection shells instead of pre-rendered pages | Catalog changes don't require a rebuild; keeps the static file count small. |
| 2026-09-23 | GA4 `purchase`/`refund` sent server-side via Measurement Protocol | Webhook is the reliable source of truth for completed orders. |
| 2026-09-23 | Shopify owns catalog/checkout/orders; Supabase owns customer login and portal data | Clear systems of record; Supabase mirrors orders for the portal and as an extra data source. |

## 11. Open Questions

- [ ] **Shopify dev store:** confirm the Storefront API and hosted checkout work while the dev store's online-store password is enabled; confirm Bogus Gateway test orders fire webhooks.
- [ ] **Shopify customer accounts:** classic vs new customer accounts; affects whether a customer access token can be set on the cart.
- [ ] **Supabase key naming:** use the newer publishable/secret API keys if available on the project; otherwise anon/service role.
- [ ] **Supabase Auth email:** default SMTP (rate-limited) vs M365 `ops@<domain>` SMTP.
- [ ] **GA4 bot filtering:** confirm Playwright sessions are counted; otherwise rely on Measurement Protocol for volume.
- [ ] **Supabase inactivity pause:** confirm daily simulator traffic keeps the free project active.
