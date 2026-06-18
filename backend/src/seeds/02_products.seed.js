// Products / SKUs are no longer seeded — they are created and managed entirely
// from the Products screen in the app. Kept as a no-op so the seed runner and
// its ordering stay intact.
async function seed(/* db */) {
  // intentionally empty
}

module.exports = seed;
