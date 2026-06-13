module.exports = (err, req, res, next) => {
  // Always keep full detail server-side.
  console.error(err.stack || err);

  const status = err.status || err.statusCode || 500;

  // For server errors (5xx) never leak internal/DB details to the client.
  // Intentional 4xx errors may carry a user-facing message.
  const message = status >= 500
    ? 'Internal server error'
    : (err.message || 'Request failed');

  res.status(status).json({ message });
};
