const parsers = {
  Zepto:   require('./zepto'),
  Scootsy: require('./scootsy'),
  Blinkit: require('./blinkit'),
  Now:     require('./now'),      // Amazon Now (PDF)
  Minutes: require('./minutes'),  // Flipkart Minutes (binary .xls)
  Amazon:   require('./amazon'),   // Amazon FBA (xlsx)
  Flipkart: require('./flipkart'), // Flipkart Stock Transfer (PDF)
};

function hasParser(vendor) {
  return Object.prototype.hasOwnProperty.call(parsers, vendor);
}

async function parse(vendor, buffer) {
  const fn = parsers[vendor];
  if (!fn) throw new Error(`Unsupported vendor: ${vendor}`);
  return fn(buffer);
}

module.exports = { parse, hasParser };
