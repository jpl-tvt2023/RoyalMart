import {
  LayoutDashboard, ClipboardList, Package, Truck, ClipboardCheck,
  Tag, Settings, Users, SlidersHorizontal,
  ShoppingCart, PackageSearch, PackageOpen, Send, Store, Building2,
} from 'lucide-react';

export const ROLES = {
  ADMIN: 'Admin',
  OWNER: 'Owner',
  EMPLOYEE: 'Employee',
  OFFICE_POC: 'Office_POC',
  WAREHOUSE_POC: 'Warehouse_POC',
  PURCHASE_HEAD: 'Purchase_Head',
};

// Base access roles: Admin/Owner = everything, Employee = everything except the Admin section.
// Office_POC / Warehouse_POC / Purchase_Head are assignment-qualifier tags, not access roles —
// they only mark who's eligible to be picked for something (a PO's POC, an outbound PO's
// Approved By), independent of the base role.
export const BASE_ROLES = [ROLES.ADMIN, ROLES.OWNER, ROLES.EMPLOYEE];
export const TAG_ROLES = [ROLES.OFFICE_POC, ROLES.WAREHOUSE_POC, ROLES.PURCHASE_HEAD];

export const ALL_ROLES = [...BASE_ROLES, ...TAG_ROLES];
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
    label: 'Inbound',
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
    label: 'Outbound',
    icon: Send,
    children: [
      {
        label: 'Procurement Status',
        path: '/procurement',
        icon: PackageSearch,
        description: 'Materials to order for pending POs',
        roles: ALL_ROLES,
      },
      {
        label: 'Purchase Orders',
        path: '/outbound/purchase-orders',
        icon: ShoppingCart,
        description: 'Purchase orders to outbound vendors',
        roles: ALL_ROLES,
      },
    ],
  },
  {
    label: 'Configurations',
    icon: SlidersHorizontal,
    children: [
      {
        label: 'SKU Products',
        path: '/products',
        icon: Tag,
        description: 'SKUs, raw products & vendor mappings',
        roles: ALL_ROLES,
      },
      {
        label: 'Cities, Vendors & Masters',
        path: '/configurations',
        icon: Store,
        description: 'Cities, vendors, couriers, categories & outbound product list',
        roles: ALL_ROLES,
      },
      {
        label: 'Outbound Vendors',
        path: '/outbound/vendors',
        icon: PackageOpen,
        description: 'Outbound vendor master & article mappings',
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
        label: 'Purchase Config',
        path: '/admin/purchase-config',
        icon: Building2,
        description: 'Company master data & packaging article catalog',
        roles: ADMIN_ONLY,
      },
    ],
  },
];
