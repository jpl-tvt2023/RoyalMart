import {
  LayoutDashboard, ClipboardList, Package, Truck, ClipboardCheck,
  Tag, Settings, Users, UsersRound, SlidersHorizontal,
} from 'lucide-react';

export const ROLES = {
  ADMIN: 'Admin',
  OWNER: 'Owner',
  OFFICE_POC: 'Office_POC',
  PURCHASE_TEAM: 'Purchase_Team',
  WAREHOUSE_POC: 'Warehouse_POC',
  PO_EXECUTIVE: 'PO_Executive',
};

const ALL_ROLES = [
  ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC,
  ROLES.PURCHASE_TEAM, ROLES.WAREHOUSE_POC, ROLES.PO_EXECUTIVE,
];
const ORDER_FLOW_ROLES = [ROLES.ADMIN, ROLES.OWNER, ROLES.OFFICE_POC, ROLES.PURCHASE_TEAM, ROLES.PO_EXECUTIVE];
const ADMIN_ONLY = [ROLES.ADMIN, ROLES.OWNER];

/**
 * Grouped navigation. Each entry is either a LEAF
 *   { label, path, icon, description?, roles }
 * or a GROUP
 *   { label, icon, children: [leaf, ...] }
 * A group is visible when at least one child is visible to the user.
 * Roles are copied verbatim from the previous flat NAV_MAP so access is identical.
 */
export const NAV = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    icon: LayoutDashboard,
    roles: ALL_ROLES,
  },
  {
    label: 'Orders',
    icon: ClipboardList,
    children: [
      {
        label: 'Purchase Orders',
        path: '/purchase-orders',
        icon: ClipboardList,
        description: 'Import & manage marketplace POs',
        roles: [ROLES.ADMIN, ROLES.OWNER, ROLES.PO_EXECUTIVE],
      },
      {
        label: 'Order Summary',
        path: '/order-summary',
        icon: Package,
        description: 'Dispatch, courier & tracking',
        roles: ORDER_FLOW_ROLES,
      },
      {
        label: 'Builty',
        path: '/builty',
        icon: Truck,
        description: 'Transport / LR documents',
        roles: ORDER_FLOW_ROLES,
      },
      {
        label: 'GRN',
        path: '/grn',
        icon: ClipboardCheck,
        description: 'Goods receipt & discrepancies',
        roles: ORDER_FLOW_ROLES,
      },
    ],
  },
  {
    label: 'Products',
    path: '/products',
    icon: Tag,
    roles: ALL_ROLES,
  },
  {
    label: 'Admin',
    icon: Settings,
    children: [
      {
        label: 'User Management',
        path: '/admin/users',
        icon: Users,
        description: 'Accounts, roles & access',
        roles: ADMIN_ONLY,
      },
      {
        label: 'Team Management',
        path: '/admin/teams',
        icon: UsersRound,
        description: 'Warehouse teams & members',
        roles: ADMIN_ONLY,
      },
      {
        label: 'Configurations',
        path: '/configurations',
        icon: SlidersHorizontal,
        description: 'Cities, vendors & masters',
        roles: ADMIN_ONLY,
      },
    ],
  },
];
