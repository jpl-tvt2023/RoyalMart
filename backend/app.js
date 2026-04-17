require('./src/config/env');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth',         require('./src/routes/auth.routes'));
app.use('/api/users',        require('./src/routes/users.routes'));
app.use('/api/teams',        require('./src/routes/teams.routes'));
app.use('/api/skus',         require('./src/routes/skus.routes'));
app.use('/api/inventory',    require('./src/routes/inventory.routes'));
app.use('/api/supplier-pos', require('./src/routes/supplierPO.routes'));
app.use('/api/packaging',    require('./src/routes/packaging.routes'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use(errorHandler);

module.exports = app;
