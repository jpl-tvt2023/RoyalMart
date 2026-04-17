const app = require('./app');
const { PORT, NODE_ENV } = require('./src/config/env');

if (NODE_ENV !== 'test') {
  require('./src/jobs/dailyReport.cron');
}

app.listen(PORT, () => {
  console.log(`Royal Mart ROMS backend running on port ${PORT} [${NODE_ENV}]`);
});
