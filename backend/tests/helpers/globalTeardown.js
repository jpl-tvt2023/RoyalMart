const path = require('path');
const fs = require('fs');

module.exports = async () => {
  const tmpDir = path.resolve(__dirname, '../.tmp');
  if (fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly; ignore
    }
  }
};
