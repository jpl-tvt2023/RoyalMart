# Outbound — Manual QA Checklist

Pre-merge/pre-deploy regression pass for the outbound vendors + outbound purchase
orders feature. Run this against the test environment
(https://royalmartportalfrontend-test.vercel.app, backend
https://royalmartportal-test.vercel.app/api — both pinned to `feature/Rahul`)
before/after the merge to `main`. Covers UI behaviors the automated backend
suite (`tests/outboundVendors.test.js`, `tests/outboundPOs.test.js`) can't
reach — inline editing, exports, dropdown fallbacks, and history rendering.

No seeded user currently holds the `Purchase_Head` role, so a few checks below
need one-time setup via Admin → User Management: tag a test user
`Purchase_Head` before starting.

## Outbound Vendors page (`/outbound/vendors`)

- [ ] Add Vendor modal: switching a mapping row's Category clears that row's
      Item Name (no stale value survives a category switch).
- [ ] Choosing "Others" swaps the Item Name dropdown for a free-text input,
      live, mid-row.
- [ ] Client-side validation blocks submit (before hitting the network) for:
      empty name, zero article rows, a row with a blank item name.
- [ ] Duplicate name on save shows the 409 inline in the modal (not a toast).
- [ ] Deactivate (Power icon) has no confirm dialog — toggles immediately.
      Reactivate the same way. Status badge updates without a page reload.
- [ ] History drawer on a vendor shows create/update/deactivate entries with
      field diffs.
- [ ] **Known gap — confirm, don't debug**: do a Bulk Upload that touches an
      existing vendor, then open that vendor's History. The bulk action will
      **not** appear (bulk-upsert audit rows are written with no entity id, so
      the History endpoint can never retrieve them — confirmed in code, not a
      test bug). Decide if this needs a follow-up ticket.
- [ ] Download XLSX: columns are exactly `vendor_name, category, item_name,
      variant`. A vendor with zero mappings still exports one row (blank
      category/item_name), not a dropped vendor.
- [ ] Bulk Upload modal: only `.xlsx` accepted; Template button downloads
      headers + one sample row; after a successful upload the Upload button
      stays disabled until you close and reopen the modal (no double-submit).
- [ ] Round-trip: Download XLSX → edit a cell → re-upload via Bulk Upload →
      confirm `updated` vs `skipped: mapping already exists` counts match what
      you changed.

## Outbound PO List (`/outbound/purchase-orders`)

- [ ] **Inline grid editing** (qty/rate/received/short/Approved By edited
      directly in the list): editing a row marks it dirty (Save icon appears
      in Actions) without auto-saving. Two different rows track dirty state
      independently.
- [ ] **Save failure does not revert the edit.** On a PO with no Approved By
      set yet, edit a qty inline and click Save without picking an approver →
      expect the 400 toast, and confirm the qty you typed is still in the
      input (not reverted), so you can add the approver and retry without
      re-typing.
- [ ] After a successful inline save, the dirty flag clears and the Save icon
      disappears.
- [ ] Inline editing is fully disabled on a `Deleted` PO (no inputs, no Save
      icon path).
- [ ] Default filter view loads with Status = "Open" — Deleted/Closed rows are
      hidden until you explicitly pick "All" or "Deleted".
- [ ] **Approved By dropdown fallback**: using the `Purchase_Head`-tagged user
      you set up, approve a PO, then remove that role from the user via User
      Management. Reopen the PO list — the dropdown should still show that
      user, suffixed "(not Purchase Head)", not silently blank the approver.
- [ ] Sortable columns (id, vendor, status, po_date, approved_by, updated_at,
      updated_by) all actually re-sort, including the computed ones.
- [ ] Page-size choice persists across navigating away and back.
- [ ] **XLSX export** columns are exactly `order_no, vendor, company, status,
      approved_by, order_date, category, item_name, variant, qty, rate,
      received, short, pending, last_updated_by, last_updated_at`. Filter to
      more than one page of results and confirm the export includes ALL
      filtered rows, not just the visible page.
- [ ] A PO with zero lines exports one blank-article row, same as the vendor
      export fallback.

## Outbound PO Detail (`/outbound/purchase-orders/new` and `/:id`)

- [ ] **Vendor lock**: the Vendor dropdown is genuinely unclickable (not just
      greyed-out styling) on an existing PO — only selectable when creating a
      new PO.
- [ ] **Line grandfathering**: create a PO with a line, then edit that
      vendor's article config to remove that mapping, then reopen the PO. The
      removed line shows in the article dropdown labeled "(removed from
      vendor config)", stays selected and savable — but adding a brand-new
      line only offers currently-valid vendor mappings (the removed one isn't
      offered as a choice for a new line).
