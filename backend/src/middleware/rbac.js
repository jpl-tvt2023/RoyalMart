const allowRoles = (...allowed) => (req, res, next) => {
  const userRoles = req.user?.roles || [];
  if (!userRoles.some(r => allowed.includes(r))) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};

module.exports = { allowRoles };
