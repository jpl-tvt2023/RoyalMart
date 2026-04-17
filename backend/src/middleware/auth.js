const jwt = require('jsonwebtoken');
const { JWT_ACCESS_SECRET } = require('../config/env');

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_ACCESS_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};
