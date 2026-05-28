export const ROLES = {
  ADMIN: 'Admin',
  OWNER: 'Owner',
  OFFICE_POC: 'Office_POC',
  PURCHASE_TEAM: 'Purchase_Team',
  WAREHOUSE_POC: 'Warehouse_POC',
  PO_EXECUTIVE: 'PO_Executive',
};

export const NAV_MAP = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.WAREHOUSE_POC, ROLES.PO_EXECUTIVE],
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
    label: 'Products',
    path: '/products',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.WAREHOUSE_POC, ROLES.PO_EXECUTIVE],
  },
  {
    label: 'Purchase Orders',
    path: '/purchase-orders',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.PO_EXECUTIVE],
  },
  {
    label: 'Order Summary',
    path: '/order-summary',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.PO_EXECUTIVE],
  },
  {
    label: 'Builty',
    path: '/builty',
    roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.PO_EXECUTIVE],
  },
  {
    label: 'Configurations',
    path: '/configurations',
    roles: [ROLES.ADMIN, ROLES.OWNER],
  },
];
