// Canonical role set.
//   Admin / Owner    — full access, including the Admin section.
//   Employee         — full access EXCEPT the Admin section (users, teams, configurations).
//   Office_POC /      — assignment-qualifier roles only (who can be set as a PO's
//   Warehouse_POC /     Office/Warehouse POC, or as an outbound PO's Approved By);
//   Purchase_Head       they do not grant page access on their own.
const ALL_ROLES = ['Admin', 'Owner', 'Employee', 'Office_POC', 'Warehouse_POC', 'Purchase_Head'];
const ADMIN_ROLES = ['Admin', 'Owner'];

const allowRoles = (...allowed) => (req, res, next) => {
  const userRoles = req.user?.roles || [];
  if (!userRoles.some(r => allowed.includes(r))) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};

module.exports = { allowRoles, ALL_ROLES, ADMIN_ROLES };
