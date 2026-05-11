const parsers = {
  Zepto:   require('./zepto'),
  Scootsy: require('./scootsy'),
  Blinkit: require('./blinkit'),
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
