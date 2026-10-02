# Feedback V2 review

Base: latest `feature/feedback-v2` at review start (`7bc6e86`). Review changes are on `fix/feedback-v2-review`; do not deploy `main` assuming it contains Feedback V2.

## Invariants and fixes

- Original feedback and attachment storage remain immutable. Public descriptions use only curated fields; blank/null public copies never fall back to private originals. Legacy publications without a curated copy may now show blank text until the administrator saves their public copy.
- Both V2 and legacy lookup enforce visibility. Legacy BETA lookup no longer aliases a TestFlight internal tracking number. Deleted lookup returns no publication payload.
- New public images must be flattened in the editor before enabling visibility. Re-enabling an existing derivative does not require the original. Existing R2 objects are retained, including superseded derivatives; no automatic object deletion is performed.
- Optimistic image save rejects concurrent replacement/unpublishing with 409. Editor generation checks isolate asynchronous image loads/saves; preview loading has per-container tokens. Undo stores edited regions with a 64 MiB history budget (one large region may exceed that budget).
- JSON bodies are streamed with a 64 KiB limit; image uploads have a 15 MiB limit. Null/array JSON is rejected. Comments remain unverified claims, have atomic per-report limits (10/minute), and suppress identical comments for one minute. This is basic abuse control, not distributed bot protection.
- Feedback and TestFlight attachment metadata commit in one D1 transaction. Failed ingestion returns 503 rather than acknowledging success. Duplicate external resources remain idempotent. Failed R2 writes no longer claim a nonexistent storage key. Remote fallback/expiry handling remains available.
- Clean databases get missing legacy publication columns through additive schema initialization; concurrent column initialization is safe. A new additive `feedback_requests` table records idempotency keys and hashes for website retries. No new numbered migration or secret is required; the Worker creates the table automatically. Existing migrations remain required for a new database.
- Public attachment lookups are chunked to stay under D1's 100 bound-parameter limit: https://developers.cloudflare.com/d1/platform/limits/
- Removed the uncalled legacy content editor and its private textarea helper/CSS. The compatibility API remains for old clients, restricted to public copy fields.

## Validation

Node 24: `npm ci`, `npm run check`, `npm test`.

Browser: `npx playwright install chromium`, then `npm run test:browser`; `BROWSER_CHANNEL=chrome` uses installed Chrome. Tests execute the actual dashboard JS and full-resolution Canvas, with mocked network responses. API tests use real SQLite SQL with D1/R2 adapters and simulated ASC responses. They are not production integration tests.

Build: `npm run build` uses `wrangler deploy --dry-run`; it does not deploy or migrate production. PR CI repeats the same checks.

## Deployment and remaining manual checks

Merge the review PR into `feature/feedback-v2` and use the existing manual deployment procedure. No production D1/R2 changes have been executed during review. No secrets added. Do not reset D1 or delete existing R2 images.

On iPhone Safari verify nested modal scrolling, keyboard, rotation, pinch gestures, and image reload after saving. Desktop browser tests cannot establish iOS behavior. Verify Cloudflare Access protects `/dashboard` and every `/dashboard/*` path; the Worker relies on that existing edge configuration. Live Apple webhook delivery/retry timing and expired screenshots still require a real TestFlight submission.

The existing website submission UI supports text and manually pasted app diagnostics; it does not provide a generic screenshot uploader. Multiple-image ingestion is currently the TestFlight path. Website retries in the same page reuse an idempotency key; legacy clients that omit that key and reloading the page do not get this guarantee. Historical partial TestFlight imports are not rewritten automatically.
