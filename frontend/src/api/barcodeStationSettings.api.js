import api from './axios';

// Barcode Station settings (098) -- Admin -> Purchase Config -> Barcode Station.
// The PIN is write-only: the GET says whether one is set, never what it is.

export async function getBarcodeStationSettings() {
  const { data } = await api.get('/configurations/barcode-station');
  return data;
}

// { pin?, label_width_mm?, label_height_mm?, sign_out_all?, clear_lock? }
export async function updateBarcodeStationSettings(payload) {
  const { data } = await api.put('/configurations/barcode-station', payload);
  return data;
}
