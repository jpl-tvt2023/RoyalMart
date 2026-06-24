require('./src/config/env');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const errorHandler = require('./src/middleware/errorHandler');
const { globalLimiter } = require('./src/middleware/rateLimit');

const app = express();

// Behind Vercel / a reverse proxy: needed for Secure/SameSite=None cookies and
// for rate limiters to see the real client IP rather than the proxy's.
app.set('trust proxy', 1);

// Security headers (nosniff, frameguard, referrer-policy, HSTS, etc.).
// The SPA document's CSP is set on the static host (frontend/vercel.json).
app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(globalLimiter);

app.use('/api/auth',         require('./src/routes/auth.routes'));
app.use('/api/users',        require('./src/routes/users.routes'));
app.use('/api/products',     require('./src/routes/products.routes'));
app.use('/api/raw-products', require('./src/routes/rawProducts.routes'));
app.use('/api/procurement', require('./src/routes/procurement.routes'));
app.use('/api/marketplace-pos', require('./src/routes/marketplacePO.routes'));
app.use('/api/order-summary', require('./src/routes/orderSummary.routes'));
app.use('/api/product-vendor-codes', require('./src/routes/productVendorCodes.routes'));
app.use('/api/couriers',     require('./src/routes/couriers.routes'));
app.use('/api/configurations', require('./src/routes/configurations.routes'));
app.use('/api/audit-logs',   require('./src/routes/audit.routes'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use(errorHandler);

module.exports = app;
