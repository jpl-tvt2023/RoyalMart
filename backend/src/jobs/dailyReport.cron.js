const cron = require('node-cron');
const { generateDailyReport } = require('../services/report.service');

// Run daily at 11:59 PM
cron.schedule('59 23 * * *', async () => {
  console.log('Running daily report cron...');
  try {
    await generateDailyReport();
  } catch (err) {
    console.error('Daily report cron failed:', err.message);
  }
});

// Expose for manual trigger
module.exports = { runNow: generateDailyReport };
