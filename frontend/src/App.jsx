import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/shared/ProtectedRoute';
import TitleManager from './components/layout/TitleManager';

import Login from './pages/Login';
import ForcePasswordReset from './pages/ForcePasswordReset';
import Dashboard from './pages/Dashboard';
import UserManagement from './pages/admin/UserManagement';
import PurchaseConfig from './pages/admin/PurchaseConfig';
import PurchaseOrdersList from './pages/PurchaseOrders/PurchaseOrdersList';
import PurchaseOrderImport from './pages/PurchaseOrders/PurchaseOrderImport';
import PurchaseOrderDetail from './pages/PurchaseOrders/PurchaseOrderDetail';
import OrderSummaryList from './pages/OrderSummary/OrderSummaryList';
import BuiltyList from './pages/Builty/BuiltyList';
import GRNList from './pages/GRN/GRNList';
import LeadTimeReport from './pages/LeadTime/LeadTimeReport';
import ConfigurationsPage from './pages/Configurations/ConfigurationsPage';
import ProductList from './pages/products/ProductList';
import ProcurementPage from './pages/Procurement/ProcurementPage';
import OutboundVendorsPage from './pages/OutboundVendors/OutboundVendorsPage';
import OutboundPOList from './pages/OutboundPOs/OutboundPOList';
import StitchingPage from './pages/Stitching/StitchingPage';
import OutboundPODetail from './pages/OutboundPOs/OutboundPODetail';
import PackagingList from './pages/packaging/PackagingList';
import { ALL_ROLES, ADMIN_ONLY } from './utils/roles';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <TitleManager />
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

          <Route path="/admin/purchase-config" element={
            <ProtectedRoute roles={ADMIN_ONLY}><PurchaseConfig /></ProtectedRoute>
          } />
          {/* Global Config was folded into Purchase Config — kept so existing links
              and bookmarks land somewhere useful instead of 404ing. */}
          <Route path="/admin/global-config" element={<Navigate to="/admin/purchase-config" replace />} />

          <Route path="/packaging-items" element={
            <ProtectedRoute roles={ALL_ROLES}><PackagingList /></ProtectedRoute>
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

          <Route path="/lead-time-report" element={
            <ProtectedRoute roles={ALL_ROLES}><LeadTimeReport /></ProtectedRoute>
          } />

          <Route path="/configurations" element={
            <ProtectedRoute roles={ALL_ROLES}><ConfigurationsPage /></ProtectedRoute>
          } />

          <Route path="/outbound/purchase-orders" element={
            <ProtectedRoute roles={ALL_ROLES}><OutboundPOList /></ProtectedRoute>
          } />
          <Route path="/outbound/purchase-orders/new" element={
            <ProtectedRoute roles={ALL_ROLES}><OutboundPODetail /></ProtectedRoute>
          } />
          <Route path="/outbound/purchase-orders/:id" element={
            <ProtectedRoute roles={ALL_ROLES}><OutboundPODetail /></ProtectedRoute>
          } />
          <Route path="/outbound/stitching" element={
            <ProtectedRoute roles={ALL_ROLES}><StitchingPage /></ProtectedRoute>
          } />
          <Route path="/outbound/vendors" element={
            <ProtectedRoute roles={ALL_ROLES}><OutboundVendorsPage /></ProtectedRoute>
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
