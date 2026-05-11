// One-shot seed for the cities master, lifted from the previous
// frontend/src/data/indianCities.js hardcoded list. Idempotent via UNIQUE(name).

const CITIES = [
  'Agartala', 'Agra', 'Ahmedabad', 'Ahmednagar', 'Aizawl', 'Ajmer', 'Akola', 'Aligarh',
  'Allahabad', 'Alwar', 'Ambala', 'Amravati', 'Amritsar', 'Anand', 'Anantapur', 'Ankleshwar',
  'Asansol', 'Aurangabad', 'Bangalore', 'Bareilly', 'Belgaum', 'Bellary', 'Bhagalpur',
  'Bharuch', 'Bhavnagar', 'Bhilai', 'Bhilwara', 'Bhiwandi', 'Bhopal', 'Bhubaneswar', 'Bhuj',
  'Bikaner', 'Bilaspur', 'Bokaro', 'Chandigarh', 'Chennai', 'Coimbatore', 'Cuttack',
  'Dehradun', 'Delhi', 'Dhanbad', 'Dharamshala', 'Dharwad', 'Dibrugarh', 'Dimapur', 'Durgapur',
  'Erode', 'Faridabad', 'Firozabad', 'Gandhinagar', 'Gangtok', 'Gaya', 'Ghaziabad', 'Goa',
  'Gorakhpur', 'Greater Noida', 'Gulbarga', 'Guntur', 'Gurgaon', 'Guwahati', 'Gwalior',
  'Haldwani', 'Hamirpur', 'Haridwar', 'Hisar', 'Howrah', 'Hubli', 'Hyderabad',
  'Imphal', 'Indore', 'Itanagar', 'Jabalpur', 'Jaipur', 'Jaisalmer', 'Jalandhar', 'Jalgaon',
  'Jammu', 'Jamnagar', 'Jamshedpur', 'Jhansi', 'Jodhpur', 'Jorhat', 'Junagadh',
  'Kakinada', 'Kalyan-Dombivli', 'Kanpur', 'Karnal', 'Kochi', 'Kohima', 'Kolhapur', 'Kolkata',
  'Kollam', 'Korba', 'Kota', 'Kottayam', 'Kozhikode', 'Kurnool', 'Lucknow', 'Ludhiana',
  'Madurai', 'Mangalore', 'Mathura', 'Meerut', 'Mehsana', 'Moradabad', 'Mumbai', 'Muzaffarnagar',
  'Muzaffarpur', 'Mysore', 'Nagpur', 'Nanded', 'Nashik', 'Nellore', 'Noida',
  'Panaji', 'Panipat', 'Patiala', 'Patna', 'Pimpri-Chinchwad', 'Pondicherry', 'Porbandar',
  'Port Blair', 'Prayagraj', 'Pune', 'Puri', 'Raipur', 'Rajahmundry', 'Rajkot', 'Ranchi',
  'Ratlam', 'Rewari', 'Rohtak', 'Roorkee', 'Rourkela', 'Saharanpur', 'Salem', 'Sangli',
  'Shillong', 'Shimla', 'Siliguri', 'Silvassa', 'Solapur', 'Sonipat', 'Srinagar', 'Surat',
  'Thane', 'Thiruvananthapuram', 'Thoothukudi', 'Thrissur', 'Tiruchirappalli', 'Tirunelveli',
  'Tirupati', 'Tirupur', 'Udaipur', 'Ujjain', 'Vadodara', 'Varanasi', 'Vasai-Virar',
  'Vellore', 'Vijayawada', 'Visakhapatnam', 'Warangal',
];

async function seed(db) {
  let inserted = 0;
  for (const name of CITIES) {
    const { rows } = await db.execute({
      sql: `INSERT INTO cities (name) VALUES (?)
            ON CONFLICT (name) DO NOTHING
            RETURNING id`,
      args: [name],
    });
    if (rows.length) inserted++;
  }
  console.log(`  seeded cities: +${inserted} (skipped ${CITIES.length - inserted} existing)`);
}

module.exports = seed;
