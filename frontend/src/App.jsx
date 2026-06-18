import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/shared/ProtectedRoute';

import Login from './pages/Login';
import ForcePasswordReset from './pages/ForcePasswordReset';
import Dashboard from './pages/Dashboard';
import UserManagement from './pages/admin/UserManagement';
import TeamManagement from './pages/admin/TeamManagement';
import PurchaseOrdersList from './pages/PurchaseOrders/PurchaseOrdersList';
import PurchaseOrderImport from './pages/PurchaseOrders/PurchaseOrderImport';
import PurchaseOrderDetail from './pages/PurchaseOrders/PurchaseOrderDetail';
import OrderSummaryList from './pages/OrderSummary/OrderSummaryList';
import BuiltyList from './pages/Builty/BuiltyList';
import GRNList from './pages/GRN/GRNList';
import ConfigurationsPage from './pages/Configurations/ConfigurationsPage';
import ProductList from './pages/products/ProductList';
import ProcurementPage from './pages/Procurement/ProcurementPage';
import { ALL_ROLES, ADMIN_ONLY } from './utils/roles';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster
          position="top-center"
          containerStyle={{ top: 70 }}
          toastOptions={{
            duration: 3000,
            style: { fontSize: '14px', maxWidth: '420px' },
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
            <ProtectedRoute roles={ADMIN_ONLY}><UserManagement /></ProtectedRoute>
          } />

          <Route path="/admin/teams" element={
            <ProtectedRoute roles={ADMIN_ONLY}><TeamManagement /></ProtectedRoute>
          } />

          <Route path="/products" element={
            <ProtectedRoute roles={ALL_ROLES}><ProductList /></ProtectedRoute>
          } />

          <Route path="/procurement" element={
            <ProtectedRoute roles={ALL_ROLES}><ProcurementPage /></ProtectedRoute>
          } />

          <Route path="/purchase-orders" element={
            <ProtectedRoute roles={ALL_ROLES}><PurchaseOrdersList /></ProtectedRoute>
          } />
          <Route path="/purchase-orders/new" element={
            <ProtectedRoute roles={ALL_ROLES}><PurchaseOrderImport /></ProtectedRoute>
          } />
          <Route path="/purchase-orders/:poId" element={
            <ProtectedRoute roles={ALL_ROLES}><PurchaseOrderDetail /></ProtectedRoute>
          } />

          <Route path="/order-summary" element={
            <ProtectedRoute roles={ALL_ROLES}><OrderSummaryList /></ProtectedRoute>
          } />

          <Route path="/builty" element={
            <ProtectedRoute roles={ALL_ROLES}><BuiltyList /></ProtectedRoute>
          } />

          <Route path="/grn" element={
            <ProtectedRoute roles={ALL_ROLES}><GRNList /></ProtectedRoute>
          } />

          <Route path="/configurations" element={
            <ProtectedRoute roles={ADMIN_ONLY}><ConfigurationsPage /></ProtectedRoute>
          } />

          {/* Legacy routes redirect to current ones */}
          <Route path="/couriers"         element={<Navigate to="/configurations" replace />} />
          <Route path="/dispatch-summary" element={<Navigate to="/order-summary"  replace />} />
          <Route path="/skus"             element={<Navigate to="/products"       replace />} />

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
