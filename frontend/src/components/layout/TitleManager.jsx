import { useEffect } from 'react';
import { useLocation, matchPath } from 'react-router-dom';

const BRAND = 'Royal Mart';

// Route -> page title. `null` means just the brand (dashboard / fallback).
// Order matters: most-specific paths first so e.g. `/purchase-orders/new`
// wins over `/purchase-orders/:poId` over `/purchase-orders`.
const TITLES = [
  ['/login', 'Login'],
  ['/force-reset', 'Reset Password'],
  ['/dashboard', null],
  ['/admin/users', 'User Management'],
  ['/products', 'SKU Products'],
  ['/procurement', 'Procurement Status'],
  ['/purchase-orders/new', 'Import PO'],
  ['/purchase-orders/:poId', (m) => `PO ${m.params.poId}`],
  ['/purchase-orders', 'Purchase Orders'],
  ['/order-summary', 'Order Summary'],
  ['/builty', 'Builty'],
  ['/grn', 'GRN'],
  ['/configurations', 'Configurations'],
  ['/outbound/purchase-orders', 'Outbound Purchase Orders'],
  ['/outbound/vendors', 'Outbound Vendors'],
];

function resolveTitle(pathname) {
  for (const [pattern, title] of TITLES) {
    const match = matchPath({ path: pattern, end: true }, pathname);
    if (match) return typeof title === 'function' ? title(match) : title;
  }
  return null;
}

// Render-null component: keeps the document/tab title in sync with the route.
export default function TitleManager() {
  const { pathname } = useLocation();

  useEffect(() => {
    const title = resolveTitle(pathname);
    document.title = title ? `${title} · ${BRAND}` : BRAND;
  }, [pathname]);

  return null;
}
