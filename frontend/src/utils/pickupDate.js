// Amazon and Flipkart POs carry a pre-agreed pickup date instead of an expiry
// date. Keep this list in sync with PICKUP_DATE_VENDORS in the backend
// marketplacePO.controller. Since the two dates are mutually exclusive per
// vendor, the effective date is simply whichever one is set.
export const PICKUP_DATE_VENDORS = ['Amazon', 'Flipkart'];

export const usesPickupDate = (vendor) => PICKUP_DATE_VENDORS.includes(vendor);

// The effective expiry/pickup date for a PO row (mirrors the backend
// COALESCE(pickup_date, po_expiry_date) column, with a client-side fallback).
export const effectiveExpiry = (po) =>
  po?.expiry_or_pickup ?? po?.pickup_date ?? po?.po_expiry_date ?? null;
