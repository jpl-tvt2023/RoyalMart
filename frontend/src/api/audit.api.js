import api from './axios';

// Fetch the change history for a single record.
// entityType e.g. 'marketplace_po', 'product', 'city'; entityId is the record key.
export async function getEntityHistory(entityType, entityId) {
  const { data } = await api.get('/audit-logs', {
    params: { entity_type: entityType, entity_id: entityId },
  });
  return data;
}
