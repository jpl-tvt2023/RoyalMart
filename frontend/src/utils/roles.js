import {
  LayoutDashboard, ClipboardList, Package, Truck, ClipboardCheck,
  Tag, Settings, Users, UsersRound, SlidersHorizontal,
  ShoppingCart, PackageSearch,
} from 'lucide-react';

export const ROLES = {
  ADMIN: 'Admin',
  OWNER: 'Owner',
  EMPLOYEE: 'Employee',
  OFFICE_POC: 'Office_POC',
  WAREHOUSE_POC: 'Warehouse_POC',
};

// Base access roles: Admin/Owner = everything, Employee = everything except the Admin section.
// Office_POC / Warehouse_POC are assignment-qualifier tags, not access roles.
export const BASE_ROLES = [ROLES.ADMIN, ROLES.OWNER, ROLES.EMPLOYEE];
export const POC_ROLES = [ROLES.OFFICE_POC, ROLES.WAREHOUSE_POC];

export const ALL_ROLES = [...BASE_ROLES, ...POC_ROLES];
const ORDER_FLOW_ROLES = ALL_ROLES;
export const ADMIN_ONLY = [ROLES.ADMIN, ROLES.OWNER];

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
        roles: ALL_ROLES,
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
    label: 'Purchase',
    icon: ShoppingCart,
    children: [
      {
        label: 'Procurement',
        path: '/procurement',
        icon: PackageSearch,
        description: 'Raw materials needed for pending POs',
        roles: ALL_ROLES,
      },
    ],
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
