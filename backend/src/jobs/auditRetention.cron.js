const cron = require('node-cron');
const { purgeUserHistory } = require('../services/auditLog.service');

// Purge user account history older than the retention window, daily at 3:15 AM.
// On the serverless deployment this cron does not run; logAction() also purges
// opportunistically so retention is enforced there too.
cron.schedule('15 3 * * *', async () => {
  try {
    const removed = await purgeUserHistory();
    if (removed) console.log(`Audit retention: purged ${removed} old user history row(s)`);
  } catch (err) {
    console.error('Audit retention cron failed:', err.message);
  }
});

// Expose for manual trigger.
module.exports = { runNow: purgeUserHistory };