- [ ] Changing vendor on a new (unsaved) PO resets every line's article
      selection — no stale article survives the swap.
- [ ] Status field is read-only and live-previews as you edit received/short,
      before saving.
- [ ] Approved By is optional when creating a new PO, but required (blocked
      client-side, before any network call) when editing an existing one.
- [ ] A `Deleted` PO opened directly by URL is fully read-only: inputs
      disabled, Save/Cancel hidden.
- [ ] History drawer shows create + every update, including ones made via the
      List page's inline editor (both write through the same PATCH). Check
      whether `company_id`/`approved_by` diffs show a name or a raw numeric ID
      — currently these two fields aren't in the label-resolution map used by
      other entity types, so expect raw IDs unless that's been fixed.

## Receipt UM, Stitching columns, and the challan key

New in this change — see migrations `084` and `085`.

- [ ] **Add Receipt asks for UM**, sitting right after Received Qty and
      pre-filled with the line's own unit (`taga` on the two fabric articles).
      It is required — clearing it blocks submit client-side with "UM is
      required", before any network call.
- [ ] An article listed under ONE unit shows UM as a plain disabled box, not a
      one-item dropdown. An article listed under several shows a real select
      offering exactly those units.
- [ ] The saved receipt shows its UM in the new column **between Recd Qty and
      Qty in metres** on the PO detail grid. The "Add receipt" row still spans
      the full receipt block (colspan bumped to 12 — check nothing is off by
      one column).
- [ ] Editing a receipt keeps the stored UM rather than resetting to the line's.
      Changing it shows a `unit_metric` old → new diff in the History drawer.
- [ ] A receipt entered BEFORE this change shows the line's unit rather than a
      dash (migration 084 backfilled it).
- [ ] The Journey drawer no longer prints "entered by …".
- [ ] **Checked By / PCL Inc No**: a challan to Panchal asks for both, a
      challan to Third Party asks for Checked By + Outbound Bill No, and
      neither field appears on a challan to Stitching or Packing. The Checked
      By list holds Warehouse_POC users only.
- [ ] **Add Receipt no longer asks for Checked By.** Saving works without it,
      and the receipts table on the PO detail page shows your own name in the
      Checked By column (header no longer carries a `*`).
- [ ] Editing a receipt that was taken at a dozen stage (incl. Panchal) opens
      with its Dozens Received filled in and saves without retyping it.
- [ ] **Challan key**: raising the same challan number twice to the SAME party
      is refused with "Challan X has already been used for <party>" — including
      when the two are on different lots. The same number to a DIFFERENT party
      is accepted, even on one lot.
- [ ] Editing a challan onto a number+party pair that already exists is refused;
      renaming just the party onto a clashing pair is refused too.
- [ ] Withdrawing a challan still frees its number for re-entry to that party.

## Stages renamed, Gray removed, dozens from Stitching on, challan lines

New in this change — see migration `087` (run `node src/migrations/preflight-087.js`
first; it must report 0 Gray rows).

**Purchase orders**
- [ ] `/outbound/purchase-orders`: long Vendor, Category, Item Name and Variant
      values wrap onto a second line inside a narrower column instead of
      stretching the table sideways.
- [ ] PO Details: the Article column is narrower. On an approved (read-only) PO
      the article shows as wrapped text (category small and grey above
      `item · variant`); on an editable line it stays a dropdown and the full
      name shows on hover.
- [ ] Add Receipt on a fabric line opens with **Processing** pre-selected. The
      Stage list offers Processing, Stitching, Packing, Panchal — **no Gray**.
