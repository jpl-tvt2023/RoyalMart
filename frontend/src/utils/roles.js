export const ROLES = {
  ADMIN: 'Admin',
  OWNER: 'Owner',
  OFFICE_POC: 'Office_POC',
  PURCHASE_TEAM: 'Purchase_Team',
  STOCKS_TEAM: 'Stocks_Team',
  PO_EXECUTIVE: 'PO_Executive',
};

export const NAV_MAP = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.STOCKS_TEAM, ROLES.PO_EXECUTIVE],
  },
  {
    label: 'User Management',
    path: '/admin/users',
    roles: [ROLES.ADMIN, ROLES.OWNER],
  },
  {
    label: 'Team Management',
    path: '/admin/teams',
    roles: [ROLES.ADMIN, ROLES.OWNER],
  },
  {
    label: 'SKU Master',
    path: '/skus',
    roles: [ROLES.ADMIN, ROLES.OWNER],
  },
  {
    label: 'Inventory',
    path: '/inventory',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.STOCKS_TEAM],
  },
  {
    label: 'Restock (Supplier POs)',
    path: '/restock',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.PURCHASE_TEAM, ROLES.STOCKS_TEAM],
  },
  {
    label: 'Packaging Materials',
    path: '/packaging',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.STOCKS_TEAM],
  },
  {
    label: 'Products',
    path: '/products',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.STOCKS_TEAM, ROLES.PO_EXECUTIVE],
  },
  {
    label: 'Purchase Orders',
    path: '/purchase-orders',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.PO_EXECUTIVE],
  },
];
