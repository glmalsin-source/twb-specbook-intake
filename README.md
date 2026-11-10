# twb-specbook-intake

The questionnaire Spec Book buyers fill out after purchase, before their review starts.
Same look and engine as the contractor form (`twb-builder-form`), about 10 minutes for the homeowner.

## Files

| File | What it is |
|---|---|
| `index.html` | The form. Edit questions in `FORM_SCHEMA`. Ids match `plan-review-engine/standard/data/intake.json`. |
| `apps_script.gs` | Backend: writes to the "TWB Spec Book Intake" Sheet, emails greg@ and rachel@, sends the homeowner a copy and the builder link. Setup steps are at the top of the file. |
| `shopify-order-confirmation.liquid` | Block for the Shopify order confirmation email that links Spec Book buyers to the form. |
| `CNAME` | `specbook.thewellbuild.com` for GitHub Pages. |

## How it works

1. A Spec Book buyer gets the order confirmation email with a **Start your intake** button (`?order=1042`).
2. The homeowner answers Part 1 and says how the drawings will arrive.
3. The technical questions (Part 2) are either answered on the spot with the builder or architect, or
   the homeowner gets a **builder link** (`?builder=<token>`) to forward. That link opens only Part 2,
   with no login, and the answers land in the same Sheet row (`builder_status` → Received).
4. Greg and Rachel get one email per submission, and one when builder answers arrive.

## Draft mode

While `APPS_SCRIPT_URL` in `index.html` is blank, nothing is sent: a band at the top says so, and
"Send my answers" shows a preview instead. Add `?builder=test` to the URL to see the builder view.

## Going live (checklist)

1. Create the Sheet and deploy `apps_script.gs` (steps at the top of that file). Run `testSubmit` and `testBuilderSubmit` first.
2. Paste the Web App URL into `APPS_SCRIPT_URL` in `index.html`.
3. Push this repo to GitHub, turn on Pages (main, root), and set the custom domain.
4. DNS: add a CNAME record `specbook` → `glmalsin-source.github.io` (same as `builderform`).
5. Paste `shopify-order-confirmation.liquid` into the Shopify order confirmation template and place a test order.
