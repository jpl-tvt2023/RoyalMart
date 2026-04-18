import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/shared/ProtectedRoute';

import Login from './pages/Login';
import ForcePasswordReset from './pages/ForcePasswordReset';
import Dashboard from './pages/Dashboard';
import UserManagement from './pages/admin/UserManagement';
import TeamManagement from './pages/admin/TeamManagement';
import SKUMaster from './pages/skus/SKUMaster';
import InventoryDashboard from './pages/inventory/InventoryDashboard';
import SupplierPOs from './pages/restock/SupplierPOs';
import PackagingInventory from './pages/packaging/PackagingInventory';
import PurchaseOrdersList from './pages/PurchaseOrders/PurchaseOrdersList';
import PurchaseOrderImport from './pages/PurchaseOrders/PurchaseOrderImport';
import PurchaseOrderDetail from './pages/PurchaseOrders/PurchaseOrderDetail';

const ALL_ROLES = ['Admin', 'Owner', 'Office_POC', 'Purchase_Team', 'Stocks_Team', 'PO_Executive'];
const PO_ROLES = ['Admin', 'Owner', 'PO_Executive'];

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: { fontSize: '14px', maxWidth: '360px' },
            success: { iconTheme: { primary: '#003049', secondary: '#fff' } },
            error: { iconTheme: { primary: '#c1121f', secondary: '#fff' } },
          }}
        />
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route path="/force-reset" element={
            <ProtectedRoute><ForcePasswordReset /></ProtectedRoute>
          } />

          <Route path="/dashboard" element={
            <ProtectedRoute roles={ALL_ROLES}><Dashboard /></ProtectedRoute>
          } />

          <Route path="/admin/users" element={
            <ProtectedRoute roles={['Admin']}><UserManagement /></ProtectedRoute>
          } />

          <Route path="/admin/teams" element={
            <ProtectedRoute roles={['Admin', 'Owner']}><TeamManagement /></ProtectedRoute>
          } />

          <Route path="/skus" element={
            <ProtectedRoute roles={['Admin', 'Owner']}><SKUMaster /></ProtectedRoute>
          } />

          <Route path="/inventory" element={
            <ProtectedRoute roles={ALL_ROLES}><InventoryDashboard /></ProtectedRoute>
          } />

          <Route path="/restock" element={
            <ProtectedRoute roles={['Admin', 'Owner', 'Purchase_Team', 'Stocks_Team']}><SupplierPOs /></ProtectedRoute>
          } />

          <Route path="/packaging" element={
            <ProtectedRoute roles={['Admin', 'Owner', 'Stocks_Team']}><PackagingInventory /></ProtectedRoute>
          } />

          <Route path="/purchase-orders" element={
            <ProtectedRoute roles={PO_ROLES}><PurchaseOrdersList /></ProtectedRoute>
          } />
          <Route path="/purchase-orders/new" element={
            <ProtectedRoute roles={PO_ROLES}><PurchaseOrderImport /></ProtectedRoute>
          } />
          <Route path="/purchase-orders/:poId" element={
            <ProtectedRoute roles={PO_ROLES}><PurchaseOrderDetail /></ProtectedRoute>
          } />

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
