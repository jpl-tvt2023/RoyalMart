const parsers = {
  Zepto:   require('./zepto'),
  Swiggy:  require('./swiggy'),
  Blinkit: require('./blinkit'),
};

async function parse(vendor, buffer) {
  const fn = parsers[vendor];
  if (!fn) throw new Error(`Unsupported vendor: ${vendor}`);
  return fn(buffer);
}

module.exports = { parse };
