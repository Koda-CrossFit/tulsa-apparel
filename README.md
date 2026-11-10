# Koda Tulsa Apparel Preorder

The preorder store for Koda CrossFit Tulsa: https://koda-crossfit.github.io/tulsa-apparel/

Four designs, seven garments. Tees are $25, the camo tee is $30, the camo long sleeve is $40, and the hoodies are $50. People pay by having it billed to their PushPress account or by Venmo to @Senorespy. The store takes orders until **Sunday, December 6, 2026 at 11:59 PM Central**, and everything is picked up at the gym.

| Design | Garment | Brand | Color | Sizes | Price |
|---|---|---|---|---|---|
| Koda Grizz | Tee | Bella+Canvas | Vintage White | XS–3XL | $25 |
| Koda Bronco | Camo Tee | Independent | Deadwood Camo | XS–3XL | $30 |
| Koda Bronco | Camo Long Sleeve | Independent | Deadwood Camo | XS–3XL | $40 |
| Koda Bronco | Camo Hoodie | Independent | Deadwood Camo | XS–3XL | $50 |
| Koda United Kingdom | Tee | Bella+Canvas | Black | XS–3XL | $25 |
| Koda United Kingdom | Hoodie | Independent | Black | XS–3XL | $50 |
| Koda University | Tee | Comfort Colors | Bay or Berry | S–3XL | $25 |

## How it works

- `index.html` is the whole store page. GitHub Pages serves it from `main`, so a push is live in about a minute.
- Orders go to a small Google Apps Script (`apps-script/Code.js`) that runs as kevschuetz3@gmail.com. It checks every order against its own price list (the page never sets a price), numbers it `KT-1001`, `KT-1002`, … and writes it to the Google Sheet it's attached to: **Koda Tulsa Apparel Preorder — Orders**, https://docs.google.com/spreadsheets/d/1OzEEQo238fERGIFq6eI2z902rAvxeA528LJQn-cYUEo/edit
- Nobody gets an email when an order comes in. The only email is the **weekly summary**: every Monday at 8 AM Central to the address on the Settings tab (chris@kodacrossfittulsa.com), with one final summary the Monday after the store closes. Then it stops by itself.

## The sheet

| Tab | What it's for |
|---|---|
| Orders | One row per order. Check **Paid** once you've charged their PushPress account or the Venmo has come in, and **Picked Up** when they get their gear. Items, Pieces and Total are formulas that read Order Lines. |
| Order Lines | One row per item. Change a size, color or quantity here and Orders and Totals follow. |
| Totals | What to order from the printer, by item, color and size, plus the money by payment type. |
| Settings | **Orders close** (change it to extend the preorder or close early; the site follows within a minute or two) and **Weekly summary to** (comma-separated; blank stops the emails). |
| About | The same notes, for whoever opens the sheet. |

To cancel an order, delete its row on Orders and its rows on Order Lines. Order numbers are never reused. To add an order for someone, place it for them on the store. Don't rename the tabs or headers: the script finds them by name.

## Changing the store

- **Words, photos, layout:** edit `index.html` and push.
- **A price, size or new item:** change `DESIGNS` in `index.html` *and* `CATALOG` in `apps-script/Code.js` (the script is what actually sets prices), then deploy the script (below) and push. The Totals tab is laid out when the sheet is first set up, so a new item also needs a row there.
- **Mockups** are in `assets/products/`. `tools/make-assets.js` re-renders the favicons and the link-preview image (`assets/og-image.jpg`).

## Deploying the script

From `apps-script/`, with clasp signed in as kevschuetz3@gmail.com:

```
clasp push --force
clasp create-version "what changed"
clasp update-deployment AKfycbxIViWiqdWGze2y5mL6FQ1LhMdD2o9OQD7yTvZhIpbeU9N5qvdVq0j-0ObedoIEIdzj -V <new version> -d "Koda Tulsa Apparel store"
```

Updating that deployment keeps the web app URL that `index.html` calls. `clasp create-deployment` would make a new URL instead. `--force` matters whenever `appsscript.json` changed.

`setup()` lays out the sheet and makes the Monday trigger. It's safe to run again: it only fills in missing tabs and remakes the trigger.

## Testing

- `node tools/test-ui.js` clicks through the store at desktop and phone width against a fake backend (no real orders) and saves screenshots to `tools/out/`.
- `node tools/live-check.js` places clearly fake "Test Order" orders on the live store and backend, checks the sheet, previews the summary email, then deletes the test orders and resets the counter (only when no real orders exist). Don't run it once real orders are coming in unless you mean to.
- `node tools/admin.js <action>` sends one admin request to the live script: `adminList`, `adminDelete`, `adminResetCounter`, `adminSummaryPreview`, `adminShare`, `adminEditors`, `adminSetup`.

Admin requests need the admin key in `Desktop\Claude\Credentials - SENSITIVE Do Not Share\koda-tulsa-apparel-admin-key.txt`. Only its SHA-256 is in the code.