- [ ] Picking Panchal shows the hint "… this receipt will be recorded as
      Closed". After saving, the lot sits on the Panchal tab as **Closed**
      (untick the status filter to see it) and can be reopened.

**Stitching page**
- [ ] Tabs read **Processing, Stitching, Packing, Panchal, Third Party, All**.
      A session left on the old Gray tab opens on Processing, not blank.
- [ ] Every tab leads with **PO Party Name** (the vendor) and exactly one grey
      line under it: a Panchal lot sent out of Stitching by Mahakali creation
      reads `Stitching - MC` (the stage it LEFT); a lot booked straight in on a
      PO receipt reads `Direct from PO`. A multi-hop lot shows its latest hop
      plus `+N`, full chain on hover. With no Short Name set in Purchase Config
      it shows the party's initials. Every row keeps the same height.
- [ ] Nested challan rows read in one order with dots between the parts —
      `Challan 02 → Panchal · Mahakali creation · Fresh · sent 3570.5 dz ·
      [In Stock]` — the status is the only badge, and the destination lot's
      incoming no is not repeated there (it is on that stage's own tab).
- [ ] **PO No** sits between Article and Status on every tab (All included) and
      links to the PO. **PO Qty (m)** appears on every tab.
- [ ] Processing: Qty (m) and Balance (m). Stitching/Packing: Dozens, M/Dozen,
      Balance (dz). Panchal and Third Party: Dozens only — **no M/Dozen and no
      Balance**.
- [ ] Hovering **M/Dozen** explains where the figure came from; on a lot sent
      on from Stitching it says it was carried over from the Processing challan.
- [ ] There is one **Rate** column. Hovering it lists PO rate × m/dozen, each
      stage rate by name, and the total per dozen. A Processing lot's total is
      per metre and says why. The card is not clipped by the table edge.
- [ ] Purchase Config → Stitching Parties has a **Short Name** column/field
      (max 10 chars); clearing it falls back to initials.

**Add Challan**
- [ ] Add/Edit Challan: **Line Items sit right under Challan No and Party
      Name**; the rate, PCL Inc No, Checked By and Outbound Bill No follow below
      a light divider. Submitting an empty form reports errors top to bottom.
- [ ] From the **Processing** tab: the rate reads **"Processing rate (per
      dozen)"**; line items are Challan Type · Sent Qty (m) · Dozens Received ·
      Metre per Dozen. **Add line** adds a row; the **Total** row above the
      lines sums metres and dozens and shows the overall m/dozen.
- [ ] Two lines (Fresh 60 m / 30 dz, Second 20 m / 8 dz) create **two lots** on
      the Stitching tab, each with its own M/Dozen (2 and 2.5); the parent's
      balance falls by 80 m; under the parent the challan shows a total row
      above its two lines.
- [ ] Lines adding up to more than the balance are refused ("Cannot send 110m —
      only 100m is left on this lot"). A missing field on line 2 is reported as
      "Line 2: …".
- [ ] From the **Stitching** tab: rate reads "Stitching rate (per dozen)", and
      a line is only Challan Type · Dozens Sent. The lot that arrives at
      Packing holds exactly those dozens.
- [ ] Editing one line of a two-line challan and changing the rate or party
      changes it on **both** lines; changing the type changes only that line.
- [ ] Write-off from a Stitching lot is in dozens ("only 40 dozen is left").

## Copy issues (not functional bugs — flag, don't spend test time here)

- [ ] `frontend/src/utils/roles.js`: the "Purchase Orders" nav item
      (`/outbound/purchase-orders`) still describes itself as "Supplier
      purchase orders (coming soon)" even though the page is fully built.
- [ ] Same file: "Outbound Vendors" nav item still says "Supplier master
      (coming soon)".

## Cross-cutting sanity (given this merge also carries ~100 other commits)

- [ ] Login works for each seeded/real role at least once; dashboard loads.
- [ ] Spot-check one flow each in Procurement, GRN, Builty, Order Summary,
      Products — confirm nothing outbound-adjacent (shared components:
      `Pagination`, `HistoryDrawer`, `NavDropdown`, session-state filters)
      regressed for other pages that also use them.
