// Builty Bill No -- the Tally sales invoice number a marketplace PO was billed
// on. Globally unique while set (partial UNIQUE index, migration 024).
//
// RAMS writes Tally's numbers into ROMS exactly as Tally prints them --
// 607/RM/26-27 -- so '/' is allowed alongside letters, digits and dashes. The
// whole number is also what keeps the UNIQUE index honest across years: the
// bare serial staff used to type (607) comes round again every April.
//
// One rule for both writers: the Builty PATCH (orderSummary.controller.js) and
// the Tally auto-fill (integration.controller.js). Neither may accept a number
// the other would refuse.
const BILL_NO_RE = /^[A-Za-z0-9/-]+$/;
const BILL_NO_MESSAGE = 'Bill no may contain only letters, digits, dashes and slashes';

// A trimmed, non-empty bill no -> error string or null.
const billNoError = (billNo) => (BILL_NO_RE.test(billNo) ? null : BILL_NO_MESSAGE);

// Live POs other than `poId` already carrying `billNo`. A Deleted PO keeps its
// bill no but is no longer a conflict here.
async function billNoConflicts(client, billNo, poId) {
  const { rows } = await client.execute({
    sql: "SELECT po_id, vendor, vendor_po_id FROM marketplace_pos WHERE bill_no = ? AND po_id != ? AND status <> 'Deleted'",
    args: [billNo, poId],
  });
  return rows;
}

const isBillNoUniqueViolation = (err) => Boolean(err && err.message
  && err.message.includes('UNIQUE constraint failed: marketplace_pos.bill_no'));

module.exports = { BILL_NO_RE, BILL_NO_MESSAGE, billNoError, billNoConflicts, isBillNoUniqueViolation };
