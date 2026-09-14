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
- [ ] **Stitching page**: the quantity column header reads **Qty in metres**;
      there is no **Checked By** column and no **Short** column on any tab
      (Gray, Processed, Stitched, Packed, Panchal, Third Party, All). Stitched
      and Packed still add Dozens + M/Dozen, Third Party still adds Outbound
      Bill No, and the columns still line up with their headers on every tab.
- [ ] The Journey drawer no longer prints "entered by …".
- [ ] Download XLSX from a Stitching tab: no `Checked By` and no `Short`
      column, and the quantity column is headed `Qty in metres`.
- [ ] **Add Challan has no Received Qty field.** After sending, the lot's
      Balance falls by the sent quantity and the nested challan row reads
      `sent …` with no `back …` and no `… short`.
- [ ] The challan rate field reads **"Rate for Processed"** (not "Processed
      Rate") on a Gray → Processed challan, and its hint says it shows as
      Processed Rate. The value still lands in the **Processed Rate** column,
      and **Gray Rate still comes from the PO receipt's Process Rate** — the
      ladder did not move.
- [ ] At Stitched/Packed the rate label reads "Rate for Packed (per dozen)" and
      Metre per Dozen is derived from **Sent Qty** divided by Dozens.
- [ ] **Challan key**: raising the same challan number twice to the SAME party
      is refused with "Challan X has already been used for <party>" — including
      when the two are on different lots. The same number to a DIFFERENT party
      is accepted, even on one lot.
- [ ] Editing a challan onto a number+party pair that already exists is refused;
      renaming just the party onto a clashing pair is refused too.
- [ ] Withdrawing a challan still frees its number for re-entry to that party.

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
